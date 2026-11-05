import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export type Failure =
  | 'prerequisite'
  | 'auth'
  | 'inference'
  | 'timeout'
  | 'output-limit'
  | 'evidence';
export class E2EFailure extends Error {
  constructor(
    readonly reason: Failure,
    readonly checkpoint?: string,
  ) {
    super(reason);
  }
}
export const optedIn = (env: NodeJS.ProcessEnv): boolean => env.GESTALT_CODEX_E2E === '1';
export function timeoutMs(value?: string): number {
  const n = value === undefined ? 180_000 : Number(value);
  if (!Number.isInteger(n) || n < 1000 || n > 600_000) throw new E2EFailure('prerequisite');
  return n;
}

// Never persist or print raw CLI events, stderr, environment, or caught error messages.
// A process group includes Codex's stdio MCP children, even after the leader exits.
export async function runBounded(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    input?: string;
    maxBytes?: number;
  },
): Promise<{ code: number | null; stdout: string }> {
  if (process.platform === 'win32') throw new E2EFailure('prerequisite');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    const decoder = new StringDecoder('utf8');
    let bytes = 0;
    let failure: Failure | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* already gone */
        }
      }
    };
    const stop = (reason: Failure) => {
      failure ??= reason;
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 1000);
    };
    const timer = setTimeout(() => stop('timeout'), options.timeout);
    const interrupted = () => stop('inference');
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      kill('SIGKILL');
      process.removeListener('SIGINT', interrupted);
      process.removeListener('SIGTERM', interrupted);
    };
    const collect = (chunk: Buffer, capture: boolean) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 8 * 1024 * 1024)) stop('output-limit');
      else if (capture) stdout += decoder.write(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, false));
    child.stdin.on('error', () => {
      /* child can exit before consuming the prompt */
    });
    child.once('error', () => {
      cleanup();
      reject(new E2EFailure('prerequisite'));
    });
    child.once('exit', () => kill('SIGKILL'));
    child.once('close', (code) => {
      stdout += decoder.end();
      cleanup();
      if (failure) reject(new E2EFailure(failure));
      else resolve({ code, stdout });
    });
    child.stdin.end(options.input ?? '');
  });
}

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj =>
  value !== null && typeof value === 'object' ? (value as Obj) : {};
