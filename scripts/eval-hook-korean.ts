/**
 * UserPromptSubmit 포인터를 한국어 프롬프트로 평가한다.
 *
 *   pnpm tsx scripts/eval-hook-korean.ts [--repo <path>] [--before 2026-09-04]
 *     [--sessions <dir> | --sessions-match <문자열> | --all-sessions] [--keep | --worktree <path>]
 *
 * `--repo`를 안 주면 지금 디렉토리의 레포를 쓴다. 대상 레포 안에 워크트리를 만드니
 * 작업 중인 레포라면 `git clone --no-local`로 복제한 쪽을 넘긴다.
 * `--sessions`를 안 주면 ~/.claude/projects/-Users-kwon-david-dev-gestalt를 읽는다.
 * `--sessions-match`는 ~/.claude/projects 아래 이름에 그 문자열이 든 디렉토리를 다 읽는다.
 * 워크트리마다 세션 디렉토리가 따로 생겨서 메인 체크아웃 기록만으로는 표본이 작다.
 * `--all-sessions`는 `--sessions-match gestalt`와 같다.
 * `--worktree`는 `--keep`으로 남긴 T 시점 워크트리를 다시 빌드하지 않고 쓴다
 *
 * 시점 T(`--before` 날짜 직전의 마지막 커밋)에 detached 워크트리를 만들고 거기서만 그래프를
 * 짓는다. 주석과 커밋 메시지 색인이 T 이후를 못 보게 하려는 것이다. 정답 커밋의 메시지가
 * 색인에 들어가면 답을 미리 보는 셈이 된다.
 *
 * 평가 둘을 같은 그래프로 돌린다.
 * - 커밋 재생: T 이후 한글 제목 커밋을 프롬프트로 넣고 그 커밋이 건드린 파일이 포인터
 *   3개 안에 드는지 본다
 * - 실제 프롬프트: Claude Code 세션 기록에서 한글 사용자 프롬프트와 같은 턴의
 *   Edit/Write 대상 파일을 짝짓는다. 기록은 실행할 때 읽기만 하고 지표만 찍는다.
 *   레포에 남기지 않는다
 *
 * 정답 파일은 T 시점에 있던 것만 센다. T 이후에 생긴 파일은 어떤 색인으로도 못 가리킨다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodeGraphEngine } from '../src/code-graph/engine.js';
import { CodeGraphStore } from '../src/code-graph/storage.js';
import { rankPointers } from '../src/code-graph/hooks/pointers.js';
import { tokenizePrompt } from '../src/code-graph/hooks/rank.js';
import { extractTickets, hasHangul } from '../src/code-graph/ko-text.js';

const MAX_POINTERS = 3;
/** 색인 쪽과 같은 기준. 이보다 많이 건드린 커밋은 작업 하나로 보기 어렵다 */
const MAX_FILES_PER_CASE = 20;

export interface Case {
  prompt: string;
  truth: Set<string>;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
}

