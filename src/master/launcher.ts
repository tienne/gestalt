import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { handleNeed } from './gates.js';
import { RESUME_MARKER } from './metrics.js';
import type { MasterStore } from './store.js';
import type { Checkpoint, JiraStatus, Order, Worker, WorkerKind } from './types.js';

/**
 * 워커 배치 런처.
 *
 * 워커는 셋이다. 오르카 워크트리와 git 워크트리는 브랜치나 PR로 끝나는 일, 서브에이전트는
 * 읽기 전용으로 짧게 끝나는 일을 맡는다(handoff 스킬의 맡길 곳 표). 워크트리가 필요하면
 * 오르카를 먼저 쓰고 없으면 git 워크트리를 만든다.
 *
 * 서브에이전트와 git 워크트리 세션은 마스터 호스트 세션이 직접 띄운다. Execute Engine이
 * Passthrough라 게슈탈트가 LLM을 부르지 않기 때문이다. 그래서 이 둘은 실행 대신
 * `HostAction`을 돌려주고 마스터 세션이 그대로 수행한다.
 */

/** 이 값이 환경에 있으면 워커 세션이다. 워커는 워커를 못 띄운다 */
export const WORKER_ENV = 'GESTALT_MASTER_WORKER_ID';

export class NestedSpawnRefused extends Error {
  constructor(workerId: string) {
    super(
      `워커(${workerId})는 하위 워커를 띄울 수 없어요. 결과의 spawnRequest로 마스터에 요청을 올려 주세요`,
    );
  }
}

export function assertCanSpawn(env: NodeJS.ProcessEnv = process.env): void {
  const id = env[WORKER_ENV];
  if (id) throw new NestedSpawnRefused(id);
}

export type HostAction =
  | { type: 'spawn-subagent'; workerId: string; promptFile: string }
  | { type: 'open-session'; workerId: string; cwd: string; promptFile: string }
  | { type: 'send'; workerId: string; message: string }
  // 외부 쓰기는 호스트 세션이 MCP로 한다. tick은 무엇을 할지만 돌려준다
  | { type: 'jira-transition'; issueKey: string; to: JiraStatus }
  | { type: 'slack-post'; channel: string; text: string; threadTs?: string };

export interface LaunchSpec {
  order: Order;
  worker: Worker;
  prompt: string;
  /** 재개할 때 앞 워커의 손잡이. git 워크트리는 같은 경로를 다시 쓴다 */
  previousHandle?: string;
}

export interface LaunchResult {
  handle: string;
  hostAction?: HostAction;
}

export interface Launcher {
  readonly kind: WorkerKind;
  start(spec: LaunchSpec): Promise<LaunchResult>;
  /** 도는 워커에 지시를 전한다. 마스터 세션이 대신 전해야 하면 HostAction을 돌려준다 */
  send(worker: Worker, message: string): Promise<HostAction | undefined>;
  /** 끝난 워커의 자원을 정리한다 */
  release(worker: Worker): Promise<void>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<CommandResult>;

export const execRunner: CommandRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts?.cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

async function mustRun(
  runner: CommandRunner,
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  const r = await runner(cmd, args, cwd ? { cwd } : undefined);
  if (r.code !== 0) {
    const head = (r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' ');
    throw new Error(`${cmd} ${args[0] ?? ''} 실패(${r.code}): ${head}`);
  }
  return r.stdout;
}

// ─── 오르카 감지와 워커 종류 고르기 ─────────────────────────────

/**
 * 오르카 CLI 경로를 찾는다. 실행해 보지 않고 환경 변수와 PATH만 본다.
 * tick마다 부르는 자리라 프로세스를 띄우지 않는다.
 */
export function detectOrca(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env['ORCA_CLI_COMMAND'];
  if (configured && existsSync(configured)) return configured;
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'orca'))) return join(dir, 'orca');
  }
  return undefined;
}

/** 서브에이전트로 충분한 스킬. 읽기 전용이고 짧게 끝난다 */
const READ_ONLY_SKILLS: ReadonlySet<string> = new Set([
  'review',
  'blast-radius',
  'diff-radius',
  'explain',
]);

export function chooseWorkerKind(order: Order, opts: { orcaAvailable: boolean }): WorkerKind {
  if (order.workerKind === 'orca-worktree' && !opts.orcaAvailable) return 'git-worktree';
  if (order.workerKind) return order.workerKind;
  if (order.skillChain.every((s) => READ_ONLY_SKILLS.has(s))) return 'subagent';
  return opts.orcaAvailable ? 'orca-worktree' : 'git-worktree';
}

// ─── 워커 프롬프트 ───────────────────────────────────────────────

export interface ResumeContext {
  checkpoint: Checkpoint;
  reason: string;
}

/**
 * 워커에 넘길 지시서. 재개할 때는 첫 줄이 RESUME_MARKER라 지표가 재개 세션을 따로 센다.
 * 재개 지시서에는 체크포인트의 참조만 싣고 앞 워커의 대화나 문서 본문은 다시 싣지 않는다.
 */
