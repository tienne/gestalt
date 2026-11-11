import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { toolsFor, type AgentSyncConfig } from './config.js';
import { inspectSource, inspectTargets, type InspectedSlot } from './inspect.js';
import { listRunsNewestFirst, pruneRuns, RunWriter } from './run-store.js';
import { applyPlan, fixSlotSteps, planContext, systemHomeRules, type PlanStep } from './sync.js';
import type { Target } from './targets.js';

export type IssueKind =
  | 'missing_link'
  | 'broken_link'
  | 'wrong_target'
  | 'replaced_by_file'
  | 'missing_import'
  | 'source_missing';

export interface DoctorIssue {
  kind: IssueKind;
  label: string;
  path: string;
  message: string;
  fixable: boolean;
}

export interface ToolWarning {
  label: string;
  tool: string;
  message: string;
}

/** 호스트에서 도구를 찾는다. 테스트는 가짜로 바꾼다 */
export type Which = (tool: string, target: Target) => boolean;

export function defaultWhich(tool: string): boolean {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, tool);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      // 없는 파일이거나 실행 권한이 없으면 PATH의 다음 폴더를 본다. which와 같은 동작이다
    }
  }
  return false;
}

export interface DoctorInput {
  home: string;
  targets: Target[];
  config: AgentSyncConfig;
  fix: boolean;
  which?: Which;
  now?: Date;
}

export interface DoctorResult {
  issues: DoctorIssue[];
  toolWarnings: ToolWarning[];
  fixed: string[];
  hints: string[];
  /** 고친 뒤에도 남은 문제. 고치지 않았으면 issues와 같다 */
  remaining: DoctorIssue[];
  /** 읽지 못한 실행 기록. 종료 코드에는 안 걸린다 */
  recordWarnings: string[];
  pruned: string[];
  run?: { runId: string; dir: string; recordFile: string };
}

function issueKind(slot: InspectedSlot): IssueKind | null {
  const s = slot.status.state;
  if (s === 'ok') return null;
  if (s === 'missing') return slot.mode === 'link' ? 'missing_link' : 'missing_import';
  return s;
}

interface Found {
  issues: DoctorIssue[];
  slots: InspectedSlot[];
}

function findIssues(input: DoctorInput): Found {
  const ctx = planContext(input.home);
  const { src, t } = ctx;
  const source = inspectSource(src);
  const issues: DoctorIssue[] = [];
  const slots: InspectedSlot[] = [];

  if (!source.rulesFile) {
    issues.push({
      kind: 'source_missing',
      label: '~/.agents',
      path: src.rulesFile,
      message: `${t(src.rulesFile)}가 없어요. 처음이면 gestalt sync를 먼저 돌려 주세요`,
      fixable: false,
    });
  }
  if (!source.skillsDir) {
    issues.push({
      kind: 'source_missing',
      label: '~/.agents',
      path: src.skillsDir,
      message: `${t(src.skillsDir)} 폴더가 없어요. 처음이면 gestalt sync를 먼저 돌려 주세요`,
      fixable: false,
    });
  }

  for (const slot of inspectTargets(input.targets, src)) {
    const kind = issueKind(slot);
    if (!kind) continue;
    const st = slot.status;
    const p = t(slot.path);
    let message: string;
    if (kind === 'missing_link') message = `${p} 링크가 없어요`;
    else if (st.state === 'missing') message = `${p}가 없어요 (${slot.importLine} 줄을 넣을 파일)`;
    else if (st.state === 'broken_link') message = `${p}가 없는 ${t(st.linkTarget)}를 가리켜요`;
    else if (st.state === 'wrong_target')
      message =
        slot.mode === 'link'
          ? `${p}가 ${t(slot.linkTo)} 대신 ${t(st.linkTarget)}를 가리켜요`
          : `${p}가 ${slot.importLine} 줄이 없는 ${t(st.linkTarget)}를 가리켜요`;
    else if (st.state === 'replaced_by_file')
      message = `${p}가 링크 대신 실제 ${st.isDir ? '폴더' : '파일'}예요`;
    else message = `${p}에 ${slot.importLine} 줄이 없어요`;
    // `~/.agents` 쪽이 없는데 링크만 다시 걸면 또 끊긴 링크가 된다
    const sourceReady =
      slot.mode === 'import' || (slot.name === 'skills' ? source.skillsDir : source.rulesFile);
    issues.push({ kind, label: slot.target.label, path: slot.path, message, fixable: sourceReady });
    if (sourceReady) slots.push(slot);
  }
  return { issues, slots };
}

function findToolWarnings(input: DoctorInput): ToolWarning[] {
  const which = input.which ?? ((tool: string) => defaultWhich(tool));
  const out: ToolWarning[] = [];
  for (const target of input.targets) {
    for (const tool of toolsFor(input.config, target.kind)) {
      if (which(tool, target)) continue;
      out.push({
        label: target.label,
        tool,
        message: `${target.label}: ${tool}를 PATH에서 찾지 못했어요`,
      });
    }
  }
  return out;
}

/**
 * 어긋난 연결을 찾는다. `fix`면 백업하고 그 자리에서 고친다.
 * 고친 기록은 run.json에 남지만 되돌리기 대상은 아니다.
 */
export function runDoctor(input: DoctorInput): DoctorResult {
  const found = findIssues(input);
  const toolWarnings = findToolWarnings(input);
  const recordWarnings = listRunsNewestFirst().corrupt.map(
    (c) =>
      `${c.dirName} 실행 기록을 읽지 못했어요 (${c.reason}). 정리하지 않고 남겨 뒀으니 직접 확인해 주세요`,
  );
  if (!input.fix || found.slots.length === 0) {
    return {
      issues: found.issues,
      toolWarnings,
      fixed: [],
      hints: [],
      remaining: found.issues,
      recordWarnings,
      pruned: [],
    };
  }

  const ctx = planContext(input.home);
  const steps: PlanStep[] = [];
  const hints: string[] = [];
  const handledPaths = systemHomeRules(input.targets);
  for (const slot of found.slots) {
    const plan = fixSlotSteps(slot, ctx, {
      mergeSkills: false,
      sourceNames: new Set(),
      handledPaths,
    });
    steps.push(...plan.steps);
    hints.push(...plan.hints);
  }

  const now = input.now ?? new Date();
  const pruned = pruneRuns(now);
  const run = new RunWriter('doctor', input.home, now);
  applyPlan({ steps, hints }, run);
  const after = findIssues(input);
  return {
    issues: found.issues,
    toolWarnings,
    fixed: steps.map((s) => s.summary),
    hints,
    remaining: after.issues,
    recordWarnings,
    pruned,
    run: { runId: run.record.runId, dir: run.dir, recordFile: run.recordFile },
  };
}
