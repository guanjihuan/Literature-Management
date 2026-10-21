// 通用原子化文件抽象
// 适用场景:
//   - 单一文件 + 并发写
//   - 内存镜像(读零 IO)
//   - 启动时从磁盘加载,运行时由 update()/write() 持久化
//
// 特性:
//   - 原子写:open(tmp, 'wx') → writeFile → fsync → rename(tmp → dest)
//     断电时不会让 dest 变成半截文件,也不会留下孤儿 .tmp
//     'wx' 防止预置 symlink 把数据写出 dataPath 外。
//   - 并发队列:所有 update()/write() 串行化,避免丢失更新
//   - 损坏恢复:start() 时 **parse** 抛错 → quarantine 坏文件(保留内容)
//     + 走 defaultValue 兜底。**读失败不等于文件损坏** —— 读不到时
//     原文件原封不动留在盘上,只锁写并抛错(audit r199)
//
// 不适用场景:
//   - 多文件协调(如 trash.record 要 rename + 写 index.md) → 由调用方串行调
//   - 大文件流式写 → 走 fs.createWriteStream,而不是这个抽象
//   - chokidar 监听的目录 → 用 watcher + reload 模式
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { dirname } from 'path';
import { createLogger } from './logger';
// RKMS_TMP_MARKER 与 safe-write 共用同一份 —— 两条写路径 + 残留清扫器
// 必须对「什么算本应用的 tmp」有同一个定义,否则清扫器会扫不到自己写的,
// 或(更糟)扫到别人的。见 safe-write.ts 的 ATOMIC_TMP_PATTERN 头注。
import { UnsafeWriteError, safeCloseFh, RKMS_TMP_MARKER } from './safe-write';
import { errMsg, errnoCode, AppError } from './error';
import { retryOnWindowsTransient } from './retry-transient';
import { needsDirFsyncForRename } from './platform';

interface AtomicFileOptions<T> {
  /** 绝对路径(已校验在 dataPath 内) */
  filePath: string;
  /** 文件不存在/解析失败时的兜底值 */
  defaultValue: T;
  /** T → 字符串 */
  serialize: (value: T) => string;
  /** 字符串 → T;抛错会被 start() 兜底为 defaultValue */
  parse: (raw: string) => T;
  /** 写完成后触发(用于上层 emit 'changed') */
  onChange?: (value: T) => void;
  /** 日志 scope */
  logScope?: string;
}

export class AtomicFile<T> extends EventEmitter {
  private current: T;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private filePath: string;
  private defaultValue: T;
  private serialize: (value: T) => string;
  private parse: (raw: string) => T;
  private onChangeCb?: (value: T) => void;
  private scope: string;
  private loaded = false;
  /**
   * 写锁:一旦置位,此后所有 persist 一律拒绝 —— 宁可功能暂不可用,
   * 也不静默覆盖用户数据。
   *
   * 两个来源(audit r199 统一成一条闸):
   *   1. 坏文件没能被 quarantine 出去(rename + copy 都失败)—— 磁盘上
   *      仍是一份「内容坏了但必须留着」的文件,不能被空态覆盖;
   *   2. **读失败**(EACCES/EPERM/EBUSY/EIO/EISDIR)—— 这一刻读不到,
   *      但文件内容可能完好(权限 / 被占用 / 路径指向目录)。旧实现
   *      把它当「文件损坏」处理,quarantine 会把用户数据改名走 ——
   *      那不是保护,是二次伤害(详见 start() 注释)。
   */
  private writeBlockedReason?: string;

  constructor(opts: AtomicFileOptions<T>) {
    super();
    this.filePath = opts.filePath;
    this.defaultValue = opts.defaultValue;
    this.serialize = opts.serialize;
    this.parse = opts.parse;
    this.onChangeCb = opts.onChange;
    this.scope = opts.logScope || 'atomic-file';
    this.current = opts.defaultValue;
  }

