import { resolve } from 'node:path';
import { LocalPrEngine, PrError } from '../../local-pr/engine.js';
import { resolveActor } from '../../local-pr/policy.js';
import { repoKey } from '../../local-pr/registry.js';
import type { CheckoutRemoval, PrCheckout } from '../../local-pr/git.js';
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
  return resolveActor(input.author);
}

function requireId(input: PrInput): string {
  if (!input.id) throw new PrError('id가 필요하다', 1);
  return input.id;
}

function dispatch(
  engine: LocalPrEngine,
  input: PrInput,
): PullRequest | PullRequest[] | { diff: string } | PrCheckout | CheckoutRemoval {
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
    // CLI에만 두는 갈래는 `prune`처럼 되돌릴 수 없는 것이다. 본문 수정은 다시 고쳐
    // 되돌릴 수 있고 옛 값이 이벤트에 그대로 남는다. 이 문이 없어서 막힌 게
    // MCP로 도는 리뷰 에이전트였다 — 틀린 본문을 코멘트로만 정정하고 스레드를
    // 열어둔 채 머지에 실려 갔다. 여기 없으면 그 자리가 그대로다
    case 'edit': {
      if (input.title === undefined && input.body === undefined) {
        throw new PrError('edit에는 title이나 body 중 하나가 필요하다', 1);
      }
      return engine.edit(
        requireId(input),
        {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
        },
        actorOf(input),
      );
    }
    case 'merge':
      return engine.merge(requireId(input), actorOf(input), { deleteBranch: input.deleteBranch });
    case 'close':
      return engine.closePr(requireId(input), actorOf(input), input.reason ?? '');
    case 'checkout':
      return engine.checkout(requireId(input));
    case 'checkout_remove':
      return engine.removeCheckout(requireId(input), { force: input.force });
  }
}

/** PrError.exitCode(CLI 종료 코드)를 MCP 응답에서 갈래 타기 좋은 문자열로 바꾼다 */
export function errorKind(exitCode: number): string {
  switch (exitCode) {
    case 3:
      return 'not_found';
    case 4:
      return 'conflict';
    default:
      return 'invalid';
  }
}

/**
 * `repoRoot`가 지금 자리와 다른 레포를 가리키면 막는다.
 *
 * 이 인자는 그대로 엔진의 작업 디렉토리가 되고 거기서 git이 돈다. `merge`는
 * update-ref를 쓰고 워크트리를 만든다. `close`는 ref를 지운다. `checkout_remove --force`는
 * 경로를 재귀로 지운다. 인자 하나를 바꿔 부르면 이 머신의 아무 git 레포나 그 대상이
 * 된다. 레지스트리가 `pr create`의 등록 경로를 막은 것과 같은 축인데, 정작 git을
 * 변형하는 표면이 열려 있었다.
 *
 * 그래서 지금 자리와 **같은 레포**일 때만 받는다. 판정은 공용 git 디렉토리로 하므로
 * 워크트리와 하위 디렉토리는 그대로 통과한다 — 이 인자가 원래 있는 이유가 그거다.
 * 다른 레포를 다루려면 거기서 서버를 띄우면 된다. CLI의 `pr serve --repo-root`가
 * 같은 결로 좁혀져 있다.
 *
 * 읽기만 하는 action을 빼줄까 했지만 안 뺐다. `diff`와 `get`은 남의 레포 변경 내용과
 * 리뷰 코멘트를 그대로 뱉는다. 그리고 action별로 표를 따로 두면 새 action이 붙을 때
 * 그 표에 안 적히는 쪽이 기본으로 열린다 — 규칙 하나가 안 뒤처진다.
 */
function assertSameRepo(repoRoot: string, cwd: string): void {
  if (repoRoot === resolve(cwd)) return;

  try {
    // 판정 기준은 공용 git 디렉토리다. 레포가 아니면 여기서 던지고 막는 쪽으로 간다
    if (repoKey(repoRoot) === repoKey(cwd)) return;
  } catch {
    // 아래로 떨어뜨린다
  }

  throw new PrError(
    `repoRoot가 지금 자리와 다른 레포를 가리킨다: ${repoRoot}. ` +
      '로컬 PR 도구는 이 레포 안에서만 돈다. 워크트리와 하위 디렉토리는 그대로 쓸 수 있다',
    1,
  );
}

export async function handlePr(input: PrInput, cwd: string): Promise<string> {
  const repoRoot = resolve(input.repoRoot ?? cwd);
  log(`pr: action=${input.action}, repoRoot=${repoRoot}`);

  try {
    assertSameRepo(repoRoot, cwd);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`pr error: ${message}`);
    return JSON.stringify({ error: message, kind: 'invalid' }, null, 2);
  }

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
