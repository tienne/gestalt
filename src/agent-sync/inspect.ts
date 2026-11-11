import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { lstatOrNull, linkTargetOf, pathExists, samePath } from './fs-ops.js';
import { SOURCE_IMPORT_LINE, SYSTEM_CLAUDE_IMPORT_LINE, type SourcePaths } from './paths.js';
import type { Target } from './targets.js';

/**
 * 계정 홈 하나에서 원본으로 이어져야 하는 자리.
 * `link`는 심링크여야 하고 `import`는 CLAUDE.md 안에 `@` 가져오기 줄이 있어야 한다.
 */
export interface Slot {
  target: Target;
  name: 'skills' | 'rules';
  path: string;
  mode: 'link' | 'import';
  /** 고칠 때 링크가 가리킬 곳 (link) */
  linkTo: string;
  /** 이미 이쪽을 가리키면 통과 (link). import 모드에선 이 파일로 가는 링크도 통과 */
  acceptLinks: string[];
  /** 고칠 때 넣을 줄 (import) */
  importLine: string;
  acceptImports: string[];
}

export type SlotState =
  | { state: 'ok' }
  | { state: 'missing' }
  | { state: 'broken_link'; linkTarget: string }
  | { state: 'wrong_target'; linkTarget: string }
  | { state: 'replaced_by_file'; isDir: boolean }
  | { state: 'missing_import'; realFile: string };

export interface InspectedSlot extends Slot {
  status: SlotState;
}

export function slotsFor(target: Target, src: SourcePaths): Slot[] {
  const base = { target, linkTo: '', acceptLinks: [], importLine: '', acceptImports: [] };
  if (target.kind === 'claude') {
    const skills: Slot = {
      ...base,
      name: 'skills',
      path: join(target.home, 'skills'),
      mode: 'link',
      linkTo: src.skillsDir,
      acceptLinks: [src.skillsDir],
    };
    const rules: Slot = {
      ...base,
      name: 'rules',
      path: join(target.home, 'CLAUDE.md'),
      mode: 'import',
      importLine: target.scope === 'system' ? SOURCE_IMPORT_LINE : SYSTEM_CLAUDE_IMPORT_LINE,
      acceptImports:
        target.scope === 'system'
          ? [SOURCE_IMPORT_LINE]
          : [SYSTEM_CLAUDE_IMPORT_LINE, SOURCE_IMPORT_LINE],
      acceptLinks: target.scope === 'system' ? [] : [src.rulesFile],
    };
    return [skills, rules];
  }
  return [
    {
      ...base,
      name: 'rules',
      path: join(target.home, 'AGENTS.md'),
      mode: 'link',
      linkTo: src.rulesFile,
      acceptLinks: [src.rulesFile],
    },
  ];
}

/** 시스템 홈 쪽 자리도 통과로 쳐 준다. 계정 홈이 시스템 홈을 거쳐 원본에 닿는 구성이 흔하다 */
export function withSystemAccepts(
  slot: Slot,
  systemHomes: { claude?: string; codex?: string },
): Slot {
  if (slot.target.scope !== 'account') return slot;
  if (slot.target.kind === 'claude' && systemHomes.claude) {
    const extra =
      slot.name === 'skills'
        ? join(systemHomes.claude, 'skills')
        : join(systemHomes.claude, 'CLAUDE.md');
    return { ...slot, acceptLinks: [...slot.acceptLinks, extra] };
  }
  if (slot.target.kind === 'codex' && systemHomes.codex) {
    return { ...slot, acceptLinks: [...slot.acceptLinks, join(systemHomes.codex, 'AGENTS.md')] };
  }
  return slot;
}

function hasImport(content: string, accept: string[]): boolean {
  return content.split('\n').some((line) => accept.includes(line.trim()));
}

export function inspectSlot(slot: Slot): SlotState {
  const st = lstatOrNull(slot.path);
  if (!st) return { state: 'missing' };

  if (st.isSymbolicLink()) {
    const linkTarget = linkTargetOf(slot.path);
    if (!pathExists(slot.path)) return { state: 'broken_link', linkTarget };
    if (slot.acceptLinks.some((a) => samePath(linkTarget, a))) return { state: 'ok' };
    if (slot.mode === 'link') return { state: 'wrong_target', linkTarget };
    // CLAUDE.md가 다른 파일로 가는 링크면 그 파일 내용으로 본다
    const realFile = realpathSync(slot.path);
    if (
      lstatOrNull(realFile)?.isFile() &&
      hasImport(readFileSync(realFile, 'utf-8'), slot.acceptImports)
    ) {
      return { state: 'ok' };
    }
    return { state: 'wrong_target', linkTarget };
  }

  if (slot.mode === 'link') return { state: 'replaced_by_file', isDir: st.isDirectory() };
  if (!st.isFile()) return { state: 'replaced_by_file', isDir: st.isDirectory() };
  if (hasImport(readFileSync(slot.path, 'utf-8'), slot.acceptImports)) return { state: 'ok' };
  return { state: 'missing_import', realFile: slot.path };
}

export function inspectTargets(targets: Target[], src: SourcePaths): InspectedSlot[] {
  const systemHomes = {
    claude: targets.find((t) => t.kind === 'claude' && t.scope === 'system')?.home,
    codex: targets.find((t) => t.kind === 'codex' && t.scope === 'system')?.home,
  };
  const out: InspectedSlot[] = [];
  for (const target of targets) {
    for (const raw of slotsFor(target, src)) {
      const slot = withSystemAccepts(raw, systemHomes);
      out.push({ ...slot, status: inspectSlot(slot) });
    }
  }
  return out;
}

export interface SourceState {
  rulesFile: boolean;
  skillsDir: boolean;
}

export function inspectSource(src: SourcePaths): SourceState {
  return {
    rulesFile: lstatOrNull(src.rulesFile)?.isFile() ?? false,
    skillsDir: lstatOrNull(src.skillsDir)?.isDirectory() ?? false,
  };
}
