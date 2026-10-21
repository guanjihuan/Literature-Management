// Search IPC:searchResources 单 resources_fts(wire 形状不变,kind literature→'file'
// 未来统一改 ResourceHit)。query 走 requireString 合并"非字符串"和"超长"
// 进 VALIDATION。
import { IPC, SearchHit } from '../../shared/types';
import { searchResources } from '../db/resources-repo';
import { parseResourceId, INVALID_RESOURCE_ID } from '@shared/resource-id';
import { handle, requireString } from './wrap';
import { MAX_SEARCH_QUERY_CHARS } from './path-limits';
import { LibraryError, errnoCode } from '../utils/error';
import { tr } from '../i18n';

export function registerSearchIPC() {
  handle<[string], SearchHit[]>(IPC.SEARCH_QUERY, async (_, query) => {
    const q = requireString(IPC.SEARCH_QUERY, query, 'query', { maxLen: MAX_SEARCH_QUERY_CHARS });
    if (!q.trim()) return [];
    // searchResources 是同步,但 IPC handler 是 async;await 不影响 sync 返回,
    // 但让 caller 拿到真值(避免 promise.map 链式错)
    const hits = await searchResources(q, { limit: 50 });
    return hits.map((h) => {
      // audit-r160:parseResourceId 失败(DB 脏 id / 0005 迁移残留 / 手改 .md
      //   引入非法 prefix)不再裸抛 —— shared 层禁 import main/utils/error,
      //   原实现抛 Error+`code:'INVALID_RESOURCE_ID'` tag 后被 wrap.ts 兜底
      //   包成 INTERNAL,renderer 看到通用「内部错误」,实际是数据完整性问题。
      //   在主进程识别 tag 后重包装成 LibraryError(VALIDATION),走 wrap.ts
      //   已知的 AppError 通道,renderer 拿到的就是准确的 VALIDATION。
      let parsed;
      try {
        parsed = parseResourceId(h.resource.id);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          errnoCode(err) === INVALID_RESOURCE_ID
        ) {
          throw new LibraryError(
            'VALIDATION',
            tr('search.badResourceId', { id: h.resource.id }),
          );
        }
        throw err;
      }
      const { kind, raw } = parsed;
      return {
        // id 是裸 id(note uuid / lit relPath),ResourceId 前缀不进 wire
        kind: kind === 'note' ? ('note' as const) : ('file' as const),
        id: raw,
        relPath: h.resource.kind === 'note' ? h.resource.relPath : h.resource.absPath,
        title: h.resource.title,
        snippet: h.snippet,
        score: h.score,
      };
    });
  });
}
