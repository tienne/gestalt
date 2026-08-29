import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LocalPrEngine, PrError } from '../../local-pr/engine.js';
import {
  openThreads,
  resolveActor,
  unresolvedComments,
  unresolvedCount,
} from '../../local-pr/policy.js';
import { listRepos, repoKey, unregisterRepo } from '../../local-pr/registry.js';
import type { PullRequest, ReviewVerdict } from '../../local-pr/types.js';
import { PrWebEngine } from '../../local-pr-web/engine.js';

/**
 * `gestalt pr` — 로컬 PR CLI.
 *
 * 에이전트는 이 표면을 부른다. MCP가 없거나 끊긴 런타임에서도 돌아야 해서
 * 셸만 있으면 되는 이 경로를 먼저 만든다.
 */

export interface PrCommonOptions {
  repoRoot?: string;
  json?: boolean;
  author?: string;
}

/**
 * 본문을 파일이나 stdin에서 읽는다.
 *
 * 인자로 받지 않는 이유는 셸을 타면 한글과 백틱, 줄바꿈이 깨지기 때문이다.
 * `-`면 stdin이다 — gh가 --body-file에 쓰는 방식과 같다.
 */
function readBody(bodyFile?: string): string {
  if (bodyFile === undefined) return '';
  // 빈 문자열은 "안 줬다"가 아니라 "빈 경로를 줬다"다. 안 갈라 두면 셸에서 안 풀린
  // `--body-file "$F"`가 본문을 조용히 지운다 — 없는 경로는 ENOENT로 죽는데
  // 이 자리만 성공으로 끝난다
  if (bodyFile === '') throw new PrError('--body-file에 경로가 비어 있어요', 1);
  return readFileSync(bodyFile === '-' ? 0 : bodyFile, 'utf-8');
}

function actorOf(opts: PrCommonOptions): string {
  return resolveActor(opts.author);
}

function engineOf(opts: PrCommonOptions): LocalPrEngine {
  return new LocalPrEngine(resolve(opts.repoRoot ?? process.cwd()));
}

/** 에이전트가 파싱할 자리라 --json이면 객체만 내보낸다 */
function emit(value: unknown, json: boolean | undefined, human: () => void): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    human();
  }
}

function summarize(pr: PullRequest): string {
  const unresolved = unresolvedCount(pr);
  const round = pr.rounds[pr.rounds.length - 1]!.number;
  return `${pr.id}  [${pr.status}]  ${pr.title}  (라운드 ${round}, 미해결 ${unresolved})`;
}

/** 오류를 종료 코드로 옮긴다. 에이전트가 stdout을 안 읽고도 갈래를 탄다 */
function run(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    // `process.exit`이 여기서 흐름을 끊는 건 런타임의 성질이지 이 갈래가 한 약속이
    // 아니다. 갈라 두지 않으면 테스트가 exit을 가로챌 때 두 번 나간다
    if (e instanceof PrError) {
      console.error(e.message);
      process.exit(e.exitCode);
    } else {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }
}

export function prCreateCommand(
  opts: PrCommonOptions & { title: string; base?: string; head?: string; bodyFile?: string },
): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const pr = engine.create({
        title: opts.title,
        body: readBody(opts.bodyFile),
        author: actorOf(opts),
        base: opts.base,
        head: opts.head,
      });
      emit(pr, opts.json, () => {
        console.log(`PR을 만들었어요: ${pr.id}`);
        console.log(`  base ${pr.baseSha.slice(0, 8)} → head ${pr.headSha.slice(0, 8)}`);
        console.log(`  리뷰: gestalt pr show ${pr.id}`);
      });
    } finally {
      engine.dispose();
    }
  });
}

export function prListCommand(opts: PrCommonOptions & { status?: PullRequest['status'] }): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const prs = engine.list(opts.status);
      emit(prs, opts.json, () => {
        if (prs.length === 0) {
          console.log('PR이 없어요');
          return;
        }
        for (const pr of prs) console.log(summarize(pr));
      });
    } finally {
      engine.dispose();
    }
  });
}

