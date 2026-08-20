import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LocalPrEngine, PrError } from '../../local-pr/engine.js';
import type { PullRequest, ReviewVerdict } from '../../local-pr/types.js';

/**
 * `gestalt pr` — 로컬 PR CLI.
 *
 * 에이전트가 부르는 정본 표면이다. MCP가 없거나 끊긴 런타임에서도 돌아야 해서
 * 셸만 있으면 되는 이 경로를 먼저 만든다.
 */

export interface PrCommonOptions {
  repoRoot?: string;
  json?: boolean;
  author?: string;
}

/**
 * 본문을 파일이나 stdin에서 읽는다.
 *
 * 인자로 받지 않는 이유는 셸을 타면 한글과 백틱, 줄바꿈이 깨지기 때문이다.
 * `-`면 stdin이다 — gh가 --body-file에 쓰는 방식과 같다.
 */
function readBody(bodyFile?: string): string {
  if (!bodyFile) return '';
  return readFileSync(bodyFile === '-' ? 0 : bodyFile, 'utf-8');
}

/** 누가 했는지. 안 주면 환경변수, 그것도 없으면 사람으로 본다 */
function actorOf(opts: PrCommonOptions): string {
  return opts.author ?? process.env['GESTALT_ACTOR'] ?? 'human:local';
}

function engineOf(opts: PrCommonOptions): LocalPrEngine {
  return new LocalPrEngine(resolve(opts.repoRoot ?? process.cwd()));
}

/** 에이전트가 파싱할 자리라 --json이면 객체만 내보낸다 */
function emit(value: unknown, json: boolean | undefined, human: () => void): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    human();
  }
}

function summarize(pr: PullRequest): string {
  const unresolved = pr.comments.filter((c) => !c.resolved).length;
  const round = pr.rounds[pr.rounds.length - 1]!.number;
  return `${pr.id}  [${pr.status}]  ${pr.title}  (라운드 ${round}, 미해결 ${unresolved})`;
}

/** 오류를 종료 코드로 옮긴다. 에이전트가 stdout을 안 읽고도 갈래를 탄다 */
function run(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof PrError) {
      console.error(e.message);
      process.exit(e.exitCode);
    }
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

export function prCreateCommand(
  opts: PrCommonOptions & { title: string; base?: string; head?: string; bodyFile?: string },
): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const pr = engine.create({
        title: opts.title,
        body: readBody(opts.bodyFile),
        author: actorOf(opts),
        base: opts.base,
        head: opts.head,
      });
      emit(pr, opts.json, () => {
        console.log(`PR ${pr.id} 생성`);
        console.log(`  base ${pr.baseSha.slice(0, 8)} → head ${pr.headSha.slice(0, 8)}`);
        console.log(`  리뷰: gestalt pr show ${pr.id}`);
      });
    } finally {
      engine.dispose();
    }
  });
}

export function prListCommand(opts: PrCommonOptions & { status?: PullRequest['status'] }): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const prs = engine.list(opts.status);
      emit(prs, opts.json, () => {
        if (prs.length === 0) {
          console.log('PR이 없다');
          return;
        }
        for (const pr of prs) console.log(summarize(pr));
      });
    } finally {
      engine.dispose();
    }
  });
}

export function prShowCommand(opts: PrCommonOptions & { id: string }): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const pr = engine.get(opts.id);
      if (!pr) throw new PrError(`PR을 못 찾았다: ${opts.id}`, 3);

      emit(pr, opts.json, () => {
        console.log(summarize(pr));
        console.log(`  작성 ${pr.author}`);
        if (pr.body) console.log(`\n${pr.body}\n`);

        for (const round of pr.rounds) {
          const verdict = round.verdict ?? '진행 중';
          console.log(`\n라운드 ${round.number} — ${verdict} (코멘트 ${round.commentCount})`);
          for (const review of pr.reviews.filter((r) => r.round === round.number)) {
            console.log(`  ${review.reviewer}: ${review.verdict} — ${review.summary}`);
          }
        }

        const open = pr.comments.filter((c) => !c.resolved);
        if (open.length > 0) {
          console.log('\n미해결 코멘트');
          for (const c of open) {
            const at = c.line === null ? c.path : `${c.path}:${c.line}`;
            console.log(`  [${c.id}] ${at} (${c.author})`);
            console.log(`    ${c.body.split('\n')[0]}`);
          }
        }
      });
    } finally {
      engine.dispose();
    }
  });
}

