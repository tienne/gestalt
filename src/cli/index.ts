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
import { explainCheckCommand } from './commands/explain-check.js';
import { DEFAULT_CASES_PATH, explainEvalCommand } from './commands/explain-eval.js';
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

  program
    .command('humanize-scan')
    .description('원문에서 실제로 걸린 S1 룰만 처방과 함께 추린다 (exit 0 걸림 / 10 없음)')
    .requiredOption('--file <path>', '스캔할 텍스트 파일')
    .option('--register <doc|chat|report>', '어느 말투 기준으로 볼지 (기본 doc)', 'doc')
    .option('--json', '스캔 결과를 JSON으로')
    .action((options: { file: string; register?: string; json?: boolean }) => {
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
    .option(
      '--audience <nontech|junior|peer|manager|exec|outsider>',
      '누가 읽는지 (기본 peer)',
      'peer',
    )
    .option('--judge', '사실 정확도 축을 심판 모델에게 맡긴다 (나머지 다섯 축은 항상 코드가 잰다)')
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
