import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../core/log.js';
import { isAccountName } from './account-name.js';
import type { DeploySignal, DeploySource, JiraClient } from './jira.js';
import {
  execRunner,
  type AccountSwitcher,
  type CommandOptions,
  type CommandRunner,
  type HostAction,
} from './launcher.js';
import type { PrWatchSource, WatchedPr } from './pr-watch.js';
import type { SlackClient } from './slack.js';
import type { Order } from './types.js';

/**
 * CLI가 tick을 돌릴 때 쓰는 어댑터 실물.
 *
 * 지라와 슬랙 쓰기는 사람 계정의 MCP 연결이 필요해 이 프로세스가 직접 못 한다. 그래서 할 일을
 * HostAction으로 모아 돌려주고 컨덕터 호스트 세션이 실행한다. 배포 결과도 호스트가 확인해
 * `gestalt conductor deploy report`로 넘긴다. gh로 읽을 수 있는 PR과 계정만 여기서 직접 읽는다.
 */

export function hostJiraClient(actions: HostAction[]): JiraClient {
  return {
    transition: async (issueKey, to) => {
      actions.push({ type: 'jira-transition', issueKey, to });
    },
  };
}

/** 승인된 초안을 호스트에 넘긴다. 게시 기록은 넘긴 시점에 남아 같은 초안을 두 번 넘기지 않는다 */
export function hostSlackClient(actions: HostAction[]): SlackClient {
  return {
    post: async (m) => {
      actions.push({
        type: 'slack-post',
        channel: m.channel,
        text: m.text,
        ...(m.threadTs ? { threadTs: m.threadTs } : {}),
      });
      return 'host';
    },
  };
}

const DEPLOY_STATUSES: ReadonlySet<DeploySignal['status']> = new Set([
  'success',
  'failed',
  'pending',
  'unknown',
]);