export function prDiffCommand(opts: PrCommonOptions & { id: string }): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      console.log(engine.diff(opts.id));
    } finally {
      engine.dispose();
    }
  });
}

export function prCommentCommand(
  opts: PrCommonOptions & {
    id: string;
    path: string;
    line?: string;
    bodyFile?: string;
    replyTo?: string;
  },
): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const body = readBody(opts.bodyFile);
      if (!body.trim()) throw new PrError('본문이 비었다. --body-file로 넘긴다', 1);

      const pr = engine.comment(opts.id, {
        author: actorOf(opts),
        path: opts.path,
        line: opts.line ? Number(opts.line) : undefined,
        body,
        replyTo: opts.replyTo,
      });
      const added = pr.comments[pr.comments.length - 1]!;
      emit(added, opts.json, () => console.log(`코멘트 ${added.id} 추가`));
    } finally {
      engine.dispose();
    }
  });
}

export function prCommentsCommand(
  opts: PrCommonOptions & { id: string; unresolved?: boolean },
): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const pr = engine.get(opts.id);
      if (!pr) throw new PrError(`PR을 못 찾았다: ${opts.id}`, 3);

      const comments = opts.unresolved ? pr.comments.filter((c) => !c.resolved) : pr.comments;
      emit(comments, opts.json, () => {
        for (const c of comments) {
          const at = c.line === null ? c.path : `${c.path}:${c.line}`;
          const mark = c.resolved ? '해결' : '열림';
          console.log(`[${c.id}] ${at} (${c.author}, ${mark})`);
          console.log(c.body);
          console.log('');
        }
      });
    } finally {
      engine.dispose();
    }
  });
}

export function prResolveCommand(opts: PrCommonOptions & { commentId: string; id: string }): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      engine.resolve(opts.id, opts.commentId, actorOf(opts));
      console.log(`코멘트 ${opts.commentId} 스레드를 닫았다`);
    } finally {
      engine.dispose();
    }
  });
}

const VERDICTS: Record<string, ReviewVerdict> = {
  approve: 'approve',
  'request-changes': 'request_changes',
  comment: 'comment',
};

export function prReviewCommand(
  opts: PrCommonOptions & { id: string; verdict: string; bodyFile?: string },
): void {
  run(() => {
    const verdict = VERDICTS[opts.verdict];
    if (!verdict) {
      throw new PrError('판정은 approve, request-changes, comment 중 하나다', 1);
    }

    const engine = engineOf(opts);
    try {
      const pr = engine.review(opts.id, {
        reviewer: actorOf(opts),
        verdict,
        summary: readBody(opts.bodyFile).trim(),
      });
      emit(pr, opts.json, () => {
        console.log(`판정 ${opts.verdict} 기록 — 상태 ${pr.status}`);
        console.log(`  라운드 ${pr.rounds[pr.rounds.length - 1]!.number}`);
      });
    } finally {
      engine.dispose();
    }
  });
}

export function prUpdateCommand(opts: PrCommonOptions & { id: string; head?: string }): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const pr = engine.update(opts.id, opts.head);
      emit(pr, opts.json, () => {
        console.log(`head를 ${pr.headSha.slice(0, 8)}로 옮겼다 — 상태 ${pr.status}`);
      });
    } finally {
      engine.dispose();
    }
  });
}

export function prMergeCommand(
  opts: PrCommonOptions & { id: string; deleteBranch?: boolean },
): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      const before = engine.get(opts.id);
      const unresolved = before?.comments.filter((c) => !c.resolved).length ?? 0;

      const pr = engine.merge(opts.id, actorOf(opts), { deleteBranch: opts.deleteBranch });
      emit(pr, opts.json, () => {
        console.log(`PR ${pr.id} 머지`);
        if (unresolved > 0) console.log(`  미해결 코멘트 ${unresolved}건이 남은 채로 머지됐다`);
      });
    } finally {
      engine.dispose();
    }
  });
}

export function prCloseCommand(opts: PrCommonOptions & { id: string; reason?: string }): void {
  run(() => {
    const engine = engineOf(opts);
    try {
      engine.closePr(opts.id, actorOf(opts), opts.reason ?? '');
      console.log(`PR ${opts.id} 닫음`);
    } finally {
      engine.dispose();
    }
  });
}