/** 커밋 제목을 사람이 칠 법한 프롬프트로. conventional 접두어와 스쿼시 머지의 PR 번호를 뗀다 */
function stripConventional(subject: string): string {
  return subject
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '')
    .replace(/\s*\(#\d+\)\s*$/, '')
    .trim();
}

/** T 이후 커밋. 제목에 한글이 있고 T에 있던 파일을 하나 이상 건드린 것만 */
export function commitCases(repo: string, t: string, wt: string): Case[] {
  const raw = git(repo, ['log', '--no-merges', '--format=%x1e%s', '--name-only', `${t}..HEAD`]);
  const cases: Case[] = [];
  for (const block of raw.split('\x1e').slice(1)) {
    const [subject = '', ...rest] = block.split('\n');
    const files = rest.map((l) => l.trim()).filter(Boolean);
    if (!hasHangul(subject) || files.length === 0 || files.length > MAX_FILES_PER_CASE) continue;
    const truth = new Set(files.filter((f) => existsSync(join(wt, f))));
    if (truth.size > 0) cases.push({ prompt: stripConventional(subject), truth });
  }
  return cases;
}

interface SessionLine {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  /**
   * 사용자 프롬프트 하나에서 이어진 user 줄(tool_result 포함)이 같은 값을 갖는다. 서브에이전트
   * 기록도 부모 것을 물려받는다. assistant 줄에는 없어서 바로 앞 user 줄의 값을 따른다
   */
  promptId?: string;
  cwd?: string;
  timestamp?: string;
  message?: { content?: unknown };
}

function promptText(line: SessionLine): string | undefined {
  if (line.type !== 'user' || line.isMeta || line.isSidechain) return undefined;
  const c = line.message?.content;
  let text: string | undefined;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    const blocks = c as { type?: string; text?: string }[];
    if (blocks.some((b) => b.type === 'tool_result')) return undefined;
    text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
  }
  if (!text) return undefined;
  const trimmed = text.trim();
  // 슬래시 명령 래퍼, 시스템 주입, 압축 뒤 이어쓰기 요약은 사람이 친 프롬프트가 아니다
  if (/^<|^Caveat:|^This session is being continued/.test(trimmed)) return undefined;
  return trimmed;
}

function editedPaths(line: SessionLine): string[] {
  if (line.type !== 'assistant') return [];
  const c = line.message?.content;
  if (!Array.isArray(c)) return [];
  const out: string[] = [];
  for (const b of c as { type?: string; name?: string; input?: { file_path?: unknown } }[]) {
    if (b.type !== 'tool_use' || !['Edit', 'Write', 'MultiEdit'].includes(b.name ?? '')) continue;
    if (typeof b.input?.file_path === 'string') out.push(b.input.file_path);
  }
  return out;
}

interface PromptStats {
  cases: Case[];
  /** 한글 프롬프트인데 같은 턴에 편집이 없던 것. 여기 포인터가 들어가면 잡음 쪽에 가깝다 */
  noEdit: string[];
}

/**
 * 턴은 promptId로 묶는다. 편집 대부분이 서브에이전트 기록(`<세션>/subagents/*.jsonl`)에
 * 있는데 거기도 부모 프롬프트의 promptId가 붙어 있다. Bash로 고친 파일은 못 잡는다.
 */
export function sessionCases(dirs: string[], since: Date, wt: string): PromptStats {
  const prompts = new Map<string, { prompt: string; cwd: string }>();
  const edits = new Map<string, Set<string>>();
  const logs = dirs.flatMap((d) =>
    readdirSync(d, { recursive: true, encoding: 'utf-8' })
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(d, f)),
  );
  for (const file of logs) {
    let id: string | undefined;
    for (const raw of readFileSync(file, 'utf-8').split('\n')) {
      if (!raw) continue;
      let line: SessionLine;
      try {
        line = JSON.parse(raw) as SessionLine;
      } catch {
        continue;
      }
      if (line.type === 'user' && line.promptId) id = line.promptId;
      if (!id) continue;
      const text = promptText(line);
      if (text !== undefined && !prompts.has(id)) {
        const ok =
          hasHangul(text) && line.cwd && line.timestamp && new Date(line.timestamp) >= since;
        if (ok) prompts.set(id, { prompt: text, cwd: line.cwd! });
        continue;
      }
      for (const p of editedPaths(line)) {
        let set = edits.get(id);
        if (!set) edits.set(id, (set = new Set()));
        set.add(p);
      }
    }
  }

  const cases: Case[] = [];
  const noEdit: string[] = [];
  const seen = new Set<string>();
  for (const [id, { prompt, cwd }] of prompts) {
    if (seen.has(prompt)) continue;
    seen.add(prompt);
    const touched = edits.get(id);
    if (!touched) {
      noEdit.push(prompt);
      continue;
    }
    const truth = new Set(
      [...touched]
        .filter((f) => f.startsWith(cwd + sep))
        .map((f) => f.slice(cwd.length + 1))
        .filter((f) => existsSync(join(wt, f))),
    );
    if (truth.size > 0 && truth.size <= MAX_FILES_PER_CASE) cases.push({ prompt, truth });
  }
  return { cases, noEdit };
}

