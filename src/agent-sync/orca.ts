import { execFileSync } from 'node:child_process';

export interface OrcaAccount {
  kind: 'claude' | 'codex';
  id: string;
  /** 오르카가 알려준 계정 홈. Codex 계정은 비어 있어서 데이터 폴더에서 만든다 */
  home?: string;
  /** 오르카 런타임 정보에서 온 이름. 사용자 설정 label이 있으면 그쪽이 이긴다 */
  label?: string;
}

export interface OrcaListing {
  accounts: OrcaAccount[];
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

function pickAccounts(kind: 'claude' | 'codex', group: unknown): OrcaAccount[] {
  const list = (group as { accounts?: unknown } | undefined)?.accounts;
  if (!Array.isArray(list)) return [];
  const out: OrcaAccount[] = [];
  for (const item of list as RawAccount[]) {
    const id = str(item?.id);
    if (!id) continue;
    // WSL 계정 홈은 이 머신 파일 시스템에서 바로 못 건드린다
    const runtime = str(item.managedAuthRuntime) ?? str(item.managedHomeRuntime);
    if (runtime && runtime !== 'host') continue;
    out.push({
      kind,
      id,
      home: str(item.home),
      label: str(item.organizationName) ?? str(item.workspaceLabel),
    });
  }
  return out;
}

/** `orca account list --json` 출력. 바깥 봉투(`{ ok, result }`)가 있어도 없어도 읽는다 */
export function parseOrcaAccountList(stdout: string): OrcaAccount[] {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const body = (parsed['result'] ?? parsed) as Record<string, unknown>;
  return [...pickAccounts('claude', body['claude']), ...pickAccounts('codex', body['codex'])];
}

export function resolveOrcaCommand(configured?: string): string {
  return configured ?? process.env['ORCA_CLI_COMMAND'] ?? 'orca';
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
      return { accounts: parseOrcaAccountList(stdout) };
    } catch (e) {
      return {
        accounts: [],
        warning: `오르카 계정 목록 출력을 읽지 못해 시스템 홈만 봤어요 (${(e as Error).message})`,
      };
    }
  };
}
