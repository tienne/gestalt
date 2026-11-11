import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeploySignal, DeploySource, JiraClient } from './jira.js';
import {
  execRunner,
  type AccountSwitcher,
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
 * HostAction으로 모아 돌려주고 마스터 호스트 세션이 실행한다. 배포 결과도 호스트가 확인해
 * `gestalt master deploy report`로 넘긴다. gh로 읽을 수 있는 PR과 계정만 여기서 직접 읽는다.
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

// ─── 배포 결과 ───────────────────────────────────────────────────

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
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<DeploySignal>;
      if (!raw.status || !DEPLOY_STATUSES.has(raw.status)) return { status: 'unknown' };
      return { status: raw.status, ...(raw.ref ? { ref: raw.ref } : {}) };
    },
  };
}

// ─── gh ──────────────────────────────────────────────────────────

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

/**
 * 레포마다 gh로 열린 PR을 읽는다. 대상 레포는 `repoPaths`에 적힌 것만 본다.
 * 본문은 안 싣고 누가 언제 남겼는지만 본다.
 */
export class GhPrWatchSource implements PrWatchSource {
  private readonly runner: CommandRunner;
  private me: string | undefined;

  constructor(
    private readonly opts: { repoPaths: Record<string, string>; runner?: CommandRunner },
  ) {
    this.runner = opts.runner ?? execRunner;
  }

  async authored(): Promise<WatchedPr[]> {
    const me = await this.login();
    const out: WatchedPr[] = [];
    for (const [repo, prs] of await this.list(['--author', '@me'])) {
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
    const me = await this.login();
    const out: WatchedPr[] = [];
    for (const [repo, prs] of await this.list(['--search', 'reviewed-by:@me -author:@me'])) {
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

  private async login(): Promise<string> {
    if (this.me) return this.me;
    const r = await this.runner('gh', ['api', 'user', '--jq', '.login']);
    if (r.code !== 0)
      throw new Error(`gh 로그인 계정을 못 읽었어요: ${r.stderr.trim().split('\n')[0] ?? ''}`);
    this.me = r.stdout.trim();
    return this.me;
  }

  private async list(filter: string[]): Promise<[string, GhPr[]][]> {
    const out: [string, GhPr[]][] = [];
    for (const [repo, cwd] of Object.entries(this.opts.repoPaths)) {
      const r = await this.runner(
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
          '50',
        ],
        { cwd },
      );
      if (r.code !== 0)
        throw new Error(`${repo} PR 목록을 못 읽었어요: ${r.stderr.trim().split('\n')[0] ?? ''}`);
      out.push([repo, JSON.parse(r.stdout) as GhPr[]]);
    }
    return out;
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

/** gh 계정을 레포 단위로 맞춘다. 같은 호스트에 계정이 여럿 로그인돼 있어야 전환된다 */
export class GhAccountSwitcher implements AccountSwitcher {
  private readonly runner: CommandRunner;
  constructor(opts: { runner?: CommandRunner } = {}) {
    this.runner = opts.runner ?? execRunner;
  }

  async current(): Promise<string | undefined> {
    const r = await this.runner('gh', ['api', 'user', '--jq', '.login']);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  async switchTo(_repo: string, account: string): Promise<void> {
    const r = await this.runner('gh', ['auth', 'switch', '--user', account]);
    if (r.code !== 0)
      throw new Error(
        `gh 계정을 ${account}로 못 바꿨어요: ${r.stderr.trim().split('\n')[0] ?? ''}`,
      );
  }
}
