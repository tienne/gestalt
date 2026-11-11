import { execFileSync } from 'node:child_process';
import { isAbsolute, resolve, sep } from 'node:path';
import { AgentSyncConfigError } from './config.js';

export interface OrcaAccount {
  kind: 'claude' | 'codex';
  id: string;
  /** 오르카가 알려준 계정 홈. Codex 계정은 비어 있어서 데이터 폴더에서 만든다 */
  home?: string;
  /** 오르카 런타임 정보에서 온 이름. 사용자 설정 label이 있으면 그쪽이 이긴다 */
  label?: string;
}

export interface RejectedAccount {
  kind: 'claude' | 'codex';
  /** 오르카가 준 그대로의 id. 경로에 못 쓰는 글자가 들 수 있다 */
  id: string;
  reason: string;
}

export interface OrcaListing {
  accounts: OrcaAccount[];
  /** 오르카가 알려줬지만 id나 home이 이상해 뺀 계정 */
  rejected?: RejectedAccount[];
  /** orca를 못 불렀거나 출력을 못 읽었을 때. 이때는 시스템 홈만 대상이 된다 */
  warning?: string;
}

export type ListOrcaAccounts = () => OrcaListing;

interface RawAccount {
  id?: unknown;
  home?: unknown;
  organizationName?: unknown;
  workspaceLabel?: unknown;
  managedAuthRuntime?: unknown;
  managedHomeRuntime?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** id는 Codex 계정 홈 경로에 그대로 들어가니 경로를 벗어날 글자를 막는다 */
function safeId(v: unknown): string | undefined {
  const id = str(v);
  return id && SAFE_ID.test(id) && id !== '.' && id !== '..' ? id : undefined;
}

function isCleanAbsolute(p: string): boolean {
  return isAbsolute(p) && resolve(p) === p;
}

interface PickedAccounts {
  accounts: OrcaAccount[];
  rejected: RejectedAccount[];
}

/**
 * 이상한 id를 주거나 home이 절대 경로가 아니거나 `.`, `..`, 끝의 `/`, 겹친 `/`가 든 계정은 뺀다.
 * 그 홈에 링크를 걸고 백업을 옮기게 된다. 뺀 계정은 출력에 이유를 남기려고 따로 모은다
 */
function pickAccounts(kind: 'claude' | 'codex', group: unknown): PickedAccounts {
  const out: PickedAccounts = { accounts: [], rejected: [] };
  const list = (group as { accounts?: unknown } | undefined)?.accounts;
  if (!Array.isArray(list)) return out;
  for (const item of list as RawAccount[]) {
    const rawId = str(item?.id);
    const id = safeId(rawId);
    if (!id) {
      out.rejected.push(
        rawId
          ? { kind, id: rawId, reason: '계정 id에 쓸 수 없는 글자가 있어요' }
          : { kind, id: '', reason: '계정 id가 없어요' },
      );
      continue;
    }
    const home = str(item.home);
    if (home !== undefined && !isCleanAbsolute(home)) {
      out.rejected.push({
        kind,
        id,
        reason: '계정 홈이 절대 경로가 아니거나 `.`, `..`, 끝의 `/`, 겹친 `/`가 들어 있어요',
      });
      continue;
    }
    // WSL 계정 홈은 이 머신 파일 시스템에서 바로 못 건드린다
    const runtime = str(item.managedAuthRuntime) ?? str(item.managedHomeRuntime);
    if (runtime && runtime !== 'host') continue;
    out.accounts.push({
      kind,
      id,
      home,
      label: str(item.organizationName) ?? str(item.workspaceLabel),
    });
  }
  return out;
}

/** `orca account list --json` 출력. 바깥 봉투(`{ ok, result }`)가 있어도 없어도 읽는다 */
export function parseOrcaAccountList(stdout: string): PickedAccounts {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const body = (parsed['result'] ?? parsed) as Record<string, unknown>;
  const claude = pickAccounts('claude', body['claude']);
  const codex = pickAccounts('codex', body['codex']);
  return {
    accounts: [...claude.accounts, ...codex.accounts],
    rejected: [...claude.rejected, ...codex.rejected],
  };
}

/** 절대 경로나 PATH에서 찾을 이름만 받는다. 상대 경로는 어디서 부르느냐에 따라 다른 실행 파일을 돌린다 */
export function resolveOrcaCommand(configured?: string): string {
  const envValue = process.env['ORCA_CLI_COMMAND'] || undefined;
  const command = configured ?? envValue ?? 'orca';
  const from = configured ? '설정 orcaCommand' : envValue ? 'ORCA_CLI_COMMAND' : null;
  const bareName = !command.includes('/') && !command.includes(sep);
  if (from && !isAbsolute(command) && !bareName) {
    throw new AgentSyncConfigError(
      `${from}는 절대 경로나 PATH에서 찾을 이름이어야 해요: ${command}`,
    );
  }
  return command;
}

export function defaultListOrcaAccounts(command: string): ListOrcaAccounts {
  return () => {
    let stdout: string;
    try {
      stdout = execFileSync(command, ['account', 'list', '--json'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const reason = code === 'ENOENT' ? `${command}를 찾지 못했어요` : (e as Error).message;
      return { accounts: [], warning: `오르카 계정 목록을 못 읽어 시스템 홈만 봤어요 (${reason})` };
    }
    try {
      return parseOrcaAccountList(stdout);
    } catch (e) {
      return {
        accounts: [],
        warning: `오르카 계정 목록 출력을 읽지 못해 시스템 홈만 봤어요 (${(e as Error).message})`,
      };
    }
  };
}