export function buildWorkerPrompt(
  order: Order,
  worker: Worker,
  resume?: ResumeContext,
  opts: { stateDir?: string } = {},
): string {
  // 워커는 다른 레포에서 돌아 그쪽 gestalt.json을 읽는다. 마스터와 같은 저장소를 쓰게 경로를 넘긴다
  const at = opts.stateDir ? ` --state-dir ${JSON.stringify(opts.stateDir)}` : '';
  const lines: string[] = [];
  if (resume) lines.push(`${RESUME_MARKER} ${resume.reason}`);
  lines.push(`${WORKER_ENV}=${worker.id}`, '');
  lines.push(`# 주문 ${order.id}: ${order.title}`, '');
  lines.push(`- 레포: ${order.repo}`);
  lines.push(`- 범위: ${order.scope}`);
  lines.push(`- 스킬 체인: ${order.skillChain.join(' → ')}`);
  if (order.issueKey) lines.push(`- 지라: ${order.issueKey}`);
  if (order.prRef) lines.push(`- PR: ${order.prRef}`);
  if (order.description && !resume) lines.push('', order.description);

  if (resume) {
    const cp = resume.checkpoint;
    lines.push('', '## 이어서 할 자리');
    const done = new Set(cp.completedSkills);
    lines.push(`- 끝낸 스킬: ${cp.completedSkills.join(', ') || '없음'} (다시 돌리지 않는다)`);
    lines.push(
      `- 남은 체인: ${order.skillChain.filter((s) => !done.has(s)).join(' → ') || '없음'}`,
    );
    lines.push(`- 돌던 스킬: ${cp.skill}${cp.phase ? ` (단계 ${cp.phase})` : ''}`);
    if (cp.round !== undefined && cp.round !== null) lines.push(`- 라운드: ${cp.round}`);
    lines.push(`- 다음 할 일: ${cp.next}`);
    if (cp.shipDir)
      lines.push(
        `- ship 체크포인트: ${cp.shipDir} (gestalt ship checkpoint check로 먼저 맞춰 본다)`,
      );
    for (const ref of cp.refs) lines.push(`- 참조: ${ref}`);
  }

  lines.push('', '## 규칙');
  lines.push('- 하위 워커를 띄우지 않는다. 더 필요하면 결과의 spawnRequest로 마스터에 올린다.');
  lines.push(
    `- 스킬이나 단계가 바뀔 때마다 \`gestalt master checkpoint save${at} --worker ${worker.id} ...\`로 체크포인트를 남긴다.`,
  );
  lines.push(
    `- 결과는 \`gestalt master worker report${at} --worker ${worker.id}\`로 낸다. 요약과 refs만 싣고 diff나 로그 원문은 파일로 두고 경로만 적는다.`,
  );
  lines.push(
    '- 혼자 못 넘는 자리(승인, 인증, 정리)는 status needs와 need로 올리고 마스터 지시를 기다린다.',
  );
  return `${lines.join('\n')}\n`;
}

function writePrompt(promptDir: string, workerId: string, prompt: string): string {
  mkdirSync(promptDir, { recursive: true });
  const file = join(promptDir, `${workerId}.md`);
  writeFileSync(file, prompt);
  return file;
}

// ─── 런처 구현 ───────────────────────────────────────────────────

export interface OrcaLauncherOptions {
  orcaCommand: string;
  promptDir: string;
  runner?: CommandRunner;
  agent?: string;
  repoPaths?: Record<string, string>;
}

export class OrcaLauncher implements Launcher {
  readonly kind = 'orca-worktree' as const;
  private readonly runner: CommandRunner;
  constructor(private readonly opts: OrcaLauncherOptions) {
    this.runner = opts.runner ?? execRunner;
  }

  async start(spec: LaunchSpec): Promise<LaunchResult> {
    const file = writePrompt(this.opts.promptDir, spec.worker.id, spec.prompt);
    const path = this.opts.repoPaths?.[spec.order.repo];
    const repo = path ? `path:${path}` : `name:${spec.order.repo.split('/')[1]!}`;
    const out = await mustRun(this.runner, this.opts.orcaCommand, [
      'orchestration',
      'worker-start',
      '--spec-file',
      file,
      '--worktree',
      'new-top-level',
      '--agent',
      this.opts.agent ?? 'claude',
      '--repo',
      repo,
      '--name',
      `${spec.order.id}-${spec.worker.attempt}`,
      '--display-name',
      spec.order.title.slice(0, 60),
      '--json',
    ]);
    return { handle: parseDispatchId(out) };
  }

  async send(worker: Worker, message: string): Promise<undefined> {
    if (!worker.handle) throw new Error(`워커 ${worker.id}의 dispatch id가 없어요`);
    await mustRun(this.runner, this.opts.orcaCommand, [
      'orchestration',
      'send',
      '--to',
      `dispatch:${worker.handle}`,
      '--subject',
      `master: ${worker.orderId}`,
      '--body',
      message,
    ]);
    return undefined;
  }

