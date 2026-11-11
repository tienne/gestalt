import { loadAgentSyncConfig, type AgentSyncConfig } from '../../agent-sync/config.js';
import { runDoctor, type Which } from '../../agent-sync/doctor.js';
import { formatDoctor, formatRevert, formatSync } from '../../agent-sync/format.js';
import {
  defaultListOrcaAccounts,
  resolveOrcaCommand,
  type ListOrcaAccounts,
} from '../../agent-sync/orca.js';
import { userHome } from '../../agent-sync/paths.js';
import { revertSlotPaths, runRevert } from '../../agent-sync/revert.js';
import { runSync } from '../../agent-sync/sync.js';
import { discoverTargets, type TargetDiscovery } from '../../agent-sync/targets.js';

/** 테스트가 오르카 호출과 도구 찾기, 시각을 가짜로 바꾸는 자리 */
export interface AgentSyncDeps {
  listOrcaAccounts?: ListOrcaAccounts;
  which?: Which;
  now?: Date;
}

interface Setup {
  home: string;
  config: AgentSyncConfig;
  discovery: TargetDiscovery;
}

function setup(deps: AgentSyncDeps): Setup {
  const home = userHome();
  const config = loadAgentSyncConfig();
  const list =
    deps.listOrcaAccounts ?? defaultListOrcaAccounts(resolveOrcaCommand(config.orcaCommand));
  return { home, config, discovery: discoverTargets({ home, config, listOrcaAccounts: list }) };
}

/** `--json`을 준 호출자는 stdout을 JSON으로 읽으니 에러도 같은 꼴로 낸다 */
function fail(e: unknown, json: boolean | undefined): void {
  const error = e instanceof Error ? e.message : String(e);
  if (json) console.log(JSON.stringify({ ok: false, error }, null, 2));
  else console.error(error);
  process.exitCode = 1;
}

export interface SyncCommandOptions {
  dryRun?: boolean;
  json?: boolean;
  /** `--revert`만 주면 true, 실행 id를 주면 그 문자열 */
  revert?: string | boolean;
}

export function syncCommand(opts: SyncCommandOptions, deps: AgentSyncDeps = {}): void {
  try {
    const dryRun = opts.dryRun ?? false;
    const { home, config, discovery } = setup(deps);
    if (opts.revert !== undefined && opts.revert !== false) {
      const runId = typeof opts.revert === 'string' ? opts.revert : undefined;
      const result = runRevert({
        home,
        slotPaths: revertSlotPaths(home, discovery.knownHomes),
        discoveryWarnings: discovery.warnings,
        runId,
        dryRun,
        now: deps.now,
      });
      console.log(
        opts.json
          ? JSON.stringify({ ok: true, command: 'revert', dryRun, ...result }, null, 2)
          : formatRevert(home, result, dryRun),
      );
      return;
    }
    const result = runSync({ home, targets: discovery.targets, config, dryRun, now: deps.now });
    if (opts.json) {
      console.log(
        JSON.stringify({ ok: true, command: 'sync', dryRun, ...discovery, ...result }, null, 2),
      );
    } else {
      console.log(formatSync(home, discovery, result, dryRun));
    }
  } catch (e) {
    fail(e, opts.json);
  }
}

export interface DoctorCommandOptions {
  fix?: boolean;
  json?: boolean;
}

/** 남은 문제가 있으면 종료 코드 1. 도구 경고만 있으면 0이다 */
export function doctorCommand(opts: DoctorCommandOptions, deps: AgentSyncDeps = {}): void {
  try {
    const { home, config, discovery } = setup(deps);
    const fix = opts.fix ?? false;
    const result = runDoctor({
      home,
      targets: discovery.targets,
      config,
      fix,
      which: deps.which,
      now: deps.now,
    });
    if (opts.json) {
      console.log(
        JSON.stringify({ ok: true, command: 'doctor', fix, ...discovery, ...result }, null, 2),
      );
    } else {
      console.log(formatDoctor(home, discovery, result, fix));
    }
    if (result.remaining.length > 0) process.exitCode = 1;
  } catch (e) {
    fail(e, opts.json);
  }
}
