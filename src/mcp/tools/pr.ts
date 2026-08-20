import { resolve } from 'node:path';
import { LocalPrEngine, PrError } from '../../local-pr/engine.js';
import type { Actor, PullRequest } from '../../local-pr/types.js';
import { log } from '../../core/log.js';
import type { PrInput } from '../schemas.js';

/**
 * `ges_pr` 핸들러.
 *
 * 로직은 전부 LocalPrEngine에 있다. 여기는 action을 메서드 호출로 옮긴다.
 * 그리고 PrError를 MCP 응답 형태(`{ error, kind }`)로 접는 껍데기다. exitCode는
 * 프로세스 종료 코드로 갈래를 타는 CLI 전용이라 MCP에선 kind 문자열로 바꾼다.
 */

function actorOf(input: PrInput): Actor {
  return input.author ?? process.env['GESTALT_ACTOR'] ?? 'human:local';
}

function requireId(input: PrInput): string {
  if (!input.id) throw new PrError('id가 필요하다', 1);
  return input.id;
}

function dispatch(
  engine: LocalPrEngine,
  input: PrInput,
): PullRequest | PullRequest[] | { diff: string } {
  switch (input.action) {
    case 'create': {
      if (!input.title) throw new PrError('title이 필요하다', 1);
      return engine.create({
        title: input.title,
        body: input.body,
        author: actorOf(input),
        base: input.base,
        head: input.head,
      });
    }
    case 'list':
      return engine.list(input.status);
    case 'get': {
      const pr = engine.get(requireId(input));
      if (!pr) throw new PrError(`PR을 못 찾았다: ${input.id}`, 3);
      return pr;
    }
    case 'diff':
      return { diff: engine.diff(requireId(input)) };
    case 'comment': {
      if (!input.path) throw new PrError('path가 필요하다', 1);
      if (!input.body) throw new PrError('body가 필요하다', 1);
      return engine.comment(requireId(input), {
        author: actorOf(input),
        path: input.path,
        line: input.line,
        body: input.body,
        replyTo: input.replyTo,
      });
    }
    case 'resolve': {
      if (!input.commentId) throw new PrError('commentId가 필요하다', 1);
      return engine.resolve(requireId(input), input.commentId, actorOf(input));
    }
    case 'review': {
      if (!input.verdict) throw new PrError('verdict가 필요하다', 1);
      return engine.review(requireId(input), {
        reviewer: actorOf(input),
        verdict: input.verdict,
        summary: input.summary ?? '',
      });
    }
    case 'update':
      return engine.update(requireId(input), input.head);
    case 'merge':
      return engine.merge(requireId(input), actorOf(input), { deleteBranch: input.deleteBranch });
    case 'close':
      return engine.closePr(requireId(input), actorOf(input), input.reason ?? '');
  }
}

/** PrError.exitCode(CLI 종료 코드)를 MCP 응답에서 갈래 타기 좋은 문자열로 바꾼다 */
function errorKind(exitCode: number): string {
  switch (exitCode) {
    case 3:
      return 'not_found';
    case 4:
      return 'conflict';
    default:
      return 'invalid';
  }
}

export async function handlePr(input: PrInput, cwd: string): Promise<string> {
  const repoRoot = resolve(input.repoRoot ?? cwd);
  log(`pr: action=${input.action}, repoRoot=${repoRoot}`);

  const engine = new LocalPrEngine(repoRoot);
  try {
    const result = dispatch(engine, input);
    return JSON.stringify(result, null, 2);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const kind = e instanceof PrError ? errorKind(e.exitCode) : 'unknown';
    log(`pr error: ${message}`);
    return JSON.stringify({ error: message, kind }, null, 2);
  } finally {
    engine.dispose();
  }
}