export function writeDeploySignal(dir: string, orderId: string, signal: DeploySignal): void {
  if (!/^[\w-]+$/.test(orderId)) throw new Error(`주문 id 형식이 아니에요: ${orderId}`);
  if (!DEPLOY_STATUSES.has(signal.status))
    throw new Error(`배포 상태를 모르겠어요: ${signal.status}`);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${orderId}.json`);
  writeFileSync(tmp, JSON.stringify(signal));
  renameSync(tmp, join(dir, `${orderId}.json`));
}

/** 호스트가 남긴 배포 결과 파일을 읽는다. 아직 없으면 기다리는 중으로 본다 */
export function fileDeploySource(dir: string): DeploySource {
  return {
    status: async (order: Order) => {
      const file = join(dir, `${order.id}.json`);
      if (!existsSync(file)) return { status: 'pending' };
      let raw: Partial<DeploySignal>;
      try {
        raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<DeploySignal>;
      } catch (err) {
        // 깨진 파일 하나가 매 tick 정산 전체를 끊지 않게 이 주문만 건너뛴다
        log(`배포 결과 파일을 못 읽어 ${order.id}는 이번에 건너뛰어요: ${String(err)}`);
        return { status: 'unknown' };
      }
      if (!raw || typeof raw !== 'object' || !raw.status || !DEPLOY_STATUSES.has(raw.status))
        return { status: 'unknown' };
      return { status: raw.status, ...(raw.ref ? { ref: raw.ref } : {}) };
    },
  };
}

interface GhActivity {
  id?: string;
  author?: { login?: string };
  createdAt?: string;
  submittedAt?: string;
  commit?: { oid?: string };
}

interface GhPr {
  number: number;
  title: string;
  headRefOid: string;
  comments?: GhActivity[];
  reviews?: GhActivity[];
}

const PR_FIELDS = 'number,title,headRefOid,comments,reviews';
/** 열린 PR이 이보다 많으면 뒤가 잘린다. 잘렸는지는 truncatedRepos로 알린다 */
export const PR_LIST_LIMIT = 200;
/** 큰 레포의 PR 목록은 코멘트까지 내려받아 기본 시간보다 오래 걸린다 */
const PR_LIST_TIMEOUT_MS = 180_000;

/**
 * 레포마다 쓸 gh 계정의 토큰을 꺼낸다.
 *
 * `gh auth switch`는 머신 전역 계정을 바꿔서 다른 레포에서 도는 워커까지 계정이 바뀐다. 그래서
 * 전환하지 않고 `gh auth token --user`로 받은 토큰을 그 호출의 GH_TOKEN으로만 넘긴다.
 * 인스턴스는 tick 하나 동안만 쓴다. 토큰과 로그인 계정을 그 안에서만 캐시한다.
 */
export class GhAccounts {
  private readonly runner: CommandRunner;
  private readonly tokens = new Map<string, Promise<string>>();
  private readonly logins = new Map<string, Promise<string>>();

  constructor(
    private readonly accounts: Record<string, string> = {},
    opts: { runner?: CommandRunner } = {},
  ) {
    this.runner = opts.runner ?? execRunner;
  }

  /** 계정의 토큰. 그 계정으로 로그인한 적이 없으면 던진다 */
  token(account: string): Promise<string> {
    if (!isAccountName(account))
      return Promise.reject(new Error(`gh 계정 이름 꼴이 아니에요: ${JSON.stringify(account)}`));
    let t = this.tokens.get(account);
    if (!t) {
      t = this.runner('gh', ['auth', 'token', '--user', account]).then((r) => {
        if (r.code !== 0 || !r.stdout.trim())
          throw new Error(
            `gh 계정 ${account}의 토큰을 못 꺼냈어요: ${r.stderr.trim().split('\n')[0] ?? ''}`,
          );
        return r.stdout.trim();
      });
      t.catch(() => this.tokens.delete(account));
      this.tokens.set(account, t);
    }
    return t;
  }

  /** 계정이 정해진 레포면 그 토큰을 env로, 아니면 전역 계정을 그대로 쓴다 */
  async envFor(repo: string, account = this.accounts[repo]): Promise<CommandOptions['env']> {
    return account ? { GH_TOKEN: await this.token(account) } : undefined;
  }

  /** 그 env로 부를 때 gh가 보는 로그인 계정. 전역 계정은 빈 키로 한 번만 묻는다 */
  login(account?: string): Promise<string> {
    const key = account ?? '';
    let l = this.logins.get(key);
    if (!l) {
      l = (async () => {
        const env = account ? { GH_TOKEN: await this.token(account) } : undefined;
        const r = await this.runner('gh', ['api', 'user', '--jq', '.login'], env ? { env } : {});
        if (r.code !== 0)
          throw new Error(`gh 로그인 계정을 못 읽었어요: ${r.stderr.trim().split('\n')[0] ?? ''}`);
        return r.stdout.trim();
      })();
      l.catch(() => this.logins.delete(key));
      this.logins.set(key, l);
    }
    return l;
  }

  accountOf(repo: string): string | undefined {
    return this.accounts[repo];
  }
}

/**
 * 레포마다 gh로 열린 PR을 읽는다. 대상 레포는 `repoPaths`에 적힌 것만 본다.
 * 코멘트와 리뷰는 누가 언제 남겼는지만 쓴다. gh pr list가 필드를 좁혀 주지 않아 본문도 내려오지만
 * 결과에는 싣지 않는다.
 *
 * `unansweredThreads`는 채우지 않는다. 스레드 해결 여부는 gh pr list로 안 나오고 graphql을 따로
 * 불러야 한다. 값을 비워 둬서 "답 없는 스레드 0개"와 구분되게 한다.
 */
export class GhPrWatchSource implements PrWatchSource {
  private readonly runner: CommandRunner;
  private readonly accounts: GhAccounts;
  /** 이번 tick에 PR_LIST_LIMIT에 닿아 뒤가 잘린 레포 */
  readonly truncatedRepos = new Set<string>();

  constructor(
    private readonly opts: {
      repoPaths: Record<string, string>;
      runner?: CommandRunner;
      accounts?: GhAccounts;
    },
  ) {
    this.runner = opts.runner ?? execRunner;
    this.accounts = opts.accounts ?? new GhAccounts({}, { runner: this.runner });
  }

  async authored(): Promise<WatchedPr[]> {
    const out: WatchedPr[] = [];
    for (const [repo, me, prs] of await this.list(['--author', '@me'])) {
      for (const pr of prs) {
        const activity = [...(pr.comments ?? []), ...(pr.reviews ?? [])];
        const mine = latest(activity.filter((a) => a.author?.login === me));
        const other = latest(activity.filter((a) => a.author?.login && a.author.login !== me));
        out.push({
          ...base(repo, pr),
          // 내가 마지막으로 답한 뒤에 남은 것만 새 코멘트로 본다
          ...(other?.id && (!mine || at(other) > at(mine))
            ? { latestOtherCommentId: other.id }
            : {}),
        });
      }
    }
    return out;
  }

  async reviewing(): Promise<WatchedPr[]> {
    const out: WatchedPr[] = [];
    for (const [repo, me, prs] of await this.list(['--search', 'reviewed-by:@me -author:@me'])) {
      for (const pr of prs) {
        const myReview = latest((pr.reviews ?? []).filter((r) => r.author?.login === me));
        const reviewedHeadSha = myReview?.commit?.oid;
        if (!myReview || !reviewedHeadSha) continue;
        const replies = [...(pr.comments ?? []), ...(pr.reviews ?? [])].filter(
          (a) => a.author?.login && a.author.login !== me && at(a) > at(myReview),
        ).length;
        out.push({ ...base(repo, pr), reviewedHeadSha, repliesSinceReview: replies });
      }
    }
    return out;
  }

  /** 레포별로 [레포, 그 레포에서의 내 로그인, PR 목록]. 레포끼리는 함께 부른다 */
  private list(filter: string[]): Promise<[string, string, GhPr[]][]> {
    return Promise.all(
      Object.entries(this.opts.repoPaths).map(async ([repo, cwd]) => {
        const account = this.accounts.accountOf(repo);
        const env = await this.accounts.envFor(repo, account);
        const [me, r] = await Promise.all([
          this.accounts.login(account),
          this.runner(
            'gh',
            [
              'pr',
              'list',
              '--repo',
              repo,
              '--state',
              'open',
              ...filter,
              '--json',
              PR_FIELDS,
              '--limit',
              String(PR_LIST_LIMIT),
            ],
            { cwd, timeoutMs: PR_LIST_TIMEOUT_MS, ...(env ? { env } : {}) },
          ),
        ]);
        if (r.code !== 0)
          throw new Error(`${repo} PR 목록을 못 읽었어요: ${r.stderr.trim().split('\n')[0] ?? ''}`);
        const prs = JSON.parse(r.stdout) as GhPr[];
        if (prs.length >= PR_LIST_LIMIT) {
          this.truncatedRepos.add(repo);
          log(`${repo} 열린 PR이 ${PR_LIST_LIMIT}개 상한에 닿아 뒤쪽은 이번에 못 봤어요`);
        }
        return [repo, me, prs] as [string, string, GhPr[]];
      }),
    );
  }
}

function base(repo: string, pr: GhPr): WatchedPr {
  return { ref: `${repo}#${pr.number}`, repo, title: pr.title, headSha: pr.headRefOid };
}

