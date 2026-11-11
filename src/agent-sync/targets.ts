import { realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentSyncConfig } from './config.js';
import { isInside } from './paths.js';
import type { ListOrcaAccounts, OrcaAccount } from './orca.js';

export type HostKind = 'claude' | 'codex';

export interface Target {
  kind: HostKind;
  scope: 'system' | 'account';
  /** 시스템 홈은 `system`, 오르카 계정은 계정 id */
  id: string;
  label: string;
  home: string;
}

export interface SkippedTarget {
  label: string;
  home: string;
  reason: string;
}

export interface TargetDiscovery {
  targets: Target[];
  skipped: SkippedTarget[];
  warnings: string[];
  /**
   * 대상 홈에 더해 허용 범위 안이지만 폴더가 없거나 사용자 설정으로 건너뛴 계정 홈.
   * 되돌리기는 sync 때 대상이었다가 지금 빠진 홈의 기록도 받아야 한다
   */
  knownHomes: Target[];
}

export interface DiscoverOptions {
  home: string;
  config: AgentSyncConfig;
  listOrcaAccounts: ListOrcaAccounts;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function realKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** 오르카 데이터 폴더. 설정값이 먼저고 없으면 Claude 계정 홈(`<data>/claude-profiles/<id>/home`)에서 거슬러 올라간다 */
function orcaDataDir(home: string, config: AgentSyncConfig, accounts: OrcaAccount[]): string {
  if (config.orcaDataDir) return config.orcaDataDir;
  const claudeHome = accounts.find((a) => a.kind === 'claude' && a.home)?.home;
  if (claudeHome) return dirname(dirname(dirname(claudeHome)));
  return join(home, 'Library', 'Application Support', 'orca');
}

function hostName(kind: HostKind): string {
  return kind === 'claude' ? 'Claude' : 'Codex';
}

export function discoverTargets(opts: DiscoverOptions): TargetDiscovery {
  const { home, config } = opts;
  const listing = opts.listOrcaAccounts();
  const warnings = listing.warning ? [listing.warning] : [];
  const targets: Target[] = [];
  const skipped: SkippedTarget[] = [];
  const knownHomes: Target[] = [];
  const seen = new Set<string>();

  const add = (t: Target) => {
    knownHomes.push(t);
    if (!isDir(t.home)) {
      skipped.push({ label: t.label, home: t.home, reason: '폴더가 없어요' });
      return;
    }
    const key = `${t.kind}:${realKey(t.home)}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(t);
  };

  add({
    kind: 'claude',
    scope: 'system',
    id: 'system',
    label: 'Claude 시스템',
    home: join(home, '.claude'),
  });
  add({
    kind: 'codex',
    scope: 'system',
    id: 'system',
    label: 'Codex 시스템',
    home: join(home, '.codex'),
  });

  const dataDir = orcaDataDir(home, config, listing.accounts);
  // 오르카가 엉뚱한 홈을 알려줘도 그 밖에는 손대지 않는다
  const allowedRoot = config.orcaDataDir ?? home;
  for (const account of listing.accounts) {
    const userEntry = config.accounts[account.id];
    const name = userEntry?.label ?? account.label ?? account.id.slice(0, 8);
    const label = `${hostName(account.kind)} 계정 ${name}`;
    const accountHome =
      account.home ??
      (account.kind === 'codex' ? join(dataDir, 'codex-accounts', account.id, 'home') : undefined);
    if (!accountHome) {
      skipped.push({ label, home: '', reason: '오르카가 계정 홈을 알려주지 않았어요' });
      continue;
    }
    if (!isInside(allowedRoot, accountHome)) {
      skipped.push({
        label,
        home: accountHome,
        reason: config.orcaDataDir
          ? '계정 홈이 orcaDataDir 밖이에요'
          : '계정 홈이 사용자 홈 밖이에요. 오르카 데이터 폴더가 홈 밖이면 orcaDataDir를 설정해 주세요',
      });
      continue;
    }
    if (userEntry?.skip) {
      knownHomes.push({
        kind: account.kind,
        scope: 'account',
        id: account.id,
        label,
        home: accountHome,
      });
      skipped.push({ label, home: accountHome, reason: '사용자 설정에서 제외했어요' });
      continue;
    }
    add({ kind: account.kind, scope: 'account', id: account.id, label, home: accountHome });
  }

  return { targets, skipped, warnings, knownHomes };
}
