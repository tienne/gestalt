import { mkdirSync } from 'node:fs';
import {
  parseTarget,
  readLoopState,
  resolveRepo,
  runGh,
  SIGNAL_ACTION,
  stateDir,
  stateRoot,
  type LoopStateReport,
} from '../../review-loop/index.js';

/**
 * `gestalt review-loop` — 남의 PR을 반복해 리뷰하는 루프가 쓰는 조회 도구.
 *
 * 판정에 쓰는 수를 스킬 문서가 셸로 적는 대신 여기서 낸다. 문서의 코드블록은 각각 다른
 * Bash 호출이라 앞 블록의 변수가 뒤에서 빈 문자열로 풀리는데, 그 값이 미대응 스레드
 * 수이면 승인이 조용히 열린다. 한 명령이 조회부터 신호 도출까지 끝내면 그 중간이 없다.
 */

export interface ReviewLoopStateOptions {
  pr: string;
  me?: string;
  json?: boolean;
}

export function reviewLoopStateCommand(opts: ReviewLoopStateOptions): void {
  run(() => {
    const { prNumber, owner, repo } = parseTarget(opts.pr);
    const report = readLoopState({ prNumber, owner, repo, me: opts.me });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printReport(report);
  });
}

/**
 * 상태 자리 경로를 낸다. 대상을 주면 그 PR 의 자리, 안 주면 뿌리다.
 *
 * 뿌리가 따로 있는 이유는 순서 때문이다 — 대상 문자열을 셸에 안 넘기려면 파일로
 * 떨궈야 하는데, 그 파일을 PR 별 자리에 두면 자리 이름을 정하는 데 필요한 번호를
 * 아직 모르는 단계다.
 *
 * **PR 별 자리는 네트워크를 안 탄다.** 경로는 대상과 git 디렉토리만으로 정해지는
 * 순수 함수라, 그걸 얻으려고 조회를 부르면 좌표가 필요한 자리마다 GraphQL 왕복이
 * 붙는다. 번호로만 준 경우에만 레포를 한 번 묻는다.
 */
export function reviewLoopDirCommand(opts: { create?: boolean }): void {
  run(() => {
    const dir = stateRoot();
    if (opts.create) mkdirSync(dir, { recursive: true });
    console.log(dir);
  });
}

/**
 * 대상에서 좌표를 한 번에 푼다 — PR 번호와 레포와 상태 자리 경로.
 *
 * 라운드 내내 이 넷이 필요한데 전부 조회에서 뽑으면 좌표를 얻으려고 GraphQL 을
 * 왕복하게 된다. 경로는 대상과 git 디렉토리만으로 정해지는 순수 함수이고 레포도
 * URL 이면 거기 적혀 있다 — 번호로만 준 경우에만 한 번 묻는다.
 *
 * 부르는 쪽은 이 결과를 파일로 굳혀 두고 라운드 내내 읽는다.
 */
export function reviewLoopResolveCommand(opts: { pr: string; create?: boolean }): void {
  run(() => {
    const parsed = parseTarget(opts.pr);
    const { owner, repo } =
      parsed.owner && parsed.repo ? { owner: parsed.owner, repo: parsed.repo } : resolveRepo(runGh);
    const dir = stateDir({ owner, repo, prNumber: parsed.prNumber });
    if (opts.create) mkdirSync(dir, { recursive: true });
    console.log(JSON.stringify({ prNumber: parsed.prNumber, owner, repo, stateDir: dir }));
  });
}

export function reviewLoopParseCommand(opts: { target: string; json?: boolean }): void {
  run(() => {
    const parsed = parseTarget(opts.target);
    if (opts.json) {
      console.log(JSON.stringify(parsed));
      return;
    }
    console.log(parsed.prNumber);
  });
}

function printReport(r: LoopStateReport): void {
  console.log(`${r.owner}/${r.repo}#${r.prNumber} ${r.prState} — ${r.signal}`);
  console.log(`  ${SIGNAL_ACTION[r.signal]}`);
  console.log(
    `  내가 연 스레드 ${r.myThreads}개 중 미대응 ${r.pending}개 (PR 전체 ${r.prThreads}개)`,
  );
  console.log(`  head ${r.head.slice(0, 8)}${r.changed ? ' (리뷰 이후 바뀜)' : ''}`);
  if (r.rerequested) console.log('  작성자가 재리뷰를 요청했어요');
}

/**
 * 실패를 종료 코드로 답한다.
 *
 * 부르는 쪽이 명령 치환으로 값만 가져가므로 stdout 에 아무것도 안 내는 게 중요하다.
 * 실패한 조회가 빈 문자열로 넘어가 0 으로 읽히면 승인 게이트가 그대로 열린다.
 */
function run(body: () => void): void {
  try {
    body();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
