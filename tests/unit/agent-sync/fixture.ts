import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadAgentSyncConfig, type AgentSyncConfig } from '../../../src/agent-sync/config.js';
import type { ListOrcaAccounts, OrcaListing } from '../../../src/agent-sync/orca.js';
import { discoverTargets, type TargetDiscovery } from '../../../src/agent-sync/targets.js';

/**
 * 임시 홈 하나. `HOME`과 `GESTALT_HOME`을 같이 돌려서 `~/.gestalt`도 이 안에 생긴다.
 * 계정 이름은 공개 레포라 전부 가짜 값을 쓴다.
 */
export interface Fixture {
  root: string;
  home: string;
  orcaData: string;
  claudeA: string;
  claudeB: string;
  codexX: string;
  listing: OrcaListing;
  listOrca: ListOrcaAccounts;
  write(rel: string, content: string): string;
  link(rel: string, target: string): string;
  writeConfig(config: unknown): void;
  config(): AgentSyncConfig;
  discover(): TargetDiscovery;
  restore(): void;
}

export const CLAUDE_ONLY_MARK = '[claude-only]';

export const SYSTEM_CLAUDE_MD = [
  '# 공용 규칙',
  '',
  '[Tone] 한국어로 답한다',
  `[Hooks] ${CLAUDE_ONLY_MARK} 훅은 Claude에서만 돈다`,
  '@~/.claude/extra.md',
  '',
  '```',
  `${CLAUDE_ONLY_MARK} 코드 블록 안이라 그대로 공용`,
  '```',
  '',
].join('\n');

export function makeFixture(): Fixture {
  const root = resolve('.gestalt-test', `agent-sync-${randomUUID()}`);
  const home = join(root, 'home');
  const orcaData = join(home, 'orca-data');
  const claudeA = join(orcaData, 'claude-profiles', 'acct-a', 'home');
  const claudeB = join(orcaData, 'claude-profiles', 'acct-b', 'home');
  const codexX = join(orcaData, 'codex-accounts', 'cx-1', 'home');
  mkdirSync(home, { recursive: true });

  const saved = { HOME: process.env['HOME'], GESTALT_HOME: process.env['GESTALT_HOME'] };
  process.env['HOME'] = home;
  process.env['GESTALT_HOME'] = home;

  const listing: OrcaListing = {
    accounts: [
      { kind: 'claude', id: 'acct-a', home: claudeA, label: 'org-a' },
      { kind: 'claude', id: 'acct-b', home: claudeB, label: 'org-b' },
      { kind: 'codex', id: 'cx-1', label: 'ws-x' },
    ],
  };

  const write = (rel: string, content: string) => {
    const path = join(home, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  const link = (rel: string, target: string) => {
    const path = join(home, rel);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
    return path;
  };

  return {
    root,
    home,
    orcaData,
    claudeA,
    claudeB,
    codexX,
    listing,
    listOrca: () => listing,
    write,
    link,
    writeConfig: (config) => write('.gestalt/agent-sync.json', JSON.stringify(config)),
    config: () => loadAgentSyncConfig(),
    discover: () =>
      discoverTargets({ home, config: loadAgentSyncConfig(), listOrcaAccounts: () => listing }),
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 첫 설정 전의 흔한 모습. 시스템 홈엔 실제 스킬 폴더와 CLAUDE.md, 계정 홈은 제각각이다 */
export function seedFirstSetup(f: Fixture): void {
  f.writeConfig({ rules: { claudeOnly: [CLAUDE_ONLY_MARK] } });
  f.write('.claude/CLAUDE.md', SYSTEM_CLAUDE_MD);
  f.write('.claude/skills/alpha/SKILL.md', '# alpha\n');
  f.write('.claude/skills/dup/SKILL.md', '# dup from claude\n');
  f.write('.claude/skills/.trash/old/SKILL.md', '# old\n');
  f.write('.claude/skills/synced/notes.md', 'no SKILL.md here\n');
  f.write('.agents/skills/dup/SKILL.md', '# dup from source\n');
  f.write('.codex/AGENTS.md', '# codex 전용으로 쓰던 규칙\n');

  f.write('.claude/settings.json', '{"theme":"dark"}\n');
  f.write('.claude.json', '{"mcpServers":{}}\n');
  f.write('.mcp.json', '{"mcpServers":{"x":{}}}\n');
  f.write('.codex/config.toml', 'model = "x"\n');

  const rel = (p: string) => relative(f.home, p);
  f.write(join(rel(f.claudeA), 'skills/beta/SKILL.md'), '# beta\n');
  f.write(join(rel(f.claudeA), 'CLAUDE.md'), '# 계정 A 규칙\n');
  f.write(join(rel(f.claudeA), 'settings.json'), '{"a":1}\n');
  mkdirSync(f.claudeB, { recursive: true });
  f.write(join(rel(f.codexX), 'AGENTS.md'), '# 계정 Codex 규칙\n');
}

export type Snapshot = Record<string, string>;

/** 홈 아래 전부를 종류와 내용 해시, 링크 대상으로 적는다. `~/.gestalt`는 실행 기록이라 뺀다 */
export function snapshot(home: string): Snapshot {
  const out: Snapshot = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(home, path);
      if (rel === '.gestalt') continue;
      const st = lstatSync(path);
      if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(path)}`;
      else if (st.isDirectory()) {
        out[rel] = 'dir';
        walk(path);
      } else out[rel] = `file:${hashFile(path)}`;
    }
  };
  walk(home);
  return out;
}

export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function linkOf(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return null;
  }
}