export function prShowCommand(opts: PrCommonOptions & { id: string }): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const pr = engine.get(opts.id);
      if (!pr) throw new PrError(`PR을 못 찾았어요: ${opts.id}`, 3);

      emit(pr, opts.json, () => {
        console.log(summarize(pr));
        console.log(`  작성 ${pr.author}`);
        if (pr.body) console.log(`\n${pr.body}\n`);

        for (const round of pr.rounds) {
          const verdict = round.verdict ?? '진행 중';
          console.log(`\n라운드 ${round.number} — ${verdict} (코멘트 ${round.commentCount})`);
          for (const review of pr.reviews.filter((r) => r.round === round.number)) {
            console.log(`  ${review.reviewer}: ${review.verdict} — ${review.summary}`);
          }
        }

        // 머리글의 "미해결 N"과 이 목록이 같은 함수에서 나온다. 따로 세면 머리글은
        // 스레드를, 목록은 코멘트를 세어 한 화면에서 수가 갈린다
        const threads = openThreads(pr);
        if (threads.length > 0) {
          console.log('\n미해결 스레드');
          for (const { root, comments } of threads) {
            const at = root.line === null ? root.path : `${root.path}:${root.line}`;
            const replies = comments.length - 1;
            const tail = replies > 0 ? ` (답글 ${replies}개)` : '';
            console.log(`  [${root.id}] ${at} (${root.author})${tail}`);
            console.log(`    ${root.body.split('\n')[0]}`);
          }
        }
      });
    } finally {
      engine.dispose();
    }
  });
}

export function prDiffCommand(opts: PrCommonOptions & { id: string }): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const diff = engine.diff(opts.id);
      emit({ diff }, opts.json, () => console.log(diff));
    } finally {
      engine.dispose();
    }
  });
}

/**
 * `gestalt pr checkout <id>` — PR head를 임시 워크트리로 떼어낸다.
 *
 * `--remove`면 지운다. 붙였다 뗐다를 한 명령에 둔 이유는 경로 규칙이 하나라서다.
 * 리뷰어는 id만 알면 되고 경로를 적어둘 필요가 없다.
 */
export function prCheckoutCommand(
  opts: PrCommonOptions & { id: string; remove?: boolean; force?: boolean },
): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      if (opts.remove) {
        const result = engine.removeCheckout(opts.id, { force: opts.force });
        emit(result, opts.json, () => {
          if (result.removed) {
            console.log(`워크트리를 지웠어요: ${result.path}`);
            if (result.savedRef) {
              console.log(`  여기서 커밋한 변경은 ${result.savedRef}로 붙잡아 뒀어요`);
            }
          } else {
            console.log(`안 지웠어요 — ${result.reason}`);
            console.log(`  ${result.path}`);
          }
        });
        // 안 지운 건 실패가 아니라 판단을 되돌려준 것이다. 에이전트가 종료 코드로
        // 갈래를 타게 4(상태 충돌)를 준다. 지킨 갈래는 `dirty`, `diverged`, `stale`
        // 셋이고 앞으로 늘 수 있다. 그 셋을 나열하는 대신 "지운 두 갈래가 아니면"으로
        // 적는다. `absent`를 뺀 이유는 지울 자리가 없는 게 정리의 목표가 이미 이뤄진
        // 상태여서다. 4로 주면 `--remove`를 두 번 부르는 `set -e` 스크립트가 두 번째에
        // 죽는다. 이 갈림은 --json의 status로도 읽을 수 있다 — 산문 reason을 부분
        // 문자열로 긁을 필요가 없다
        if (result.status !== 'removed' && result.status !== 'absent') process.exit(4);
        return;
      }

      const checkout = engine.checkout(opts.id);
      emit(checkout, opts.json, () => {
        console.log(checkout.created ? '워크트리를 뗐어요' : '이미 떼어둔 워크트리가 있어요');
        console.log(`  ${checkout.path}`);
        console.log(`  head ${checkout.headSha.slice(0, 8)}`);
        console.log(`  정리: gestalt pr checkout ${opts.id} --remove`);
      });
    } finally {
      engine.dispose();
    }
  });
}