  /**
   * 启动时调用一次:从磁盘加载到内存。
   *   - 文件不存在(ENOENT) → 写一份 defaultValue,内存态 = defaultValue;
   *   - **读失败**(EACCES/EPERM/EBUSY/EIO/EISDIR)→ 抛错 + 锁写,
   *     文件**原封不动**留在盘上(不 quarantine、不写默认值);
   *   - **解析失败** → quarantine 坏文件 + 走 defaultValue。
   *
   * audit r28 (2026-09-21):quarantine 坏文件 —— 旧实现仅 warn 一行就
   *   用 defaultValue 接管,坏文件留盘上原位。favorites 这类「用户亲手
   *   维护」的文件(OneDrive 同步中断 / 手动 edit 破坏 frontmatter)如果
   *   直接被 defaultValue 覆盖,用户连抢救的机会都没有 —— 第一次 toggle
   *   就把 corrupt file 用空 in-memory state 持久化,原 200 条收藏永久
   *   丢失。修法:parse 失败 → rename 到 `<file>.corrupt-<timestamp>`,
   *   再用 defaultValue 接管。rename 失败不阻断启动(目标已不可读,
   *   至少保住内存态),但 warn 升级到 error 让 log 监控可见。
   *
   * audit r199 (2026-10-20):读失败与解析失败**分开处置** —— 旧实现
   *   两者共用一个 catch,一次瞬时读失败就把用户的 favorites.md 改名走
   *   并回落空态。详见下面阶段 1 / 阶段 2 的注释。
   */
  async start(): Promise<void> {
    const localLog = createLogger(this.scope);
    //
    // audit r199 (2026-10-20):**读失败 ≠ 文件损坏** —— 把「读」和「解析」
    // 拆成两个阶段,各自独立处置。
    //
    // 旧实现只有一个 try,把 fs.readFile 和 this.parse 一起裹住:
    //   catch → 非 ENOENT / 非 UnsafeWriteError ⇒ 一律当成「文件坏了」
    //   → rename 成 `<file>.corrupt-<ts>` → 内存态回落 defaultValue。
    // 于是**任何读错误**(EACCES 权限 / EPERM / EBUSY 被占用 / EIO / EISDIR
    // 路径其实是目录)都会:
    //   1. 把用户的 favorites.md 改名走(文件内容可能完好无损!);
    //   2. 内存态变成**空收藏列表**,而启动路径不抛错 ⇒ 界面上 ★ 全部消失,
    //      用户看不到任何错误提示;
    //   3. 用户下一次点 ★ → persist 把「空列表 + 1 条」写成一个**全新**的
    //      favorites.md —— 原来的 200 条只剩 .corrupt-* 那一份。
    // 换句话说:一次瞬时读失败 = 收藏全丢。这跟本抽象自己写的原则
    // 「宁可让这个功能暂时不可用,也不能静默销毁用户数据」是反的。
    //
    // 新契约:
    //   读阶段 —— ENOENT → 写 defaultValue(首次运行);UnsafeWriteError →
    //     抛(路径校验失败由调用方处理);**其它读错误 → 抛 + 锁写,
    //     既不 rename 也不写默认值**(文件原封不动留在盘上)。
    //   解析阶段 —— parse 抛错才说明「内容坏了」→ 走 r28 的 quarantine
    //     链(rename → copy 退化 → 拒绝写),语义与 r196 的 favorites
    //     「entries 形态非法 → 抛错 → quarantine」完全不变。
    let raw: string;
    try {
      // 读也走 transient 退避:Windows 上 AV / OneDrive 短暂持句柄会让
      // readFile 报 EPERM/EBUSY,那是「重试一下就好」,不该被当成损坏。
      raw = await retryOnWindowsTransient(
        () => fs.readFile(this.filePath, 'utf8'),
        () => Promise.resolve(), // 读失败没有 tmp 残留要清
      );
    } catch (err: unknown) {
      if (errnoCode(err) === 'ENOENT') {
        localLog.info('No existing file, using default', this.filePath);
        // 启动时若文件不存在,主动写一份 defaultValue,让目录里立刻能看到
        await this.write(this.defaultValue);
        this.loaded = true;
        return;
      }
      if (err instanceof UnsafeWriteError) {
        // 路径校验失败:这种错误不能静默吞掉 — 由调用方处理
        throw err;
      }
      // 读失败 —— 处置:① 不 quarantine(改名走是破坏,不是保护);
      // ② 不写 defaultValue(那会把用户数据覆盖成空态);
      // ③ 锁死后续写入(★ toggle 不能把读不到的文件盖掉);
      // ④ 抛给调用方 —— favorites service 启动期抛错会被 index.ts 弹错误框,
      //    用户至少知道「收藏读不出来」,而不是「收藏凭空没了」。
      this.writeBlockedReason =
        `the file could not be read (${errMsg(err)}) and was left untouched on disk. ` +
        `Fix its permissions / close whatever is holding it, then restart.`;
      localLog.error(
        'Read failed — file left untouched (NOT treated as corruption), further writes blocked',
        this.filePath,
        '| err:',
        errMsg(err),
      );
      throw err;
    }
    // ---- 阶段 2:解析(只有这里失败才说明「内容坏了」)----
    try {
      this.current = this.parse(raw);
      localLog.info('Loaded', this.filePath);
    } catch (err: unknown) {
      // audit r28:parse 失败 quarantine 坏文件 ——
      //   先尝试 rename,再走 defaultValue。
      //
      // audit 2026-10-04:quarantine 失败时**不能就这么算了**。
      // 原实现在 rename 失败时只 log.error 然后继续:坏文件留在 filePath
      // 原位,内存已切到 defaultValue。用户下次点任何一颗星标 → update() →
      // persist() → 原子写直接覆盖坏文件 —— **用户最后的抢救机会归零**。
      // 注释 69-76 声称的修法「rename 到 quarantine 再用 defaultValue」,
      // 在 rename 失败时正好退化回它本要修掉的旧行为。
      //
      // 三层兜底,每一层都比上一层弱,任何一层成功就停:
      //   1. rename + transient 退避重试 —— rename 失败绝大多数是 Windows 上
      //      AV / OneDrive 短暂持句柄(EBUSY/EPERM),项目里已有现成的
      //      retryOnWindowsTransient(atomic-file 自己就在用它做写入)。
      //   2. 退化成 copy —— copy 只需要读权限 + 写一个新文件,不需要对
      //      原文件做 rename。锁住原文件不影响 copy,能保住内容。
      //   3. 连 copy 都不行 → 置写锁,**拒绝**后续 persist
      //      覆盖原文件,抛可读错误。宁可让这个功能暂时不可用,
      //      也不能静默销毁用户数据(本抽象的唯一生产实例是用户的收藏夹)。
      const quarantinePath = `${this.filePath}.corrupt-${Date.now()}`;
      let quarantined = false;
      let lastErr: unknown = err;
      try {
        await retryOnWindowsTransient(
          () => fs.rename(this.filePath, quarantinePath),
          () => Promise.resolve(), // 绝不能删源 —— 那是唯一的用户数据
        );
        quarantined = true;
      } catch (renameErr: unknown) {
        lastErr = renameErr;
        // 第 2 层:退化成 copy(内容已解析失败但字节还在,必须留住)
        try {
          await fs.copyFile(this.filePath, quarantinePath);
          quarantined = true;
        } catch (copyErr: unknown) {
          this.writeBlockedReason =
            `the existing file failed to parse and could not be quarantined ` +
            `(${errMsg(lastErr)} / ${errMsg(copyErr)}). ` +
            `Move or delete that file manually, then restart.`;
          localLog.error(
            'Parse failed; quarantine rename AND copy both failed — ' +
              'further writes to this file are blocked to avoid destroying the corrupt data',
            this.filePath,
            '| parse error:',
            errMsg(err),
            '| rename error:',
            errMsg(renameErr),
            '| copy error:',
            errMsg(copyErr),
          );
        }
      }
      if (quarantined) {
        localLog.error(
          'Parse failed, quarantined corrupt file before using default',
          this.filePath,
          '→',
          quarantinePath,
          errMsg(err),
        );
      }
      // quarantined === false ⇒ rename 与 copy 都失败 ⇒ 写锁已在上面置位。
    }
    this.loaded = true;
  }