function toolReply(item: Obj): Obj {
  const result = object(item.result);
  if (result.isError) return {};
  const content = result.content;
  if (!Array.isArray(content)) return {};
  for (const entry of content) {
    const text = object(entry).text;
    if (typeof text === 'string') {
      try {
        return object(JSON.parse(text));
      } catch {
        /* non-JSON content */
      }
    }
  }
  return {};
}
export interface Evidence {
  skillRead: boolean;
  turnCompleted: boolean;
  sessionId: string;
  calls: number;
  persistedEvents: number;
}
export function judgeEvidence(
  stdout: string,
  skill: string,
  skillSource: string,
  dbPath: string,
): Evidence {
  const events: Obj[] = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    try {
      events.push(object(JSON.parse(line)));
    } catch {
      throw new E2EFailure('evidence');
    }
  }
  const completed = events.filter((e) => e.type === 'item.completed').map((e) => object(e.item));
  const skillRead = completed.some(
    (i) =>
      i.type === 'command_execution' &&
      i.exit_code === 0 &&
      typeof i.command === 'string' &&
      i.command.includes(skill) &&
      typeof i.aggregated_output === 'string' &&
      i.aggregated_output.includes(skillSource.trim()),
  );
  const turnCompleted =
    events.some((e) => e.type === 'turn.completed' && Number(object(e.usage).output_tokens) > 0) &&
    !events.some((e) => e.type === 'error' || e.type === 'turn.failed');
  const calls = completed.filter(
    (i) =>
      i.type === 'mcp_tool_call' && i.server === 'gestalt' && i.status === 'completed' && !i.error,
  );
  if (
    calls.some(
      (i) =>
        i.tool === 'ges_interview' &&
        (!['start', 'respond'].includes(String(object(i.arguments).action)) ||
          ['resolutionScore', 'rescore', 'rescoreMode'].some((key) => key in object(i.arguments))),
    )
  )
    throw new E2EFailure('evidence', 'unexpected-action');
  const started = calls.find(
    (i) =>
      i.tool === 'ges_interview' &&
      object(i.arguments).action === 'start' &&
      toolReply(i).status === 'started',
  );
  const sessionId = toolReply(started ?? {}).sessionId;
  if (!skillRead) throw new E2EFailure('evidence', 'skill-read');
  if (!turnCompleted) throw new E2EFailure('evidence', 'turn');
  if (typeof sessionId !== 'string')
    throw new E2EFailure('evidence', calls.length ? 'session-start' : 'mcp-calls');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId))
    throw new E2EFailure('evidence', 'session-id');
  if (!existsSync(dbPath)) throw new E2EFailure('evidence', 'database');
  const responded = calls.some(
    (i) =>
      i.tool === 'ges_interview' &&
      object(i.arguments).action === 'respond' &&
      object(i.arguments).sessionId === sessionId &&
      toolReply(i).status === 'in_progress',
  );
  const inspected = calls.some(
    (i) =>
      i.tool === 'ges_status' &&
      object(i.arguments).sessionId === sessionId &&
      object(toolReply(i).session).sessionId === sessionId &&
      object(toolReply(i).session).answeredRounds === 1,
  );
  if (!responded || !inspected)
    throw new E2EFailure('evidence', responded ? 'session-inspect' : 'session-response');
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        'SELECT event_type, payload FROM events WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY rowid',
      )
      .all('interview', sessionId) as Array<{ event_type: string; payload: string }>;
    const types = rows.map((row) => row.event_type);
    const answers = rows.filter((row) => row.event_type === 'interview.response.recorded');
    if (
      !types.includes('interview.session.started') ||
      !types.includes('interview.question.asked') ||
      answers.length !== 1 ||
      object(JSON.parse(answers[0]!.payload)).response !== 'Each note has a title and a body.' ||
      types.includes('interview.session.completed') ||
      types.includes('interview.session.aborted') ||
      types.some((type) => type.startsWith('interview.resolution.'))
    )
      throw new E2EFailure('evidence');
    return {
      skillRead,
      turnCompleted,
      sessionId,
      calls: calls.length,
      persistedEvents: rows.length,
    };
  } catch (error) {
    if (error instanceof E2EFailure) throw error;
    throw new E2EFailure('evidence', 'database');
  } finally {
    db?.close();
  }
}

