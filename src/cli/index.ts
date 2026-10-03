import { Command } from 'commander';
import { interviewCommand } from './commands/interview.js';
import { specCommand } from './commands/spec.js';
import { serveCommand } from './commands/serve.js';
import { statusCommand } from './commands/status.js';
import { setupCommand } from './commands/setup.js';
import { initCommand } from './commands/init.js';
import { graphVisualizeCommand } from './commands/graph-visualize.js';
import { updateCommand } from './commands/update.js';
import { usageReportCommand } from './commands/usage-report.js';
import { humanizeCheckCommand } from './commands/humanize-check.js';
import { humanizeScanCommand } from './commands/humanize-scan.js';
import { memoryMergeCommand } from './commands/memory-merge.js';
import { explainCheckCommand } from './commands/explain-check.js';
import { DEFAULT_CASES_PATH, explainEvalCommand } from './commands/explain-eval.js';
import {
  reviewLoopDirCommand,
  reviewLoopParseCommand,
  reviewLoopResolveCommand,
  reviewLoopStateCommand,
} from './commands/review-loop.js';
import { approveGateCommand, reviewRoundsCommand } from './commands/approve-gate.js';
import {
  harnessRefsClonesPruneCommand,
  harnessRefsCollectCommand,
} from './commands/harness-refs.js';
import {
  harnessRefsFollowupBuildCommand,
  harnessRefsFollowupCheckCommand,
  harnessRefsFollowupFindCommand,
  harnessRefsRelatedPrsCommand,
  harnessRefsThreeStateCommand,
} from './commands/harness-refs-cross-pr.js';
import { getVersion } from '../core/version.js';
import {
  prCheckoutCommand,
  prCloseCommand,
  prCommentCommand,
  prCommentsCommand,
  prCreateCommand,
  prDiffCommand,
  prEditCommand,
  prListCommand,
  prMergeCommand,
  prReposCommand,
  prResolveCommand,
  prReviewCommand,
  prPruneCommand,
  prServeCommand,
  prShowCommand,
  prUnregisterCommand,
  prUpdateCommand,
} from './commands/pr.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('gestalt')
    .description(
      'Gestalt — AI Development Harness with Gestalt psychology-driven requirement clarification',
    )
    .version(getVersion());

  program
    .command('serve', { isDefault: true })
    .description('Start the Gestalt MCP server (stdio transport)')
    .action(async () => {
      await serveCommand();
    });

  program
    .command('interview [topic]')
    .description('Start an interactive Gestalt interview')
    .action(async (topic: string | undefined) => {
      await interviewCommand(topic ?? 'Untitled project');
    });

  program
    .command('spec <session-id>')
    .description('Generate a Spec from a completed interview')
    .option('-f, --force', 'Force generation even if resolution threshold is not met')
    .action(async (sessionId: string, options: { force?: boolean }) => {
      await specCommand(sessionId, options);
    });

  program
    .command('status [session-id]')
    .description('Check interview session status')
    .action((sessionId?: string) => {
      statusCommand(sessionId);
    });

  program
    .command('init')
    .description(
      'Initialize Gestalt: create gestalt.json, build code graph, and install post-commit hook',
    )
    .option('--skip-graph', 'Skip code graph build')
    .option('--skip-hook', 'Skip post-commit hook installation')
    .action(async (options: { skipGraph?: boolean; skipHook?: boolean }) => {
      await initCommand(options);
    });

  program
    .command('setup')
    .description('Generate a gestalt.json configuration file')
    .action(() => {
      setupCommand();
    });

  program
    .command('update')
    .description('Check for updates and install the latest version')
    .action(async () => {
      await updateCommand();
    });

  program
    .command('memory-merge <base> <ours> <theirs>')
    .description(
      'git merge driver for .gestalt/memory.json — writes the union into <ours> (use with %O %A %B)',
    )
    .action((_base: string, ours: string, theirs: string) => {
      memoryMergeCommand(ours, theirs);
    });

  program
    .command('graph-visualize')
    .description('Visualize the code knowledge graph in the browser')
    .option('--repo-root <path>', 'Repository root (defaults to cwd)')
    .option('--port <number>', 'Preferred server port (default: 7891)', parseInt)
    .option('--no-browser', 'Do not open the browser automatically')
    .action(async (options: { repoRoot?: string; port?: number; browser?: boolean }) => {
      await graphVisualizeCommand({
        repoRoot: options.repoRoot,
        port: options.port,
        noBrowser: options.browser === false,
      });
    });

  const pr = program
    .command('pr')
    .description('로컬 PR 리뷰 — 에이전트끼리 주고받는 자리')
    .option('--repo-root <path>', 'Repository root (defaults to cwd)')
    .option('--author <actor>', '누가 하는지 (예: codex:worker-2). 없으면 GESTALT_ACTOR')
    .option('--json', '에이전트가 파싱할 JSON으로');

  const inherited = (cmd: { parent?: { opts(): Record<string, unknown> } }) =>
    (cmd.parent?.opts() ?? {}) as { repoRoot?: string; author?: string; json?: boolean };

  pr.command('create')
    .description('현재 HEAD로 PR을 만든다')
    .requiredOption('--title <title>', 'PR 제목')
    .option('--base <ref>', '갈라져 나온 기준 (기본 main)')
    .option('--head <ref>', '리뷰 대상 (기본 HEAD)')
    .option('--body-file <path>', '본문 파일. -면 stdin')
    .action((o, cmd) => prCreateCommand({ ...inherited(cmd), ...o }));

  pr.command('list')
    .description('PR 목록')
    .option('--status <status>', 'open | changes_requested | merged | closed')
    .action((o, cmd) => prListCommand({ ...inherited(cmd), ...o }));

  pr.command('show <id>')
    .description('PR 상세 — 라운드와 미해결 스레드')
    .action((id, o, cmd) => prShowCommand({ ...inherited(cmd), ...o, id }));

  pr.command('diff <id>')
    .description('PR의 diff')
    .action((id, o, cmd) => prDiffCommand({ ...inherited(cmd), ...o, id }));

  pr.command('checkout <id>')
    .description('PR head를 임시 워크트리로 떼어낸다 — 코드를 일부러 깨고 돌려볼 자리')
    .option('--remove', '떼어둔 워크트리를 지운다')
    .option('--force', '--remove와 함께: 커밋 안 된 변경이 있어도 지운다')
    .action((id, o, cmd) => prCheckoutCommand({ ...inherited(cmd), ...o, id }));

  pr.command('comment <id>')
    .description('인라인 코멘트를 단다')
    .requiredOption('--path <path>', '파일 경로')
    .option('--line <number>', '라인 번호. 없으면 파일 전반')
    .requiredOption('--body-file <path>', '본문 파일. -면 stdin')
    .option('--reply-to <commentId>', '스레드에 답글')
    .action((id, o, cmd) => prCommentCommand({ ...inherited(cmd), ...o, id }));

  pr.command('comments <id>')
    .description('코멘트 목록')
    .option('--unresolved', '안 끝난 것만')
    .action((id, o, cmd) => prCommentsCommand({ ...inherited(cmd), ...o, id }));

  pr.command('resolve <id> <commentId>')
    .description('코멘트 스레드를 종료한다')
    .action((id, commentId, o, cmd) =>
      prResolveCommand({ ...inherited(cmd), ...o, id, commentId }),
    );

  pr.command('review <id>')
    .description('판정을 남긴다')
    .requiredOption('--verdict <verdict>', 'approve | request-changes | comment')
    .option('--body-file <path>', '요약 파일. -면 stdin')
    .action((id, o, cmd) => prReviewCommand({ ...inherited(cmd), ...o, id }));

  pr.command('update <id>')
    .description('head를 지금 커밋으로 옮긴다')
    .option('--head <ref>', '옮길 대상')
    .action((id, o, cmd) => prUpdateCommand({ ...inherited(cmd), ...o, id }));

  pr.command('edit <id>')
    .description('제목과 본문을 고친다. 리뷰 판정도 라운드도 안 건드린다')
    .option('--title <title>', '새 제목')
    .option('--body-file <path>', '새 본문 파일. -면 stdin')
    .action((id, o, cmd) => prEditCommand({ ...inherited(cmd), ...o, id }));

  pr.command('merge <id>')
    .description('머지한다. 승인이 없어도 막지 않는다')
    .option('--delete-branch', '머지 뒤 브랜치를 지운다')
    .action((id, o, cmd) => prMergeCommand({ ...inherited(cmd), ...o, id }));

  pr.command('close <id>')
    .description('PR을 종료한다')
    .option('--reason <text>', '종료 이유')
    .action((id, o, cmd) => prCloseCommand({ ...inherited(cmd), ...o, id }));

  pr.command('prune')
    .description('붙잡아 둘 이유가 끝난 ref를 놓는다 — 머지된 PR의 base·head')
    .option('--checkouts', '체크아웃 자국도 놓는다. 되돌릴 수 없어 기본은 남긴다')
    .option('--dry-run', '무엇을 놓을지만 보여준다')
    .action((o, cmd) => prPruneCommand({ ...inherited(cmd), ...o }));

  pr.command('serve')
    .description('브라우저에서 PR을 읽는 웹 UI를 띄운다 (읽기 전용)')
    .option('--port <number>', '서버 포트 (기본 7892)', parseInt)
    .option('--no-browser', '브라우저를 자동으로 열지 않는다')
    .action(async (o, cmd) => {
      const opts = { ...inherited(cmd), ...o } as {
        repoRoot?: string;
        author?: string;
        json?: boolean;
        port?: number;
        browser?: boolean;
      };
      await prServeCommand({ ...opts, noBrowser: opts.browser === false });
    });

  pr.command('repos')
    .description('웹 UI가 열어 주는 레포 목록')
    .action((o, cmd) => prReposCommand({ ...inherited(cmd), ...o }));

  pr.command('unregister <key>')
    .description('그 레포를 웹 UI 목록에서 뺀다. 레포 자체는 안 건드린다')
    .action((key, o, cmd) => prUnregisterCommand({ ...inherited(cmd), ...o, key }));

  const reviewLoop = program
    .command('review-loop')
    .description('남의 PR 리뷰 루프가 쓰는 조회 — 판정에 쓰는 수를 여기서 낸다');

  reviewLoop
    .command('state')
    .description('PR 상태와 미대응 스레드 수, 다음에 할 일을 한 번에')
    .requiredOption('--pr <target>', 'PR 번호나 URL')
    .option('--me <login>', '내 로그인. 없으면 상태 자리 캐시나 gh api user')
    .option('--json', '에이전트가 파싱할 JSON으로')
    .action((o) => reviewLoopStateCommand(o));

  reviewLoop
    .command('dir')
    .description('상태 자리의 뿌리. 대상을 아직 못 가린 단계가 쓴다')
    .option('--create', '없으면 만든다')
    .action((o) => reviewLoopDirCommand(o));

  reviewLoop
    .command('resolve')
    .description('대상에서 PR 번호와 레포와 상태 자리를 한 번에 — 라운드 내내 이걸 읽는다')
    .requiredOption('--pr <target>', 'PR 번호나 URL')
    .option('--create', '상태 자리를 만든다')
    .action((o) => reviewLoopResolveCommand(o));

  reviewLoop
    .command('parse <target>')
    .description('번호나 #번호나 PR URL에서 번호와 레포를 읽는다')
    .option('--json', 'prNumber와 owner와 repo를 JSON으로')
    .action((target, o) => reviewLoopParseCommand({ target, ...o }));

  reviewLoop
    .command('rounds')
    .description('라운드 기록과 원격 없는 레포에서 앞서 받은 답. 대상을 안 주면 현재 브랜치 자리')
    .option('--pr <target>', 'PR 번호나 URL')
    .option('--dir <path>', '기록을 둘 디렉토리')
    .option('--branch <name>', 'PR 없는 리뷰의 브랜치')
    .action((o) => reviewRoundsCommand(o));

  reviewLoop
    .command('approve-gate')
    .description('이번 라운드에 APPROVE 를 내도 되는지. 막히면 COMMENT 로 내린다')
    .option('--pr <target>', 'PR 번호나 URL')
    .option('--dir <path>', '기록을 둘 디렉토리')
    .option('--branch <name>', 'PR 없는 리뷰의 브랜치')
    .option('--scope <scope>', '사용자 명시 범위 precondition|thisRound|none', 'none')
    .option(
      '--issue <name>',
      '이번 라운드 이슈 lookupBlocked|noGitHubRemote|relatedPrUnconfirmed (여러 번)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--reference-check-skipped', '참조 검사를 비워둔 채 진행했다')
    .option('--user-choice <choice>', '조회 막힘 질문의 답 proceedWithoutRefs|wait')
    .option('--auto-consent', 'ⓢ 자동 판정 동의. 명시로 치지 않는다')
    .option('--event <event>', '내려던 이벤트 APPROVE|COMMENT|REQUEST_CHANGES', 'APPROVE')
    .option('--round <n>', '라운드 번호. 없으면 마지막 기록 다음')
    .option('--record', '판정 결과를 라운드 기록에 남긴다')
    .action((o) => approveGateCommand(o));

  const harnessRefs = program
    .command('harness-refs')
    .description('하네스 PR의 레포 간 참조 후보. review 스킬 1단계 뒤에 부른다');

  harnessRefs
    .command('related-prs')
    .description('연관 PR을 찾아 확정 수준을 매긴다. 조회가 막히면 status blocked')
    .requiredOption('--mode <mode>', '확정 기준 표의 열 ship|reviewLoop')
    .option('--pr <target>', '이번 PR 번호나 URL. ship은 PR이 없으면 비운다')
    .option('--repo <owner/name>', '이번 PR의 레포. 없으면 --pr URL, collect 결과, origin 순')
    .option('--candidates <path>', 'harness-refs collect --json 결과 파일')
    .option(
      '--related-repo <owner/name>',
      '관련 레포 추가 (여러 번)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--branch <name>', '이번 PR 브랜치. 없으면 gh나 현재 브랜치')
    .option('--author <login>', '이번 PR 작성자. 없으면 gh')
    .option('--title <text>', 'PR이 아직 없을 때 제목')
    .option('--body-file <path>', 'PR 본문 파일. PR이 아직 없을 때 쓴다')
    .option('--json', 'stdout에 JSON만')
    .action((o) => harnessRefsRelatedPrsCommand(o));

  harnessRefs
    .command('three-state')
    .description('레포를 넘는 참조를 main, 연관 PR head, 둘 다 머지된 뒤에서 판정한다')
    .requiredOption('--candidates <path>', 'harness-refs collect --json 결과 파일')
    .requiredOption('--related-prs <path>', 'harness-refs related-prs --json 결과 파일')
    .option('--repo <owner/name>', '이번 PR의 레포. 없으면 collect 결과')
    .option(
      '--repo-dir <path>',
      '참조 대상 레포 로컬 clone. owner/name=경로 꼴도 받는다 (여러 번)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      '--default-branch <owner/name=branch>',
      '대상 레포 기본 브랜치 (여러 번). 없으면 origin/HEAD',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      '--confirm <owner/name#n>',
      'ship ⓐ에서 사용자가 확인한 연관 PR (여러 번)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--json', 'stdout에 JSON만')
    .action((o) => harnessRefsThreeStateCommand(o));

  const followup = harnessRefs
    .command('followup')
    .description('다음 PR로 미룬 작업의 표시를 찾고 후속 PR이 이행하는지 본다');

  followup
    .command('build')
    .description('다음 PR로 미룬 스레드를 resolve할 때 답글에 붙일 후속 마커를 만든다')
    .requiredOption('--pr <target>', '지금 리뷰 중인 PR 번호나 URL (마커의 원래 PR)')
    .option('--repo <owner/name>', '원래 PR의 레포. 없으면 --pr URL, origin 순')
    .requiredOption('--thread-id <id>', 'resolve할 리뷰 스레드 id')
    .requiredOption('--target-repo <owner/name>', '후속 작업을 할 레포')
    .option('--work <text>', '후속 PR에서 할 작업 (500자 이하)')
    .option('--work-file <path>', '작업 문장을 담은 파일. --work 대신 쓴다')
    .option('--json', 'stdout에 JSON만')
    .action((o) => harnessRefsFollowupBuildCommand(o));

  followup
    .command('find')
    .description('관련 레포의 머지된 PR 코멘트에서 이번 레포를 가리키는 후속 마커를 찾는다')
    .option('--repo <owner/name>', '후속 PR의 레포. 없으면 --pr URL, collect 결과, origin 순')
    .option('--pr <target>', '후속 PR 번호나 URL. 이 PR로 이행된 마커도 남긴다')
    .option('--candidates <path>', 'harness-refs collect --json 결과 파일 (관련 레포를 읽는다)')
    .option(
      '--related-repo <owner/name>',
      '관련 레포 추가 (여러 번)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      '--trusted-author <login>',
      '마커를 믿을 작성자 추가 (여러 번). 원래 PR 작성자와 gh 사용자는 늘 포함',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--json', 'stdout에 JSON만')
    .action((o) => harnessRefsFollowupFindCommand(o));

  followup
    .command('check')
    .description('후속 PR 본문과 diff가 마커의 작업을 이행하는지 본다')
    .requiredOption('--markers <path>', 'harness-refs followup find --json 결과 파일')
    .option('--pr <target>', '후속 PR 번호나 URL')
    .option('--repo <owner/name>', '후속 PR의 레포')
    .option('--body-file <path>', 'PR 본문 파일. 주면 gh로 읽지 않는다')
    .option('--diff-file <path>', 'PR diff 파일. 주면 gh로 읽지 않는다')
    .option('--json', 'stdout에 JSON만')
    .action((o) => harnessRefsFollowupCheckCommand(o));

  harnessRefs
    .command('collect')
    .description('검출기 여섯 개의 후보와 조회 막힘을 JSON 하나로 모은다. 리뷰를 막지 않는다')
    .requiredOption('--base <sha>', '비교 기준 커밋')
    .requiredOption('--head <sha>', '리뷰할 커밋. 워킹트리가 이 커밋이어야 한다')
    .option('--backend <kind>', '역방향 검색 백엔드 local|github', 'local')
    .option(
      '--repo-dir <path>',
      '관련 레포 로컬 clone. owner/name=경로 꼴도 받는다 (여러 번)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--refresh', '관련 레포 탐지 캐시를 무시한다')
    .option('--json', 'stdout에 JSON만')
    .action((o) => harnessRefsCollectCommand(o));

  harnessRefs
    .command('clones')
    .description('collect가 워크트리마다 받아 둔 관련 레포 클론')
    .command('prune')
    .description(
      '워크트리가 지워졌거나 오래 안 쓴 클론을 지운다. collect도 시작할 때 같은 기준으로 지운다',
    )
    .option('--all', '기준과 상관없이 전부 지운다. 도는 수집이 있으면 그 수집의 검색이 빈다')
    .option('--max-idle-days <n>', '이 일수 넘게 안 쓴 클론을 지운다 (기본 7)')
    .option('--json', 'stdout에 JSON만')
    .action((o) => harnessRefsClonesPruneCommand(o));

  program
    .command('humanize-scan')
    .description(
      '원문에서 실제로 걸린 S1 룰만 처방과 함께 추린다 (exit 0 걸림 / 10 없음, 파일 여럿이면 우선순위로 하나로 합친다)',
    )
    .option(
      '--file <path>',
      '스캔할 텍스트 파일 (여러 번 지정 가능)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--register <doc|chat|report>', '어느 말투 기준으로 볼지 (기본 doc)', 'doc')
    .option('--json', '스캔 결과를 JSON으로')
    .action((options: { file: string[]; register?: string; json?: boolean }) => {
      if (options.file.length === 0) {
        console.error("required option '--file <path>' not specified");
        process.exit(1);
      }
      humanizeScanCommand(options);
    });

  program
    .command('humanize-check')
    .description('Judge a humanized draft against the rulebook (exit 0 pass / 1 warn / 2 abort)')
    .requiredOption('--before <path>', 'Original text file')
    .requiredOption('--after <path>', 'Humanized text file')
    .option('--register <doc|chat|report>', 'Register to judge against (default: doc)', 'doc')
    .option('--attempt <n>', 'Which humanize attempt this is (default: 1)', '1')
    .option('--json', 'Emit the full report as JSON')
    .action(
      (options: {
        before: string;
        after: string;
        register?: string;
        attempt?: string;
        json?: boolean;
      }) => {
        humanizeCheckCommand(options);
      },
    );

  program
    .command('explain-check')
    .description('설명본이 그 대상에게 읽히는 글인지 판정한다 (exit 0 통과 / 1 경고 / 2 중단)')
    .requiredOption('--source <path>', '설명하려는 원문 파일')
    .requiredOption('--explain <path>', '설명본 파일')
    // 기본값을 여기 안 적는다. commander 가 채우면 audience.ts 의 DEFAULT_AUDIENCE 가
    // CLI 경로에서 죽은 코드가 되고 기본값이 두 자리로 갈린다
    .option('--audience <nontech|junior|peer|manager|exec|outsider>', '누가 읽는지 (기본 peer)')
    .option('--judge', '사실 정확도 축을 심판 모델에게 맡긴다 (나머지 여섯 축은 항상 코드가 잰다)')
    .option('--attempt <n>', '몇 번째 설명본인지 (기본 1)', '1')
    .option('--json', '판정 결과를 JSON으로')
    .action(
      async (options: {
        source: string;
        explain: string;
        audience?: string;
        judge?: boolean;
        attempt?: string;
        json?: boolean;
      }) => {
        await explainCheckCommand(options);
      },
    );

  program
    .command('explain-eval')
    .description('설명 프롬프트 두 벌을 같은 케이스로 돌려 항목별 통과율을 비교한다')
    .requiredOption('--a <path>', '기준이 되는 AGENT.md')
    .option('--b <path>', '비교할 AGENT.md. 비우면 에이전트 없이 돌린 베이스라인과 비교한다')
    .option('--cases <path>', `케이스 파일 (기본 ${DEFAULT_CASES_PATH})`)
    .option('--json', '결과를 JSON으로')
    .action(async (options: { a: string; b?: string; cases?: string; json?: boolean }) => {
      await explainEvalCommand(options);
    });

  program
    .command('usage-report')
    .description('Show event frequency report grouped by event type')
    .action(() => {
      usageReportCommand();
    });

  return program;
}