export function prCommentCommand(
  opts: PrCommonOptions & {
    id: string;
    path: string;
    line?: string;
    bodyFile?: string;
    replyTo?: string;
  },
): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const body = readBody(opts.bodyFile);
      if (!body.trim()) throw new PrError('본문이 비었어요. --body-file로 넘겨주세요', 1);

      const pr = engine.comment(opts.id, {
        author: actorOf(opts),
        path: opts.path,
        line: opts.line ? Number(opts.line) : undefined,
        body,
        replyTo: opts.replyTo,
      });
      const added = pr.comments[pr.comments.length - 1]!;
      emit(added, opts.json, () => console.log(`코멘트 ${added.id} 추가`));
    } finally {
      engine.dispose();
    }
  });
}

export function prCommentsCommand(
  opts: PrCommonOptions & { id: string; unresolved?: boolean },
): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const pr = engine.get(opts.id);
      if (!pr) throw new PrError(`PR을 못 찾았어요: ${opts.id}`, 3);

      const comments = opts.unresolved ? unresolvedComments(pr) : pr.comments;
      emit(comments, opts.json, () => {
        for (const c of comments) {
          const at = c.line === null ? c.path : `${c.path}:${c.line}`;
          const mark = c.resolved ? '해결' : '열림';
          console.log(`[${c.id}] ${at} (${c.author}, ${mark})`);
          console.log(c.body);
          console.log('');
        }
      });
    } finally {
      engine.dispose();
    }
  });
}

export function prResolveCommand(opts: PrCommonOptions & { commentId: string; id: string }): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const pr = engine.resolve(opts.id, opts.commentId, actorOf(opts));
      emit(pr, opts.json, () => console.log(`코멘트 ${opts.commentId} 스레드를 닫았어요`));
    } finally {
      engine.dispose();
    }
  });
}

const VERDICTS: Record<string, ReviewVerdict> = {
  approve: 'approve',
  'request-changes': 'request_changes',
  comment: 'comment',
};

export function prReviewCommand(
  opts: PrCommonOptions & { id: string; verdict: string; bodyFile?: string },
): void {
  run(() => {
    const verdict = VERDICTS[opts.verdict];
    if (!verdict) {
      throw new PrError('판정은 approve, request-changes, comment 중 하나예요', 1);
    }

    const engine = engineOf(opts);
    try {
      const pr = engine.review(opts.id, {
        reviewer: actorOf(opts),
        verdict,
        summary: readBody(opts.bodyFile).trim(),
      });
      emit(pr, opts.json, () => {
        console.log(`판정을 남겼어요: ${opts.verdict} — 상태 ${pr.status}`);
        console.log(`  라운드 ${pr.rounds[pr.rounds.length - 1]!.number}`);
      });
    } finally {
      engine.dispose();
    }
  });
}

export function prUpdateCommand(opts: PrCommonOptions & { id: string; head?: string }): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const pr = engine.update(opts.id, opts.head);
      emit(pr, opts.json, () => {
        console.log(`head를 ${pr.headSha.slice(0, 8)}로 옮겼어요 — 상태 ${pr.status}`);
      });
    } finally {
      engine.dispose();
    }
  });
}

/**
 * `gestalt pr edit <id>` — 제목과 본문을 고친다.
 *
 * 본문은 `--body-file`로만 받는다. `pr create`와 `pr comment`가 같은 이유로 그렇게
 * 받는다 — 인자로 넘기면 셸이 한글과 백틱과 줄바꿈을 건드린다. 제목은 원래 인자로
 * 받던 값이라 `--title` 그대로다.
 *
 * `--body-file`을 준 순간 본문은 그 파일 내용이다. 빈 파일이면 본문을 비운다 —
 * 코멘트와 달리 여기서 빈 본문을 막지 않는 건 "잘못 쓴 본문을 지운다"가 실제로
 * 있는 쓰임이어서다.
 */