export async function runE2E(
  root: string,
  env = process.env,
): Promise<{
  status: 'skipped' | 'passed';
  loading: 'explicit-file-assets';
  version?: string;
  evidence?: Evidence;
}> {
  if (!optedIn(env)) return { status: 'skipped', loading: 'explicit-file-assets' };
  if (Number(process.versions.node.split('.')[0]) < 22) throw new E2EFailure('prerequisite');
  const timeout = timeoutMs(env.GESTALT_CODEX_E2E_TIMEOUT_MS);
  const cli = env.GESTALT_CODEX_E2E_BIN || 'codex';
  // Keep the existing credential location; do not inspect, copy, or print credentials.
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'CODEX_HOME',
    'CODEX_API_KEY',
    'OPENAI_API_KEY',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
  ]) {
    if (env[key] !== undefined) childEnv[key] = env[key];
  }
  const probe = async (args: string[]) =>
    runBounded(cli, args, { cwd: root, env: childEnv, timeout: 15000, maxBytes: 128 * 1024 });
  const version = await probe(['--version']);
  const help = await probe(['exec', '--help']);
  const globalHelp = await probe(['--help']);
  if (
    version.code !== 0 ||
    !/^codex-cli [0-9][a-zA-Z0-9.+-]{0,39}\s*$/.test(version.stdout) ||
    help.code !== 0 ||
    globalHelp.code !== 0 ||
    !['--ignore-user-config', '--ephemeral', '--json', '--sandbox'].every((flag) =>
      help.stdout.includes(flag),
    ) ||
    !globalHelp.stdout.includes('--no-daemon')
  )
    throw new E2EFailure('prerequisite');
  const auth = await probe(['login', 'status']);
  if (auth.code !== 0 && !childEnv.CODEX_API_KEY) throw new E2EFailure('auth');
  const fixture = mkdtempSync(join(tmpdir(), 'gestalt-codex-llm-'));
  try {
    const installed = join(fixture, 'plugin');
    cpSync(join(root, 'plugin'), installed, { recursive: true });
    const project = join(fixture, 'project');
    mkdirSync(project);
    const dbPath = join(fixture, 'events.db');
    const skill = join(installed, 'skills/interview/SKILL.md');
    const skillSource = readFileSync(skill, 'utf8');
    writeFileSync(
      join(project, 'AGENTS.md'),
      `This is an isolated interview fixture. Before acting, use /bin/cat to read the full skill at ${skill} and its mandatory host runtime references. Use only the gestalt MCP server for workflow state. Do not read environment variables, credential files, or any other home directory assets. Do not run plugin CLI launchers or install anything. No delegation.\n`,
    );
    // Configure MCP with env -i and a fixture HOME using only the explicit environment below.
    const mcpEnv: Record<string, string> = {
      PATH: env.PATH ?? '',
      HOME: join(fixture, 'home'),
      GESTALT_HOME: join(fixture, 'home'),
      GESTALT_DB_PATH: dbPath,
      GESTALT_NO_UPDATE_CHECK: '1',
      GESTALT_NOTIFICATIONS: 'false',
      GESTALT_CLIENT: 'codex',
    };
    for (const [key, dir] of [
      ['SKILLS', 'skills'],
      ['AGENTS', 'agents'],
      ['ROLE_AGENTS', 'role-agents'],
      ['REVIEW_AGENTS', 'review-agents'],
      ['PERSONAS', 'personas'],
      ['RESEARCH_SOURCES', 'research-sources'],
    ]) {
      mcpEnv[`GESTALT_${key}_DIR`] = join(installed, dir!);
    }
    const server = {
      command: '/usr/bin/env',
      args: [
        '-i',
        ...Object.entries(mcpEnv).map(([key, value]) => `${key}=${value}`),
        process.execPath,
        '--import',
        join(root, 'node_modules/tsx/dist/loader.mjs'),
        join(root, 'bin/gestalt.ts'),
        'serve',
      ],
      cwd: project,
      required: true,
      startup_timeout_sec: 30,
      tool_timeout_sec: 30,
      enabled_tools: ['ges_status', 'ges_interview'],
      default_tools_approval_mode: 'approve',
    };
    // JSON string values/arrays are valid TOML values. Serialize the inline table explicitly.
    const tomlServer = `{ ${Object.entries(server)
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
      .join(', ')} }`;
    const args = [
      '--no-daemon',
      '-a',
      'never',
      'exec',
      '--ignore-user-config',
      '--ephemeral',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-C',
      project,
      '-c',
      `mcp_servers.gestalt=${tomlServer}`,
      '-c',
      'shell_environment_policy.inherit="none"',
    ];
    if (env.GESTALT_CODEX_E2E_MODEL) args.push('--model', env.GESTALT_CODEX_E2E_MODEL);
    args.push('-');
    const result = await runBounded(cli, args, {
      cwd: project,
      env: childEnv,
      timeout,
      input: readFileSync(join(root, 'tests/fixtures/codex-e2e/goal.md'), 'utf8'),
    });
    if (result.code !== 0) throw new E2EFailure('inference');
    const evidence = judgeEvidence(result.stdout, skill, skillSource, dbPath);
    return {
      status: 'passed',
      loading: 'explicit-file-assets',
      version: version.stdout.trim(),
      evidence,
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