  async release(worker: Worker): Promise<void> {
    if (!worker.handle) return;
    await mustRun(this.runner, this.opts.orcaCommand, [
      'orchestration',
      'worker-release',
      '--dispatch',
      worker.handle,
      '--json',
    ]);
  }
}

/** worker-start --json 응답에서 dispatch id를 꺼낸다. 버전마다 자리가 달라 몇 곳을 본다 */
export function parseDispatchId(stdout: string): string {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error('오르카 worker-start 응답이 JSON이 아니에요');
  }
  const d = data as Record<string, unknown>;
  const nested = (d['dispatch'] ?? d['result']) as Record<string, unknown> | undefined;
  const id = d['dispatchId'] ?? nested?.['dispatchId'] ?? nested?.['id'] ?? d['id'];
  if (typeof id !== 'string' || !id) throw new Error('오르카 응답에 dispatch id가 없어요');
  return id;
}

export interface GitWorktreeLauncherOptions {
  worktreeRoot: string;
  promptDir: string;
  repoPaths: Record<string, string>;
  runner?: CommandRunner;
}

export class GitWorktreeLauncher implements Launcher {
  readonly kind = 'git-worktree' as const;
  private readonly runner: CommandRunner;
  constructor(private readonly opts: GitWorktreeLauncherOptions) {
    this.runner = opts.runner ?? execRunner;
  }

  async start(spec: LaunchSpec): Promise<LaunchResult> {
    const repoPath = this.opts.repoPaths[spec.order.repo];
    if (!repoPath)
      throw new Error(`${spec.order.repo}의 로컬 경로가 없어요. master.repoPaths에 적어 주세요`);
    let cwd = spec.previousHandle;
    if (!cwd || !existsSync(cwd)) {
      cwd = join(this.opts.worktreeRoot, spec.order.id);
      await mustRun(this.runner, 'git', [
        '-C',
        repoPath,
        'worktree',
        'add',
        '-b',
        `master/${spec.order.id}`,
        cwd,
      ]);
    }
    const promptFile = writePrompt(this.opts.promptDir, spec.worker.id, spec.prompt);
    return {
      handle: cwd,
      hostAction: { type: 'open-session', workerId: spec.worker.id, cwd, promptFile },
    };
  }

  async send(worker: Worker, message: string): Promise<HostAction> {
    return { type: 'send', workerId: worker.id, message };
  }

  async release(worker: Worker): Promise<void> {
    if (!worker.handle || !existsSync(worker.handle)) return;
    await mustRun(this.runner, 'git', ['-C', worker.handle, 'worktree', 'remove', worker.handle]);
  }
}

export class SubagentLauncher implements Launcher {
  readonly kind = 'subagent' as const;
  constructor(private readonly opts: { promptDir: string }) {}

  async start(spec: LaunchSpec): Promise<LaunchResult> {
    const promptFile = writePrompt(this.opts.promptDir, spec.worker.id, spec.prompt);
    return {
      handle: `subagent:${spec.worker.id}`,
      hostAction: { type: 'spawn-subagent', workerId: spec.worker.id, promptFile },
    };
  }

  async send(worker: Worker, message: string): Promise<HostAction> {
    return { type: 'send', workerId: worker.id, message };
  }

  async release(): Promise<void> {}
}

export type LauncherSet = Partial<Record<WorkerKind, Launcher>>;

// ─── 계정 확인 ───────────────────────────────────────────────────

/** 레포마다 쓸 인증 계정을 확인하고 바꾸는 어댑터 */
export interface AccountSwitcher {
  current(repo: string): Promise<string | undefined>;
  switchTo(repo: string, account: string): Promise<void>;
}

/**
 * 워커를 띄우기 전에 그 레포의 계정을 맞춘다. 전환은 bypass로 처리하고 기록을 남긴다.
 * 전환이 실패하면 no-procedure 게이트를 열고 false를 돌려준다. 그 주문은 이번에 안 띄운다.
 */
export async function ensureAccount(
  store: MasterStore,
  order: Order,
  accounts: Record<string, string>,
  switcher: AccountSwitcher | undefined,
): Promise<{ ok: boolean; account?: string }> {
  const wanted = accounts[order.repo];
  if (!wanted) return { ok: true };
  if (!switcher) {
    const outcome = await handleNeed(
      store,
      {
        orderId: order.id,
        need: 'account-switch',
        detail: `${order.repo}에 쓸 계정을 맞출 방법이 없어요`,
      },
      {},
    );
    return { ok: outcome.kind === 'bypass' };
  }
  const current = await switcher.current(order.repo).catch(() => undefined);
  if (current === wanted) return { ok: true, account: wanted };
  const outcome = await handleNeed(
    store,
    { orderId: order.id, need: 'account-switch', detail: `${order.repo} 계정 전환` },
    {
      'account-switch': async () => {
        await switcher.switchTo(order.repo, wanted);
        return `${order.repo} 계정을 ${current ?? '미확인'}에서 ${wanted}로 바꿨어요`;
      },
    },
  );
  return outcome.kind === 'bypass' ? { ok: true, account: wanted } : { ok: false };
}