export function prEditCommand(
  opts: PrCommonOptions & { id: string; title?: string; bodyFile?: string },
): void {
  run(() => {
    if (opts.title === undefined && opts.bodyFile === undefined) {
      throw new PrError('고칠 것을 주세요 — --title이나 --body-file 중 하나는 있어야 해요', 1);
    }

    const engine = engineOf(opts);
    try {
      const pr = engine.edit(
        opts.id,
        {
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(opts.bodyFile !== undefined ? { body: readBody(opts.bodyFile) } : {}),
        },
        actorOf(opts),
      );
      emit(pr, opts.json, () => {
        console.log(`PR ${pr.id}을 고쳤어요 — 상태 ${pr.status}`);
        console.log(`  ${pr.title}`);
      });
    } finally {
      engine.dispose();
    }
  });
}

export function prMergeCommand(
  opts: PrCommonOptions & { id: string; deleteBranch?: boolean },
): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const before = engine.get(opts.id);
      const unresolved = before ? unresolvedCount(before) : 0;

      const pr = engine.merge(opts.id, actorOf(opts), { deleteBranch: opts.deleteBranch });
      emit(pr, opts.json, () => {
        console.log(`PR을 머지했어요: ${pr.id}`);
        if (unresolved > 0) console.log(`  미해결 스레드 ${unresolved}개가 남은 채로 머지했어요`);
      });
    } finally {
      engine.dispose();
    }
  });
}

export function prCloseCommand(opts: PrCommonOptions & { id: string; reason?: string }): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const pr = engine.closePr(opts.id, actorOf(opts), opts.reason ?? '');
      emit(pr, opts.json, () => console.log(`PR을 닫았어요: ${opts.id}`));
    } finally {
      engine.dispose();
    }
  });
}

/**
 * `gestalt pr prune` — 붙잡아 둘 이유가 끝난 ref를 놓는다.
 *
 * `refs/gestalt/` 아래는 지금까지 늘기만 했다. 무엇을 언제 놓는지는 엔진의 `prune`
 * 주석에 있다. 되돌릴 수 없는 갈래(체크아웃 자국)는 `--checkouts`로 뜻을 밝혀야 놓는다.
 */
export function prPruneCommand(
  opts: PrCommonOptions & { checkouts?: boolean; dryRun?: boolean },
): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const result = engine.prune({ checkouts: opts.checkouts, dryRun: opts.dryRun });
      emit(result, opts.json, () => {
        const verb = result.dryRun ? '놓을 참이에요' : '놓았어요';
        console.log(`ref ${result.released.length}개를 ${verb}`);
        for (const ref of result.released) console.log(`  ${ref}`);
        for (const k of result.kept) console.log(`  남김 ${k.prId} — ${k.reason}`);
        if (!opts.checkouts) {
          console.log('  체크아웃 자국은 그대로예요. 놓으려면 --checkouts를 붙여주세요');
        }
      });
    } finally {
      engine.dispose();
    }
  });
}

