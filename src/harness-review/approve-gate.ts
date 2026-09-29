import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stateRoot } from '../review-loop/state.js';
import {
  EXPLICIT_INSTRUCTION_SCOPES,
  POSTED_EVENT_TYPES,
  USER_CHOICE_TYPES,
  type ApproveGate,
  type ExplicitInstructionScope,
  type PostedEventType,
  type ReviewRound,
  type UserChoiceType,
} from './types.js';

/**
 * approve 를 막는 세 이슈. 셋을 한 규칙으로 다룬다 (A5).
 * 참조 검사 누락(referenceCheckSkipped)은 여기 안 넣는다 — 이전 라운드에서 이어졌는지와
 * 상관없이 명시만 보는 별도 규칙이다 (A3).
 */
export const BLOCKING_ISSUES = ['lookupBlocked', 'noGitHubRemote', 'relatedPrUnconfirmed'] as const;

export type BlockingIssue = (typeof BLOCKING_ISSUES)[number];

export const ROUNDS_FILE = 'harness-rounds.json';

export interface ApproveGateInput {
  /** 이번 라운드 이전에 기록된 라운드. 순서는 상관없다 */
  history: ReviewRound[];
  current: Pick<ReviewRound, BlockingIssue | 'referenceCheckSkipped'>;
  /** 스킬이 프롬프트 맥락에서 읽은 명시 범위. 코드는 판단하지 않고 규칙만 적용한다 */
  scope: ExplicitInstructionScope;
  /** review-loop ⓢ 자동 판정 동의. 기록만 하고 명시로는 치지 않는다 (A4 반대 경계) */
  autoConsent?: boolean;
}

function isExplicit(scope: ExplicitInstructionScope): boolean {
  return scope === 'precondition' || scope === 'thisRound';
}

function previousRound(history: ReviewRound[]): ReviewRound | undefined {
  return [...history].sort((a, b) => a.roundNumber - b.roundNumber).at(-1);
}

/**
 * approve 를 내도 되는지 판정한다.
 *
 * "새로 생김"은 직전 라운드에 없던 이슈다. 한 번 해소됐다가 다시 나타나도 새로 생긴 것으로
 * 본다 — 사용자가 그 상태를 보고 명시한 게 아니기 때문이다.
 */
export function decideApproveGate(input: ApproveGateInput): ApproveGate {
  const { current, scope } = input;
  const prev = previousRound(input.history);
  const present = BLOCKING_ISSUES.filter((k) => current[k]);
  const fresh = present.filter((k) => !prev?.[k]);
  const carried = present.filter((k) => prev?.[k] === true);
  const explicit = isExplicit(scope);
  const base = {
    blockingIssuesThisRound: fresh,
    blockingIssuesPriorRounds: carried,
    explicitInstructionScope: scope,
  };
  const consentNote = input.autoConsent && !explicit ? ' ⓢ 자동 동의는 명시로 치지 않는다.' : '';

  if (fresh.length > 0) {
    return {
      ...base,
      decision: 'block',
      reason: `이번 라운드에 새로 생긴 이슈가 있다: ${fresh.join(', ')}. 명시가 있어도 approve 하지 않는다.`,
    };
  }
  if (carried.length > 0 && !explicit) {
    return {
      ...base,
      decision: 'block',
      reason: `이전 라운드부터 이어진 이슈가 있다: ${carried.join(', ')}. 사용자가 approve 를 명시해야 한다.${consentNote}`,
    };
  }
  if (current.referenceCheckSkipped && !explicit) {
    return {
      ...base,
      decision: 'block',
      reason: `참조 검사를 비워둔 라운드다. 사용자가 approve 를 명시해야 한다.${consentNote}`,
    };
  }
  if (carried.length > 0 || current.referenceCheckSkipped) {
    return {
      ...base,
      decision: 'allow',
      reason: '새로 생긴 이슈가 없고 사용자가 approve 를 명시했다.',
    };
  }
  return { ...base, decision: 'allow', reason: '막는 이슈가 없다.' };
}

