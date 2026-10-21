#!/usr/bin/env node
// scripts/commit-msg-preprocess.cjs
//
// 把 commit message 转成 commitlint 能验证的 conventional 格式,绝不卡用户:
//
//   [audit] phase 2 — ...
//   → audit: phase 2 — ...        (项目主流 [prefix] 风格;prefix 强制小写)
//
//   feat add new button
//   → feat: add new button         (bare 首词命中 type-enum → 用作 type)
//
//   feat:word                       (常见 typo —— 冒号后忘空格)
//   → feat: word                    (顺带补空格)
//
//   update xxx
//   → chore: update xxx             (bare 首词不在 enum → 默认 chore)
//
//   update                          (单字 bare)
//   → chore: update                  (默认 chore)
//
//   feat: existing conventional
//   → feat: existing conventional  (已 conventional 不动)
//
// 只动第一行(header),body/footer 不动。type-enum 从 commitlint.config.cjs
// 同步读取 —— audit round 8 (2026-09-14) commitlint.config 现在顶层导出
// .types 数组作为单一真相,这里优先读 config.types,失败再退到
// config.rules['type-enum'][2](老格式),再不行才用本文件末尾 FALLBACK_TYPES。
//
// 调用方式(在 .husky/commit-msg 里):node scripts/commit-msg-preprocess.cjs "$1"
const fs = require('node:fs');
const path = require('node:path');

// FALLBACK_TYPES 现在是真正的兜底(双 require 失败 / config 损坏),
// 不再与 commitlint.config 双源同步。commitlint.config 是唯一真相,
// 这里 hardcode 是为了让 loadTypeEnum 在异常路径上仍能给一个非空集合。
const FALLBACK_TYPES = new Set([
  'workbench', 'cleanup', 'ui', 'docs', 'spec', 'plan', 'test', 'audit',
  'feat', 'fix', 'refactor', 'perf', 'style', 'build', 'ci', 'chore', 'revert',
]);

function loadTypeEnum() {
  try {
    const configPath = path.resolve(__dirname, '..', 'commitlint.config.cjs');
    delete require.cache[require.resolve(configPath)];
    const config = require(configPath);
    // audit round 8 (2026-09-14):优先读 config.types —— 单一真相。
    //   旧实现走 config.rules['type-enum'][2] 拿数组,需要先校验结构。
    //   现在 commitlint.config.cjs 顶层直接导出 types 数组,这里 require
    //   拿到即可,避免双重结构解码。失败时仍可走 type-enum 数组兜底
    //   (兼容老 commitlint.config 没升级 .types 字段的过渡期),再不行
    //   才退回 FALLBACK_TYPES。
    if (Array.isArray(config && config.types)) {
      return new Set(config.types);
    }
    const enumRule = config && config.rules && config.rules['type-enum'];
    if (Array.isArray(enumRule) && Array.isArray(enumRule[2])) {
      return new Set(enumRule[2]);
    }
  } catch (_) {
    /* fall through to fallback */
  }
  return FALLBACK_TYPES;
}

const CONVENTIONAL_HEADER = /^\w+(?:\([^)]+\))?!?:\s.+$/;
const BRACKET_HEADER = /^\[(\w+)\]\s+(.+)$/;

function preprocess(message, typeSet) {
  const set = typeSet || loadTypeEnum();
  const newline = message.includes('\r\n') ? '\r\n' : '\n';
  const lines = message.split(/\r?\n/);
  const header = lines[0] || '';

  // 空 header —— 让 commitlint 自然报错,不要硬塞一个虚假 chore:
  if (!header.trim()) {
    return message;
  }

  // [prefix] subject → prefix: subject (prefix 强制小写,匹配 type-case 规则;
  // 未注册的 prefix 直接落到 bare fallback,避免 "[WIP] stuff" 这种被静默转成
  // "wip: stuff" 然后 commitlint 用 "type not in enum" 二次卡住用户)
  const bracketMatch = header.match(BRACKET_HEADER);
  if (bracketMatch) {
    const [, type, subject] = bracketMatch;
    const lower = type.toLowerCase();
    if (set.has(lower)) {
      lines[0] = `${lower}: ${subject}`;
      return lines.join(newline);
    }
  }

  // 已 conventional → 原样不动(commitlint 自家规则会校验)
  if (CONVENTIONAL_HEADER.test(header)) {
    return message;
  }

  // bare:首词是已知 type(忽略大小写)且后面有内容 → "<type>: <rest>"
  // 同时吞掉紧跟首词的 ":"(常见 typo "feat:word"),保证输出干净
  const firstWord = header.match(/^(\w+)\b/);
  if (firstWord) {
    const typeCandidate = firstWord[1].toLowerCase();
    if (set.has(typeCandidate)) {
      const rest = header
        .slice(firstWord[0].length)
        .replace(/^:\s*/, '')
        .trimStart();
      if (rest.length > 0) {
        lines[0] = `${typeCandidate}: ${rest}`;
        return lines.join(newline);
      }
    }
  }

  // bare fallback → "chore: <header>" —— 兜底,确保 commit 永远成功
  lines[0] = `chore: ${header}`;
  return lines.join(newline);
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error(
      '[commit-msg-preprocess] usage: commit-msg-preprocess.cjs <commit-msg-file>',
    );
    process.exit(2);
  }
  const original = fs.readFileSync(file, 'utf8');
  const rewritten = preprocess(original);
  if (rewritten !== original) {
    // audit round 8 (2026-09-14):写 tmp + rename 替直接 writeFileSync ——
    //   旧实现写中断(磁盘满 / OS kill / power loss)会让 commit-msg 文件
    //   半空,git 直接 reject "no commit message",用户措手不及。改成
    //   tmp 写 + renameSync:POSIX rename 原子,Windows 上 NTFS MoveFileEx
    //   同 target volume 时也是原子的;失败时 tmp 文件残留但原文件完好。
    //   tmp 用 file + '.tmp' 与 git 临时文件命名约定一致,git 重启可识别。
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, rewritten, 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch (_) {
        /* tmp 清理失败不阻塞 — 用户重试一次 commit 就会覆盖 */
      }
      console.error(`[commit-msg-preprocess] rename tmp -> file failed: ${e.message}`);
      process.exit(1);
    }
    // 静默不输出 —— git commit 行为不要污染 stdout,提交消息自身就是反馈
  }
  process.exit(0);
}

module.exports = {
  preprocess,
  loadTypeEnum,
  CONVENTIONAL_HEADER,
  BRACKET_HEADER,
  FALLBACK_TYPES,
};