/**
 * `--repo-root`가 지금 자리와 다른 레포를 가리키면 막는다.
 *
 * `pr serve`는 뜨면서 그 경로를 뷰어 목록에 영구히 넣는다. 목록에 넣는 문을 좁게
 * 둔 근거가 "사람이 그 레포에서 웹 UI를 직접 띄운 순간"인데, `--repo-root`를 그대로
 * 받으면 그 전제가 깨진다 — 에이전트가 셸로 `pr serve --repo-root /남의/레포
 * --no-browser`를 한 번 돌리면 그 레포가 인증 없는 뷰어 목록에 들어간다. 이후 전혀
 * 다른 레포에서 serve를 띄워도 그 레포의 diff와 코멘트가 계속 나간다.
 *
 * 그래서 `--repo-root`는 지금 자리와 같은 레포를 가리킬 때만 받는다. 워크트리나
 * 하위 디렉토리를 가리키는 쓰임은 그대로 살고(키가 같다), 남의 레포를 넣는 쓰임만
 * 닫힌다. 다른 레포를 보려면 거기서 한 번 띄우면 된다.
 *
 * 목록에 넣는 호출 자체는 `local-pr-web/engine.ts`에 있다. 거기서 "cwd만 등록하고
 * 나머지는 조회만"으로 가르는 게 더 좁은 문이지만 그건 이 파일 밖이다.
 *
 * 서버를 안 띄우고 이 판단만 볼 수 있게 내보낸다. 통과 갈래를 `prServeCommand`로
 * 확인하려면 진짜 서버가 떠 버린다.
 */
export function assertServeRoot(repoRoot: string): void {
  const cwd = process.cwd();
  if (resolve(repoRoot) === resolve(cwd)) return;

  let same: boolean;
  try {
    same = repoKey(repoRoot) === repoKey(cwd);
  } catch {
    same = false;
  }
  if (same) return;

  throw new PrError(
    `--repo-root가 지금 자리와 다른 레포를 가리켜요: ${repoRoot}\n` +
      '웹 UI는 띄우는 순간 그 레포를 인증 없는 뷰어 목록에 넣어요. 그 레포로 옮겨가서 띄워주세요',
    4,
  );
}

/** `gestalt pr serve` — 브라우저에서 PR을 읽는 읽기 전용 웹 UI. 코멘트 작성은 CLI 몫으로 남긴다 */
export async function prServeCommand(
  opts: PrCommonOptions & { port?: number; noBrowser?: boolean },
): Promise<void> {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  if (opts.repoRoot !== undefined) {
    try {
      assertServeRoot(repoRoot);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(e instanceof PrError ? e.exitCode : 1);
      return;
    }
  }
  const engine = new PrWebEngine();

  try {
    const result = await engine.start({
      repoRoot,
      port: opts.port,
      openBrowser: !opts.noBrowser,
    });
    console.log(`\n로컬 PR 웹 UI: ${result.url}`);
    console.log(result.message);
    console.log('\nCtrl+C로 멈춥니다.\n');

    // 서버의 SIGINT 핸들러가 프로세스를 끝낼 때까지 살려둔다
    await new Promise<void>(() => {
      /* Ctrl+C까지 대기 */
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`웹 UI를 못 띄웠어요: ${msg}`);
    process.exit(1);
  }
}

/**
 * `gestalt pr repos` — 웹 UI가 열어 주는 레포 목록.
 *
 * `unregister`가 키를 받으므로 그 키를 어디선가 볼 수 있어야 한다. 무엇이 인증 없는
 * 뷰어에 실려 있는지 확인하는 자리이기도 하다.
 */
export function prReposCommand(opts: PrCommonOptions): void {
  run(() => {
    const repos = listRepos();
    emit(repos, opts.json, () => {
      if (repos.length === 0) {
        console.log('등록된 레포가 없어요');
        return;
      }
      for (const r of repos) console.log(`${r.key}  ${r.name}  ${r.path}`);
    });
  });
}

/** `gestalt pr unregister <key>` — 그 레포를 웹 UI 목록에서 뺀다. 레포 자체는 안 건드린다 */
export function prUnregisterCommand(opts: PrCommonOptions & { key: string }): void {
  run(() => {
    const gone = unregisterRepo(opts.key);
    if (!gone) throw new PrError(`목록에 없는 키예요: ${opts.key}`, 3);
    emit({ key: opts.key, removed: true }, opts.json, () => {
      console.log(`목록에서 뺐어요: ${opts.key}`);
    });
  });
}