/** 막힌 게이트에서 APPROVE 를 COMMENT 로 내린다. 다른 이벤트는 그대로 둔다 */
export function resolvePostedEvent(intended: PostedEventType, gate: ApproveGate): PostedEventType {
  return intended === 'APPROVE' && gate.decision === 'block' ? 'COMMENT' : intended;
}

/**
 * 원격 없는 레포에서 앞 라운드에 받아 둔 답.
 *
 * 원격이 없다는 사실은 라운드가 바뀌어도 그대로라 첫 라운드에만 묻는다. 다만 '기다림'은
 * 재사용하지 않는다 — 기다리겠다던 사용자가 다시 불렀다는 것 자체가 새 답이 필요하다는
 * 신호이고 그걸 재사용하면 리뷰가 영영 멈춘다.
 */
export function reusableNoRemoteChoice(history: ReviewRound[]): UserChoiceType | undefined {
  return [...history]
    .sort((a, b) => a.roundNumber - b.roundNumber)
    .find((r) => r.noGitHubRemote && r.userChoice === 'proceedWithoutRefs')?.userChoice;
}

function isRound(v: unknown): v is ReviewRound {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const bools = [...BLOCKING_ISSUES, 'referenceCheckSkipped'] as const;
  return (
    Number.isSafeInteger(r.roundNumber) &&
    (r.roundNumber as number) > 0 &&
    bools.every((k) => typeof r[k] === 'boolean') &&
    (r.userChoice === undefined ||
      (USER_CHOICE_TYPES as readonly unknown[]).includes(r.userChoice)) &&
    (r.explicitApproveInstruction === undefined ||
      typeof r.explicitApproveInstruction === 'boolean') &&
    (r.postedEvent === undefined ||
      (POSTED_EVENT_TYPES as readonly unknown[]).includes(r.postedEvent))
  );
}

/**
 * 기록을 읽는다. 파일이 없으면 첫 라운드다.
 * 형식이 깨졌으면 던진다 — 빈 이력으로 넘기면 이어진 이슈가 전부 새로 생긴 것으로 읽혀
 * 판정이 바뀐다.
 */
export function readRounds(dir: string): ReviewRound[] {
  const path = join(dir, ROUNDS_FILE);
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (!Array.isArray(parsed) || !parsed.every(isRound)) {
    throw new Error(`라운드 기록 형식이 틀렸다: ${path}`);
  }
  return parsed;
}

/** 같은 번호의 라운드가 있으면 바꿔 끼운다. 한 라운드에서 판정을 다시 불러도 안 쌓인다 */
export function recordRound(dir: string, round: ReviewRound): ReviewRound[] {
  const rounds = readRounds(dir).filter((r) => r.roundNumber !== round.roundNumber);
  rounds.push(round);
  rounds.sort((a, b) => a.roundNumber - b.roundNumber);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ROUNDS_FILE), JSON.stringify(rounds, null, 2) + '\n');
  return rounds;
}

export function nextRoundNumber(history: ReviewRound[]): number {
  return history.reduce((max, r) => Math.max(max, r.roundNumber), 0) + 1;
}

/**
 * PR 없이 도는 리뷰(원격 없는 레포의 브랜치 리뷰 등)의 기록 자리.
 *
 * review-loop 상태 자리 뿌리 아래에 브랜치별로 둔다. 리뷰마다 새로 만드는 임시
 * 디렉토리에 두면 다음 라운드가 앞 라운드 답을 못 찾는다.
 */
export function localRoundsDir(cwd = process.cwd(), branch?: string): string {
  const name =
    branch ??
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8' }).trim();
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe === '' || /^\.+$/.test(safe)) {
    throw new Error(`브랜치 이름을 경로에 못 쓴다: ${JSON.stringify(name)}`);
  }
  return resolve(stateRoot(cwd), `local--${safe}`);
}

export function parseScope(value: string | undefined): ExplicitInstructionScope {
  const scope = value ?? 'none';
  if (!(EXPLICIT_INSTRUCTION_SCOPES as readonly string[]).includes(scope)) {
    throw new Error(`명시 범위가 틀렸다: ${scope} (${EXPLICIT_INSTRUCTION_SCOPES.join('|')})`);
  }
  return scope as ExplicitInstructionScope;
}
