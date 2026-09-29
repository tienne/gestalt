import {
  BLOCKING_ISSUES,
  decideApproveGate,
  localRoundsDir,
  nextRoundNumber,
  parseScope,
  readRounds,
  recordRound,
  resolvePostedEvent,
  reusableNoRemoteChoice,
  type BlockingIssue,
} from '../../harness-review/approve-gate.js';
import {
  POSTED_EVENT_TYPES,
  USER_CHOICE_TYPES,
  type PostedEventType,
  type ReviewRound,
  type UserChoiceType,
} from '../../harness-review/types.js';
import { parseTarget, resolveRepo, runGh, stateDir } from '../../review-loop/index.js';

/**
 * `gestalt review-loop rounds` 와 `gestalt review-loop approve-gate`.
 *
 * 리뷰 이벤트 결정과 review-loop ⓟ 가 셸에서 부른다. 명시 여부는 프롬프트 맥락이라
 * 스킬이 `--scope` 로 넘기고 여기서는 라운드 기록과 규칙만 본다.
 */

export interface RoundsLocationOptions {
  pr?: string;
  dir?: string;
  branch?: string;
}

function roundsDir(opts: RoundsLocationOptions): string {
  const given = [opts.pr, opts.dir, opts.branch].filter((v) => v !== undefined).length;
  if (given > 1) throw new Error('--pr, --dir, --branch 중 하나만 준다');
  if (opts.dir) return opts.dir;
  if (opts.pr) {
    const parsed = parseTarget(opts.pr);
    const { owner, repo } =
      parsed.owner && parsed.repo ? { owner: parsed.owner, repo: parsed.repo } : resolveRepo(runGh);
    return stateDir({ owner, repo, prNumber: parsed.prNumber });
  }
  return localRoundsDir(process.cwd(), opts.branch);
}

export function reviewRoundsCommand(opts: RoundsLocationOptions): void {
  run(() => {
    const dir = roundsDir(opts);
    const rounds = readRounds(dir);
    console.log(
      JSON.stringify({
        dir,
        rounds,
        nextRound: nextRoundNumber(rounds),
        noRemoteChoice: reusableNoRemoteChoice(rounds) ?? null,
      }),
    );
  });
}

export interface ApproveGateOptions extends RoundsLocationOptions {
  scope?: string;
  issue?: string[];
  referenceCheckSkipped?: boolean;
  userChoice?: string;
  autoConsent?: boolean;
  event?: string;
  round?: string;
  record?: boolean;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} 값이 틀렸다: ${value} (${allowed.join('|')})`);
  }
  return value as T;
}

export function approveGateCommand(opts: ApproveGateOptions): void {
  run(() => {
    const scope = parseScope(opts.scope);
    const issues = new Set<BlockingIssue>(
      (opts.issue ?? []).map((i) => oneOf(i, BLOCKING_ISSUES, '--issue')),
    );
    const intended: PostedEventType = oneOf(opts.event ?? 'APPROVE', POSTED_EVENT_TYPES, '--event');
    const dir = roundsDir(opts);
    const all = readRounds(dir);
    const roundNumber = opts.round === undefined ? nextRoundNumber(all) : Number(opts.round);
    if (!Number.isSafeInteger(roundNumber) || roundNumber <= 0) {
      throw new Error(`라운드 번호가 양의 정수가 아니다: ${opts.round}`);
    }
    const history = all.filter((r) => r.roundNumber < roundNumber);

    const noRemoteChoice = reusableNoRemoteChoice(history);
    let userChoice: UserChoiceType | undefined =
      opts.userChoice === undefined
        ? undefined
        : oneOf(opts.userChoice, USER_CHOICE_TYPES, '--user-choice');
    if (userChoice === undefined && issues.has('noGitHubRemote')) userChoice = noRemoteChoice;

    const current = {
      lookupBlocked: issues.has('lookupBlocked'),
      noGitHubRemote: issues.has('noGitHubRemote'),
      relatedPrUnconfirmed: issues.has('relatedPrUnconfirmed'),
      referenceCheckSkipped:
        opts.referenceCheckSkipped === true || userChoice === 'proceedWithoutRefs',
    };
    const gate = decideApproveGate({ history, current, scope, autoConsent: opts.autoConsent });
    const event = resolvePostedEvent(intended, gate);
    const round: ReviewRound = {
      roundNumber,
      ...current,
      ...(userChoice ? { userChoice } : {}),
      explicitApproveInstruction: scope !== 'none',
      postedEvent: event,
    };
    if (opts.record) recordRound(dir, round);
    console.log(
      JSON.stringify({
        dir,
        round,
        gate,
        event,
        noRemoteChoice: noRemoteChoice ?? null,
        recorded: opts.record === true,
      }),
    );
  });
}

/** 실패하면 stdout 을 비우고 종료 코드로 답한다. 빈 출력이 allow 로 읽히면 안 된다 */
function run(body: () => void): void {
  try {
    body();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