  /** 同步读内存值(零 IO) */
  get(): T {
    return this.current;
  }

  /** 文件是否已加载(防止外部在 start() 之前读) */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * 用函数变换当前值后原子写入。
   * 串行化:所有 update() 并发调用都会被此机制排成 FIFO。
   */
  async update(fn: (curr: T) => T | Promise<T>): Promise<T> {
    const prev = this.writeQueue;
    let release: () => void = () => {};
    this.writeQueue = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      const next = await fn(this.current);
      return await this.persist(next);
    } finally {
      release();
    }
  }

  /** 直接覆盖整个值 */
  async write(value: T): Promise<T> {
    const prev = this.writeQueue;
    let release: () => void = () => {};
    this.writeQueue = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await this.persist(value);
    } finally {
      release();
    }
  }

  /** 停止前调用:等待所有 in-flight 写完成 */
  async stop(): Promise<void> {
    await this.writeQueue;
  }

  /**
   * 内部:把值原子写到磁盘。已假定 writeQueue 已获取。
   *   1. 确保父目录存在
   *   2. 写到 .tmp + fsync
   *   3. rename(.tmp → dest) — POSIX 原子,Windows 上 fs.rename 是 replace 语义
   *   4. 更新内存 + 触发 onChange
   *
   * audit round 18 (2026-08-27):tmp 加 8 字符 base64url 随机后缀(防并发
   * 同 target 互相 truncate)+ 'wx' 模式(防 symlink write-through)。
   */
  private async persist(value: T): Promise<T> {
    const localLog = createLogger(this.scope);
    // audit 2026-10-04:quarantine 全失败时的最后一道闸 —— 拒绝写,
    // 而不是把仍存在于磁盘的坏文件覆盖掉。错误信息要能让用户知道
    // 「去把那个文件改名/删掉,应用就能继续写」。
    // audit r199:同一道闸也拦住「读失败」(文件还在、但读不到)—— 那种情况
    // 下写默认值 = 把用户数据覆盖成空态,正是本抽象最该避免的事。
    if (this.writeBlockedReason) {
      throw new AppError('IO_ERROR', `Refusing to overwrite ${this.filePath}: ${this.writeBlockedReason}`);
    }
    const payload = this.serialize(value);
    const target = this.filePath;
    await fs.mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${RKMS_TMP_MARKER}${randomBytes(6).toString('base64url')}.tmp`;
    let fh;
    try {
      fh = await fs.open(tmp, 'wx');
      await fh.writeFile(payload, 'utf8');
      await fh.sync();
      await fh.close();
      fh = null;
    } catch (err) {
      // audit 2026-09-14:close 改 warn —— localLog 已存在(同方法 line 150 声明),
      //   Windows stale handle 让 close EBUSY 时不再 swallow。
      // audit round 8 (2026-09-14):走 safeCloseFh helper,统一 close 失败日志形态。
      // `let fh` 推断为 FileHandle | undefined,safeCloseFh 签名收窄为 | null,
      // ?? null 强制窄化,避免调用点类型噪音。
      await safeCloseFh(fh ?? null, 'fh.close failed during atomic-write error path', localLog, {
        tmp,
      });
      // audit 2026-08-25:unlink 只吞 ENOENT —— 其他错误(权限 / Windows 锁文件)
      // 之前 swallow 会留下孤儿 .tmp,占盘且下次启动 load 时干扰 .tmp-rescue 逻辑。
      await fs.unlink(tmp).catch((err: unknown) => {
        if (errnoCode(err) !== 'ENOENT') {
          localLog.warn('Failed to clean tmp on write error', { tmp, err: errMsg(err) });
        }
      });
      throw err;
    }
    // Windows 在快速 back-to-back rename 时偶发 EPERM/EBUSY(AV 扫描/文件
    // watcher 短时持 handle 导致 MoveFileEx 失败)。重试 5 次,指数退避。
    // 这是 Windows 文件系统的已知 quirk,POSIX 上不会触发。
    //
    // audit C3R66 (2026-08-22):抽到 utils/retry-transient.ts,safe-write.ts 共享。
    await retryOnWindowsTransient(
      () => fs.rename(tmp, target),
      () => fs.unlink(tmp),
    );
    // audit 2026-10-04:rename 后 fsync 父目录。atomic(不会留半截文件)与
    //   durability(rename 本身已提交)是两件事;只 fsync tmp 的数据块不够。
    //   与 safe-write.ts 的 atomicWriteFileInternal 同款,共用 platform.ts
    //   的 needsDirFsyncForRename 判定(Windows 上跳过 —— 那里没有这个契约)。
    if (needsDirFsyncForRename) {
      let dirFh: Awaited<ReturnType<typeof fs.open>> | null = null;
      try {
        dirFh = await fs.open(dirname(target), 'r');
        await dirFh.sync();
      } catch (dirErr: unknown) {
        // 某些文件系统不支持目录 fsync(部分 macOS 卷 / 网络盘)—— 只 warn,
        // 不让一次已成功的保存整体失败。
        localLog.warn('fsync parent dir failed (rename durability not guaranteed)', {
          dir: dirname(target),
          err: errMsg(dirErr),
        });
      } finally {
        await safeCloseFh(dirFh, 'fsync parent dir close failed', localLog, {
          path: dirname(target),
        });
      }
    }
    this.current = value;
    if (this.onChangeCb) {
      try {
        this.onChangeCb(value);
      } catch (err) {
        localLog.warn('onChange callback threw', errMsg(err));
      }
    }
    // audit C3R5 (2026-08-22):emit('changed') 必须每个 listener 单独 try/catch。
    // 原实现只用一层 try/catch 包整个 emit —— EventEmitter 在内部对 listeners
    // 同步迭代,第一个抛错的 listener 让 emit() 整体 reject,后续 listener 不会跑。
    // 这与设计意图("listener 抛错只影响那一个 listener")不符。
    // listener A throw → B,C,D 全不跑(应该只 A 不跑,B,C,D 继续)。
    // 修复:手动迭代 listeners('changed'),每个单独包 try/catch。
    const listeners = this.listeners('changed');
    for (const l of listeners) {
      try {
        (l as (v: T) => void)(value);
      } catch (err: unknown) {
        localLog.error('changed listener threw (caught, persisting finished)', errMsg(err));
      }
    }
    return value;
  }
}