export interface Metrics {
  n: number;
  recall: number;
  hit: number;
  empty: number;
  precision: number;
  p50: number;
  p95: number;
}

export function evaluate(
  store: CodeGraphStore,
  wt: string,
  cases: Case[],
  korean: boolean,
): Metrics {
  let recall = 0;
  let hit = 0;
  let empty = 0;
  let precision = 0;
  let injected = 0;
  const times: number[] = [];
  for (const c of cases) {
    const t0 = performance.now();
    const picks = rankPointers(store, wt, tokenizePrompt(c.prompt), MAX_POINTERS, { korean });
    times.push(performance.now() - t0);
    const got = new Set(picks.map((p) => p.relPath));
    const hits = [...c.truth].filter((f) => got.has(f)).length;
    recall += hits / Math.min(MAX_POINTERS, c.truth.size);
    if (hits > 0) hit++;
    if (picks.length === 0) empty++;
    else {
      injected++;
      precision += hits / picks.length;
    }
  }
  times.sort((a, b) => a - b);
  const n = Math.max(cases.length, 1);
  const q = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? 0;
  return {
    n: cases.length,
    recall: recall / n,
    hit: hit / n,
    empty: empty / n,
    precision: injected ? precision / injected : 0,
    p50: q(0.5),
    p95: q(0.95),
  };
}