function at(a: GhActivity): number {
  return Date.parse(a.submittedAt ?? a.createdAt ?? '') || 0;
}

function latest(list: GhActivity[]): GhActivity | undefined {
  return list.reduce<GhActivity | undefined>(
    (best, a) => (!best || at(a) > at(best) ? a : best),
    undefined,
  );
}

/**
 * gh 계정을 레포 단위로 맞춘다. 전역 계정은 바꾸지 않는다. 맞춘다는 건 그 계정 토큰을 꺼낼 수
 * 있는지 확인하고 이 tick의 그 레포 호출에 묶는 것이다. 워커는 지시서대로 명령마다 GH_TOKEN을 넘긴다.
 */
export class GhAccountSwitcher implements AccountSwitcher {
  private readonly accounts: GhAccounts;
  private readonly bound = new Map<string, string>();

  constructor(opts: { runner?: CommandRunner; accounts?: GhAccounts } = {}) {
    this.accounts = opts.accounts ?? new GhAccounts({}, opts.runner ? { runner: opts.runner } : {});
  }

  async current(repo?: string): Promise<string | undefined> {
    const bound = repo ? this.bound.get(repo) : undefined;
    if (bound) return bound;
    return this.accounts.login().catch(() => undefined);
  }

  async switchTo(repo: string, account: string): Promise<void> {
    await this.accounts.token(account);
    this.bound.set(repo, account);
  }
}
