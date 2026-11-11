import { realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentSyncConfig } from './config.js';
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
  const seen = new Set<string>();

  const add = (t: Target) => {
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
    if (userEntry?.skip) {
      skipped.push({ label, home: accountHome, reason: '사용자 설정에서 제외했어요' });
      continue;
    }
    add({ kind: account.kind, scope: 'account', id: account.id, label, home: accountHome });
  }

  return { targets, skipped, warnings };
}