export function injectRate(store: CodeGraphStore, wt: string, prompts: string[]): number {
  if (prompts.length === 0) return 0;
  const n = prompts.filter(
    (p) => rankPointers(store, wt, tokenizePrompt(p), MAX_POINTERS).length > 0,
  ).length;
  return n / prompts.length;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * 티켓 키가 든 케이스만 따로 본다. 키만 넣었을 때와, 그 키가 T 이전 이력에 이미 있었는지도
 * 센다. 스쿼시 머지 레포는 티켓마다 커밋이 하나라 처음 나온 티켓은 이력으로 못 맞힌다
 */
function reportTickets(store: CodeGraphStore, wt: string, cases: Case[]): void {
  const withKey = cases
    .map((c) => ({ ...c, tickets: tokenizePrompt(c.prompt).tickets }))
    .filter((c) => c.tickets.length > 0);
  if (withKey.length === 0) {
    process.stdout.write('\n티켓 키가 든 케이스가 없다\n');
    return;
  }
  const seen = withKey.filter((c) => store.getTicketFiles(c.tickets).length > 0);
  const keyOnly = (list: typeof withKey) =>
    list.map((c) => ({ prompt: c.tickets.join(' '), truth: c.truth }));
  report(
    `티켓 키가 든 케이스`,
    evaluate(store, wt, withKey, true),
    evaluate(store, wt, withKey, false),
  );
  process.stdout.write(`\nT 이전 이력에 그 티켓이 있던 케이스 ${seen.length}/${withKey.length}\n`);
  if (seen.length > 0) {
    const m = evaluate(store, wt, keyOnly(seen), true);
    process.stdout.write(
      `이력에 있던 티켓 키만 넣었을 때 (n=${m.n}) recall@3 ${pct(m.recall)}, 맞힌 비율 ${pct(m.hit)}, 안 넣은 비율 ${pct(m.empty)}, 넣었을 때 정밀도 ${pct(m.precision)}\n`,
    );
  }
}

function report(title: string, ko: Metrics, en: Metrics): void {
  process.stdout.write(`\n## ${title} (n=${ko.n})\n`);
  process.stdout.write(
    '| 신호 | recall@3 | 맞힌 비율 | 안 넣은 비율 | 넣었을 때 정밀도 | p50 | p95 |\n',
  );
  process.stdout.write('|---|---|---|---|---|---|---|\n');
  for (const [label, m] of [
    ['영문만', en],
    ['영문+한국어', ko],
  ] as const) {
    process.stdout.write(
      `| ${label} | ${pct(m.recall)} | ${pct(m.hit)} | ${pct(m.empty)} | ${pct(m.precision)} | ${m.p50.toFixed(1)}ms | ${m.p95.toFixed(1)}ms |\n`,
    );
  }
}

/**
 * 티켓 키 롤링 평가. 이력을 오래된 커밋부터 훑으며 그 커밋보다 앞선 커밋만으로 티켓마다 건드린
 * 파일 횟수를 쌓는다. 이미 나온 티켓을 단 커밋이 오면 횟수 상위 파일로 그 커밋의 파일을
 * 맞히는지 본다. 훅처럼 횟수가 최대인 파일만 남긴다. 훅에서 티켓 점수가 다른 신호를 압도하니 키만 넣은 프롬프트와 같은 순위가 된다.
 *
 * 스쿼시 머지 레포는 티켓 하나에 커밋이 하나라 시점 하나로 자르면 이력에 있던 티켓이 거의
 * 없다. 후속 PR처럼 같은 티켓이 다시 나오는 경우는 이렇게 훑어야 잡힌다. 각 커밋은 자기보다
 * 앞선 커밋만 보므로 답이 새지 않는다
 */
export function rollingTicketEval(repo: string): {
  withTicket: number;
  seen: number;
  metrics: { recall: number; hit: number; precision: number };
} {
  const raw = git(repo, [
    'log',
    '--reverse',
    '--no-merges',
    '--format=%x1e%s%x1f%b%x1d',
    '--name-only',
  ]);
  const counts = new Map<string, Map<string, number>>();
  let withTicket = 0;
  let seen = 0;
  let recall = 0;
  let hit = 0;
  let precision = 0;
  for (const chunk of raw.split('\x1e').slice(1)) {
    const end = chunk.indexOf('\x1d');
    if (end < 0) continue;
    const files = [
      ...new Set(
        chunk
          .slice(end + 1)
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      ),
    ];
    if (files.length === 0 || files.length > MAX_FILES_PER_CASE) continue;
    const tickets = extractTickets(chunk.slice(0, end));
    if (tickets.length === 0) continue;
    withTicket++;
    const score = new Map<string, number>();
    for (const t of tickets)
      for (const [f, n] of counts.get(t) ?? []) score.set(f, Math.max(score.get(f) ?? 0, n));
    if (score.size > 0) {
      seen++;
      // 훅과 같게 그 티켓으로 가장 많이 고친 파일만 남긴다
      const top = Math.max(...score.values());
      const picks = [...score]
        .filter(([, n]) => n === top)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(0, MAX_POINTERS)
        .map(([f]) => f);
      const hits = picks.filter((f) => files.includes(f)).length;
      recall += hits / Math.min(MAX_POINTERS, files.length);
      if (hits > 0) hit++;
      precision += hits / picks.length;
    }
    for (const t of tickets) {
      let m = counts.get(t);
      if (!m) counts.set(t, (m = new Map()));
      for (const f of files) m.set(f, (m.get(f) ?? 0) + 1);
    }
  }
  const n = Math.max(seen, 1);
  return {
    withTicket,
    seen,
    metrics: { recall: recall / n, hit: hit / n, precision: precision / n },
  };
}

function main(): void {
  const repo = git(arg('--repo') ?? process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const before = arg('--before') ?? '2026-09-04';
  const projects = join(homedir(), '.claude', 'projects');
  const match =
    arg('--sessions-match') ?? (process.argv.includes('--all-sessions') ? 'gestalt' : undefined);
  const sessions = match
    ? readdirSync(projects)
        // replay는 다른 평가가 임시 워크트리에서 돌린 세션이라 사람이 친 프롬프트가 아니다
        .filter((d) => d.includes(match) && !d.includes('replay'))
        .map((d) => join(projects, d))
    : [arg('--sessions') ?? join(projects, '-Users-kwon-david-dev-gestalt')].filter(existsSync);
  const t = git(repo, ['rev-list', '-1', `--before=${before}T00:00:00`, 'HEAD']).trim();
  if (!t) throw new Error(`${before} 이전 커밋이 없다`);

  const reuse = arg('--worktree');
  // macOS의 tmpdir은 /var → /private/var 심링크라 git toplevel과 안 맞으면 co-change를 건너뛴다
  const wt = reuse ?? join(realpathSync(mkdtempSync(join(tmpdir(), 'gestalt-eval-'))), 'wt');
  if (reuse) {
    const head = git(wt, ['rev-parse', 'HEAD']).trim();
    if (head !== t)
      throw new Error(`--worktree가 T(${t.slice(0, 10)})가 아니라 ${head.slice(0, 10)}에 있다`);
  } else git(repo, ['worktree', 'add', '--detach', '--quiet', wt, t]);
  try {
    if (!reuse) {
      const t0 = Date.now();
      const result = new CodeGraphEngine().build(wt, { mode: 'full' });
      process.stdout.write(
        `T = ${t.slice(0, 10)} (${before} 이전 마지막 커밋), 그래프 ${result.nodesBuilt}노드, 빌드 ${Date.now() - t0}ms\n`,
      );
    } else process.stdout.write(`T = ${t.slice(0, 10)}, 남겨둔 워크트리의 그래프를 쓴다\n`);
    const store = new CodeGraphStore(join(wt, '.gestalt', 'code-graph.db'));

    const commits = commitCases(repo, t, wt);
    report('커밋 재생', evaluate(store, wt, commits, true), evaluate(store, wt, commits, false));
    reportTickets(store, wt, commits);
    const rolling = rollingTicketEval(repo);
    process.stdout.write(
      `\n## 티켓 키 롤링 평가 (전체 이력)\n티켓 키가 든 커밋 ${rolling.withTicket}개 중 앞선 커밋에 같은 티켓이 있던 것 ${rolling.seen}개. ` +
        `그 ${rolling.seen}개에서 recall@3 ${pct(rolling.metrics.recall)}, 맞힌 비율 ${pct(rolling.metrics.hit)}, 넣었을 때 정밀도 ${pct(rolling.metrics.precision)}\n`,
    );

    if (sessions.length > 0) {
      const { cases, noEdit } = sessionCases(sessions, new Date(`${before}T00:00:00`), wt);
      report(
        `실제 프롬프트, 세션 디렉토리 ${sessions.length}개`,
        evaluate(store, wt, cases, true),
        evaluate(store, wt, cases, false),
      );
      reportTickets(store, wt, cases);
      process.stdout.write(
        `\n편집 없는 한글 프롬프트 ${noEdit.length}개 중 포인터를 넣은 비율 ${pct(injectRate(store, wt, noEdit))}\n`,
      );
    } else {
      process.stdout.write('\n세션 기록이 없어 실제 프롬프트 평가는 건너뛴다\n');
    }
    store.close();
  } finally {
    if (reuse) {
      // 남겨둔 워크트리는 다음 실행이 또 쓴다
    } else if (!process.argv.includes('--keep')) {
      git(repo, ['worktree', 'remove', '--force', wt]);
      rmSync(join(wt, '..'), { recursive: true, force: true });
    } else process.stdout.write(`\n워크트리를 남겼다: ${wt}\n`);
  }
}

// 다른 스크립트가 케이스 수집과 지표 함수만 가져다 쓸 수 있게 직접 실행할 때만 돈다
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
