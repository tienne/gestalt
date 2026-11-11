import {
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { AgentSyncConfig } from './config.js';
import { lstatOrNull, linkTargetOf, movePath, pathExists, samePath } from './fs-ops.js';
import { inspectTargets, type InspectedSlot } from './inspect.js';
import { SOURCE_IMPORT_LINE, sourcePaths, tildify, type SourcePaths } from './paths.js';
import { pruneRuns, RunWriter } from './run-store.js';
import type { Target } from './targets.js';

/** 계획 한 줄. dry-run은 `summary`만 보여주고 실제 실행은 `apply`를 부른다 */
export interface PlanStep {
  summary: string;
  apply(run: RunWriter): void;
}

export interface Plan {
  steps: PlanStep[];
  hints: string[];
}

export interface PlanContext {
  home: string;
  src: SourcePaths;
  t: (path: string) => string;
}

export function planContext(home: string): PlanContext {
  return { home, src: sourcePaths(home), t: (p) => tildify(p, home) };
}

// ---- 한 동작씩. 바꾸고 나서 바로 기록해 중간에 멈춰도 거기까지는 되돌릴 수 있다 ----

export function ensureDir(run: RunWriter, path: string): void {
  if (lstatOrNull(path)) return;
  ensureDir(run, dirname(path));
  mkdirSync(path);
  run.log({ op: 'mkdir', path });
}

/** 자리에 뭔가 있으면 백업으로 치우고 링크를 건다 */
export function placeLink(run: RunWriter, path: string, target: string): void {
  if (lstatOrNull(path)) {
    const backup = run.moveToBackup(path);
    run.log({ op: 'stash', path, backup });
  }
  symlinkSync(target, path);
  run.log({ op: 'create_link', path, target });
}

export function placeFile(run: RunWriter, path: string, content: string): void {
  if (lstatOrNull(path)) {
    const backup = run.moveToBackup(path);
    run.log({ op: 'stash', path, backup });
  }
  writeFileSync(path, content, { flag: 'wx' });
  run.log({ op: 'create_file', path });
}

/** 있는 파일 내용을 바꾼다. 원래 내용은 백업에 복사해 두고 나서 쓴다 */
export function rewriteFile(run: RunWriter, path: string, content: string): void {
  const backup = run.copyToBackup(path);
  run.log({ op: 'write_file', path, backup });
  writeFileSync(path, content);
}

/** 상대 링크는 옮기면 엉뚱한 곳을 가리키니 옮긴 뒤 절대 경로로 다시 건다 */
function moveEntry(run: RunWriter, from: string, to: string): void {
  const st = lstatOrNull(from);
  const relLink =
    st?.isSymbolicLink() && !isAbsolute(readlinkSync(from)) ? linkTargetOf(from) : null;
  movePath(from, to);
  run.log({ op: 'move', from, to });
  if (relLink) {
    unlinkSync(to);
    symlinkSync(relLink, to);
  }
}

// ---- 규칙 나누기 ----

export interface SplitRules {
  shared: string;
  kept: string[];
}

const FENCE = /^\s*(```|~~~)/;

/**
 * CLAUDE.md를 공용 규칙과 Claude 쪽에 남길 줄로 나눈다.
 * 코드 블록 밖의 `@` 가져오기 줄과 `claudeOnly`에 걸리는 줄이 Claude 쪽에 남고 나머지는 전부 공용이다.
 */
export function splitClaudeRules(content: string, claudeOnly: string[]): SplitRules {
  const shared: string[] = [];
  const kept: string[] = [];
  let inFence = false;
  for (const line of content.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      shared.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!inFence && trimmed === SOURCE_IMPORT_LINE) continue;
    if (!inFence && (trimmed.startsWith('@') || claudeOnly.some((s) => line.includes(s)))) {
      kept.push(line);
      continue;
    }
    shared.push(line);
  }
  const body = shared.join('\n').trim();
  return { shared: body ? `${body}\n` : '', kept };
}

export function claudeRulesWithImport(kept: string[]): string {
  return `${[SOURCE_IMPORT_LINE, ...(kept.length > 0 ? ['', ...kept] : [])].join('\n')}\n`;
}

export function withImportLine(content: string, line: string): string {
  return content.trim() ? `${line}\n\n${content}` : `${line}\n`;
}

// ---- 자리 하나 고치기. sync와 doctor --fix가 같이 쓴다 ----

export interface SlotFixOptions {
  /** sync는 실제 skills 폴더의 항목을 원본으로 옮긴다. doctor는 폴더째 백업만 한다 */
  mergeSkills: boolean;
  /** 옮길 때 이름이 겹치는지 보려고 원본에 있게 될 이름을 모은다 */
  sourceNames: Set<string>;
  /** 내용이 이미 원본으로 가는 자리. 링크가 여기를 가리켰으면 '옮기지 않았다'고 알리지 않는다 */
  handledPaths: string[];
}

export function fixSlotSteps(slot: InspectedSlot, ctx: PlanContext, opts: SlotFixOptions): Plan {
  const { t } = ctx;
  const label = slot.target.label;
  const st = slot.status;
  const steps: PlanStep[] = [];
  const hints: string[] = [];

  if (st.state === 'ok') return { steps, hints };

  if (slot.mode === 'import') {
    if (st.state === 'missing') {
      steps.push({
        summary: `${label}: ${t(slot.path)}를 만들고 ${slot.importLine} 줄을 넣음`,
        apply: (run) => placeFile(run, slot.path, `${slot.importLine}\n`),
      });
    } else if (st.state === 'missing_import') {
      steps.push({
        summary: `${label}: ${t(slot.path)} 맨 위에 ${slot.importLine} 줄을 넣음`,
        apply: (run) =>
          rewriteFile(
            run,
            slot.path,
            withImportLine(readFileSync(slot.path, 'utf-8'), slot.importLine),
          ),
      });
    } else if (st.state === 'wrong_target' && lstatOrNull(realpathSync(slot.path))?.isFile()) {
      // 링크가 가리키는 파일은 다른 호스트 것일 수 있어 건드리지 않는다. 내용을 가져와 이 자리에 새 파일로 둔다
      const realFile = realpathSync(slot.path);
      steps.push({
        summary: `${label}: ${t(slot.path)} 링크를 백업하고 ${t(realFile)} 내용 위에 ${slot.importLine} 줄을 얹은 파일로 바꿈`,
        apply: (run) =>
          placeFile(
            run,
            slot.path,
            withImportLine(readFileSync(realFile, 'utf-8'), slot.importLine),
          ),
      });
    } else {
      steps.push({
        summary: `${label}: ${t(slot.path)}를 백업하고 ${slot.importLine} 줄만 든 파일로 바꿈`,
        apply: (run) => placeFile(run, slot.path, `${slot.importLine}\n`),
      });
    }
    return { steps, hints };
  }

  const to = t(slot.linkTo);
  if (st.state === 'missing') {
    steps.push({
      summary: `${label}: ${t(slot.path)} → ${to} 링크를 만듦`,
      apply: (run) => placeLink(run, slot.path, slot.linkTo),
    });
    return { steps, hints };
  }

  if (st.state === 'replaced_by_file' && st.isDir && slot.name === 'skills' && opts.mergeSkills) {
    const entries = readdirSync(slot.path).sort();
    const moves: string[] = [];
    const stashes: string[] = [];
    for (const name of entries) {
      if (opts.sourceNames.has(name)) stashes.push(name);
      else {
        moves.push(name);
        opts.sourceNames.add(name);
      }
    }
    if (moves.length > 0) {
      steps.push({
        summary: `${label}: ${t(slot.path)}의 항목 ${moves.length}개를 ${to}로 옮김 (${moves.join(', ')})`,
        apply: (run) => {
          for (const name of moves) moveEntry(run, join(slot.path, name), join(slot.linkTo, name));
        },
      });
    }
    if (stashes.length > 0) {
      // 겹친 항목은 그 자리에 두고 아래 링크 걸기에서 폴더째 백업한다. 따로 치우면 같은 백업 자리를 두 번 쓴다
      hints.push(
        `${label}: 원본에 이미 있는 ${stashes.join(', ')}는 원본을 남겼어요. 이쪽 것은 백업 폴더에만 있으니 필요하면 꺼내 원본에 직접 합쳐 주세요`,
      );
    }
    steps.push({
      summary:
        stashes.length > 0
          ? `${label}: 원본에 이미 있는 ${stashes.length}개(${stashes.join(', ')})만 남은 ${t(slot.path)}를 백업하고 ${to} 링크로 바꿈`
          : `${label}: 빈 ${t(slot.path)}를 ${to} 링크로 바꿈`,
      apply: (run) => placeLink(run, slot.path, slot.linkTo),
    });
    return { steps, hints };
  }

  if (st.state === 'replaced_by_file' && st.isDir && slot.name === 'skills') {
    const extra = readdirSync(slot.path).filter((n) => !pathExists(join(slot.linkTo, n)));
    if (extra.length > 0) {
      hints.push(
        `${label}: 원본에 없는 ${extra.join(', ')}는 백업 폴더에만 있어요. 필요하면 ${to}로 옮겨 주세요`,
      );
    }
  }
  if (st.state === 'wrong_target' && !opts.handledPaths.some((p) => samePath(p, st.linkTarget))) {
    hints.push(`${label}: ${t(slot.path)}가 가리키던 ${t(st.linkTarget)} 내용은 옮기지 않았어요`);
  }
  if (st.state === 'replaced_by_file' && !st.isDir && slot.name === 'rules') {
    hints.push(
      `${label}: 원래 ${t(slot.path)} 내용은 백업 폴더에만 있어요. 공용으로 쓸 줄이 있으면 원본에 옮겨 주세요`,
    );
  }
  const what =
    st.state === 'broken_link'
      ? '끊긴 링크'
      : st.state === 'wrong_target'
        ? '다른 곳을 가리키는 링크'
        : st.state === 'replaced_by_file' && st.isDir
          ? '실제 폴더'
          : '실제 파일';
  steps.push({
    summary: `${label}: ${what}인 ${t(slot.path)}를 백업하고 ${to} 링크로 바꿈`,
    apply: (run) => placeLink(run, slot.path, slot.linkTo),
  });
  return { steps, hints };
}

// ---- sync 계획 ----

export interface SyncInput {
  home: string;
  targets: Target[];
  config: AgentSyncConfig;
}

interface SourceRulesPlan extends Plan {
  /** 시스템 CLAUDE.md까지 이 단계에서 고쳤는지. 그러면 슬롯 단계에서 다시 손대지 않는다 */
  claudeHandled: boolean;
}

function sourceRulesPlan(
  input: SyncInput,
  ctx: PlanContext,
  systemClaude?: Target,
): SourceRulesPlan {
  const { src, t } = ctx;
  const steps: PlanStep[] = [];
  const hints: string[] = [];
  const needRoot = !lstatOrNull(src.root);
  const mkRoot: PlanStep[] = needRoot
    ? [{ summary: `원본: ${t(src.root)} 폴더를 만듦`, apply: (run) => ensureDir(run, src.root) }]
    : [];

  if (lstatOrNull(src.rulesFile)) return { steps, hints, claudeHandled: false };

  const claudeFile = systemClaude ? join(systemClaude.home, 'CLAUDE.md') : null;
  const realFile = claudeFile && pathExists(claudeFile) ? realpathSync(claudeFile) : null;
  if (!claudeFile || !realFile || !lstatOrNull(realFile)?.isFile()) {
    steps.push(...mkRoot, {
      summary: `원본: 옮길 CLAUDE.md가 없어 빈 ${t(src.rulesFile)}를 만듦`,
      apply: (run) => placeFile(run, src.rulesFile, ''),
    });
    return { steps, hints, claudeHandled: false };
  }

  const split = splitClaudeRules(readFileSync(realFile, 'utf-8'), input.config.rules.claudeOnly);
  const sharedLines = split.shared ? split.shared.trimEnd().split('\n').length : 0;
  const isLink = lstatOrNull(claudeFile)?.isSymbolicLink() ?? false;
  const keptWhat =
    split.kept.length > 0
      ? `${SOURCE_IMPORT_LINE} 줄과 Claude 전용 줄 ${split.kept.length}개`
      : `${SOURCE_IMPORT_LINE} 줄`;
  const where = isLink ? `${t(claudeFile)}가 가리키는 ${t(realFile)}` : t(claudeFile);
  steps.push(
    ...mkRoot,
    {
      summary: `원본: ${where}의 공용 규칙 ${sharedLines}줄로 ${t(src.rulesFile)}를 만듦`,
      apply: (run) => placeFile(run, src.rulesFile, split.shared),
    },
    {
      // 링크면 가리키는 파일은 그대로 두고 링크 자리에 새 파일을 둔다. 그 파일을 다른 호스트가 같이 볼 수 있다
      summary: isLink
        ? `${systemClaude!.label}: ${t(claudeFile)} 링크를 백업하고 ${keptWhat}만 든 파일로 바꿈`
        : `${systemClaude!.label}: ${t(claudeFile)}를 ${keptWhat}로 바꿈`,
      apply: (run) =>
        isLink
          ? placeFile(run, claudeFile, claudeRulesWithImport(split.kept))
          : rewriteFile(run, claudeFile, claudeRulesWithImport(split.kept)),
    },
  );
  if (split.kept.length > 0) {
    hints.push(`Claude 쪽에 남긴 줄: ${split.kept.map((l) => l.trim()).join(' / ')}`);
  }
  return { steps, hints, claudeHandled: true };
}

/** 시스템 홈의 규칙 파일. 이 내용은 원본에 들어가 있거나 원본을 가져오므로 링크가 여기를 가리켰어도 잃는 게 없다 */
export function systemHomeRules(targets: Target[]): string[] {
  return targets
    .filter((x) => x.scope === 'system')
    .map((x) => join(x.home, x.kind === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'));
}

export function planSync(input: SyncInput): Plan {
  const ctx = planContext(input.home);
  const { src, t } = ctx;
  const systemClaude = input.targets.find((x) => x.kind === 'claude' && x.scope === 'system');
  const rules = sourceRulesPlan(input, ctx, systemClaude);
  const steps: PlanStep[] = [...rules.steps];
  const hints: string[] = [...rules.hints];

  if (!lstatOrNull(src.skillsDir)) {
    steps.push({
      summary: `원본: ${t(src.skillsDir)} 폴더를 만듦`,
      apply: (run) => ensureDir(run, src.skillsDir),
    });
  }

  const handledPaths = systemHomeRules(input.targets);
  const sourceNames = new Set(
    lstatOrNull(src.skillsDir)?.isDirectory() ? readdirSync(src.skillsDir) : [],
  );
  for (const slot of inspectTargets(input.targets, src)) {
    // 원본을 처음 만들 때 시스템 CLAUDE.md는 위에서 같이 고쳤다
    if (rules.claudeHandled && slot.target === systemClaude && slot.name === 'rules') continue;
    const fix = fixSlotSteps(slot, ctx, { mergeSkills: true, sourceNames, handledPaths });
    steps.push(...fix.steps);
    hints.push(...fix.hints);
  }
  return { steps, hints };
}

export interface ApplyResult {
  changes: string[];
  hints: string[];
  pruned: string[];
  run?: { runId: string; dir: string; recordFile: string };
}

/** 계획을 실행한다. 중간에 실패하면 거기까지 기록을 남기고 기록 자리를 붙여 다시 던진다 */
export function applyPlan(plan: Plan, run: RunWriter): void {
  for (const step of plan.steps) {
    try {
      step.apply(run);
    } catch (e) {
      run.record.changes.push(`(실패) ${step.summary}`);
      run.save();
      throw new Error(
        `${step.summary} 중에 멈췄어요: ${(e as Error).message}\n여기까지 한 일은 ${run.recordFile}에 있어요`,
        { cause: e },
      );
    }
    run.record.changes.push(step.summary);
    run.save();
  }
}

export interface RunSyncOptions extends SyncInput {
  dryRun: boolean;
  now?: Date;
}

export function runSync(opts: RunSyncOptions): ApplyResult {
  const plan = planSync(opts);
  const changes = plan.steps.map((s) => s.summary);
  if (opts.dryRun || plan.steps.length === 0) return { changes, hints: plan.hints, pruned: [] };
  const now = opts.now ?? new Date();
  const pruned = pruneRuns(now);
  const run = new RunWriter('sync', opts.home, now);
  applyPlan(plan, run);
  return {
    changes,
    hints: plan.hints,
    pruned,
    run: { runId: run.record.runId, dir: run.dir, recordFile: run.recordFile },
  };
}
