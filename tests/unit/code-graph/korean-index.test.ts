/**
 * 한국어 프롬프트 매칭 — 조사 떼기와 bigram, 주석 추출, 커밋 메시지 색인, 포인터 순위.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { CodeGraphEngine } from '../../../src/code-graph/engine.js';
import { CodeGraphStore } from '../../../src/code-graph/storage.js';
import {
  syncCoChange,
  COMMIT_TEXT_INDEX_KEY,
  type GitRunner,
} from '../../../src/code-graph/cochange.js';
import {
  bigrams,
  docText,
  extractTickets,
  koreanEojeols,
  stripSuffix,
} from '../../../src/code-graph/ko-text.js';
import { tokenizePrompt } from '../../../src/code-graph/hooks/rank.js';
import { evidenceLabel, rankPointers } from '../../../src/code-graph/hooks/pointers.js';

function sha(n: number): string {
  return n.toString(16).padStart(40, '0');
}

interface FakeCommit {
  files: string[];
  subject: string;
  body?: string;
  refs?: string;
}

/** GIT_LOG_FORMAT(`%x1e%H%x1f%D%x1f%s%x1f%b%x1d` + --name-only) 출력을 흉내낸다. 최신 커밋이 먼저다 */
function messageLog(commits: FakeCommit[], offset = 0): string {
  return commits
    .map((c, i) => ({ c, n: offset + i + 1 }))
    .reverse()
    .map(
      ({ c, n }) =>
        `\x1e${sha(n)}\x1f${c.refs ?? ''}\x1f${c.subject}\x1f${c.body ?? ''}\x1d\n${c.files.join('\n')}\n`,
    )
    .join('');
}

function fakeGit(
  root: string,
  head: string,
  full: string,
  range: Record<string, string> = {},
): GitRunner {
  return (_r, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return `${root}\n`;
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${head}\n`;
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'log') {
      const r = args.find((a) => a.includes('..'));
      return r ? (range[r] ?? '') : full;
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
}

function writeRepo(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

describe('한국어 토큰', () => {
  it('어절 끝의 조사와 어미를 뗀다', () => {
    expect(stripSuffix('점수가')).toBe('점수');
    expect(stripSuffix('인터뷰에서')).toBe('인터뷰');
    expect(stripSuffix('넘었는데')).toBe('넘었');
    expect(stripSuffix('고쳐해줘')).toBe('고쳐');
    expect(stripSuffix('해상도로')).toBe('해상도');
  });

  it('사전이 없어 "도"로 끝나는 낱말도 조사로 보고 자른다', () => {
    // 색인과 프롬프트가 같은 함수로 잘라서 매칭은 어긋나지 않는다. 라벨은 surface를 쓴다
    expect(stripSuffix('해상도')).toBe('해상');
    expect(koreanEojeols('해상도')[0]).toEqual({
      stem: '해상',
      surface: '해상도',
      terms: ['해상'],
    });
  });

  it('떼고 남는 줄기가 1음절이면 안 뗀다', () => {
    expect(stripSuffix('아이')).toBe('아이');
    expect(stripSuffix('값이')).toBe('값이');
  });

  it('줄기를 음절 bigram으로 쪼개고 1음절은 그대로 둔다', () => {
    expect(bigrams('인터뷰')).toEqual(['인터', '터뷰']);
    expect(bigrams('점수')).toEqual(['점수']);
    expect(bigrams('값')).toEqual(['값']);
    expect(bigrams('')).toEqual([]);
  });

  it('어절마다 줄기와 bigram을 내고 불용어와 중복 줄기는 뺀다', () => {
    const e = koreanEojeols('이거 인터뷰 점수가 점수는 좀 이상해 calculateTotal 확인해줘');
    expect(e.map((x) => x.stem)).toEqual(['인터뷰', '점수', '이상해']);
    expect(e[0]!.terms).toEqual(['인터', '터뷰']);
  });

  it('영문에 바로 붙은 조사는 어절로 치지 않는다', () => {
    const e = koreanEojeols('calculateTotal에서 rules가 `push`를 고쳐');
    expect(e.map((x) => x.stem)).toEqual(['고쳐']);
    expect(koreanEojeols('API호출 실패').map((x) => x.stem)).toEqual(['호출', '실패']);
  });

  it('티켓 키를 뽑고 표준 이름은 뺀다', () => {
    expect(extractTickets('[CT-31408] 결제 오류, feature/BIZRES-12636 브랜치')).toEqual([
      'CT-31408',
      'BIZRES-12636',
    ]);
    expect(extractTickets('UTF-8 SHA-256 ISO-8601 ES-2022')).toEqual([]);
    expect(extractTickets('ct-123 xCT-1')).toEqual([]);
  });

  it('주석 기호를 걷고 한글 없는 주석은 버린다', () => {
    expect(docText('/**\n * 해상도 점수를\n * 계산한다\n */')).toBe('해상도 점수를 계산한다');
    expect(docText('// 정산 주기')).toBe('정산 주기');
    expect(docText('/** English only */')).toBeUndefined();
    expect(docText(`// ${'가'.repeat(1000)}`)!.length).toBe(400);
  });
});

describe('TS 주석 추출', () => {
  let root: string;
  let store: CodeGraphStore;
  const engine = new CodeGraphEngine();

  beforeAll(() => {
    root = resolve('.gestalt-test', `ko-doc-${randomUUID()}`);
    writeRepo(root, {
      'src/pay.ts': [
        '#!/usr/bin/env node',
        '/**',
        ' * 결제 모듈. 환불과 정산을 맡는다.',
        ' */',
        "import { join } from 'node:path';",
        '',
        '/** 환불 금액을 계산한다 */',
        'export function refundAmount(): number {',
        '  return join.length;',
        '}',
        '',
        '// 정산 주기를 돌려준다',
        'export const settlePeriod = () => 1;',
        '',
        '// 떨어진 주석',
        '',
        'export function detached() {}',
        '',
        '/** English only */',
        'export class Ledger {}',
        '',
      ].join('\n'),
      'src/first.ts': '/** 첫 문장에 붙은 주석 */\nexport function first() {}\n',
    });
    engine.build(root, { mode: 'full' });
    store = new CodeGraphStore(join(root, '.gestalt', 'code-graph.db'));
  });

  afterAll(() => {
    store.close();
    engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  const docOf = (file: string, name: string) =>
    store.getNodesByFile(join(root, file)).find((n) => n.name === name)?.doc;

  it('JSDoc과 줄 주석을 심볼에 붙인다', () => {
    expect(docOf('src/pay.ts', 'refundAmount')).toBe('환불 금액을 계산한다');
    expect(docOf('src/pay.ts', 'settlePeriod')).toBe('정산 주기를 돌려준다');
  });

  it('빈 줄로 떨어진 주석과 한글 없는 주석은 안 붙인다', () => {
    expect(docOf('src/pay.ts', 'detached')).toBeUndefined();
    expect(docOf('src/pay.ts', 'Ledger')).toBeUndefined();
  });

  it('shebang 뒤 파일 머리 주석은 파일 노드에 붙인다', () => {
    expect(docOf('src/pay.ts', 'pay.ts')).toBe('결제 모듈. 환불과 정산을 맡는다.');
  });

  it('첫 문장에 붙은 머리 주석은 파일이 아니라 그 심볼 것이다', () => {
    expect(docOf('src/first.ts', 'first.ts')).toBeUndefined();
    expect(docOf('src/first.ts', 'first')).toBe('첫 문장에 붙은 주석');
  });
});

describe('주석 색인 갱신', () => {
  it('주석을 고쳐 다시 빌드하면 옛 단어가 남지 않는다', () => {
    const root = resolve('.gestalt-test', `ko-doc-update-${randomUUID()}`);
    const engine = new CodeGraphEngine();
    try {
      writeRepo(root, { 'src/a.ts': '/** 환불 금액 */\nexport function a() {}\n' });
      engine.build(root, { mode: 'full' });
      writeRepo(root, { 'src/a.ts': '/** 정산 주기 */\nexport function a() {}\n' });
      engine.build(root, { mode: 'full' });
      const store = new CodeGraphStore(join(root, '.gestalt', 'code-graph.db'));
      expect(store.getDocTermHits(['환불'], 10)).toEqual([]);
      expect(store.getDocTermHits(['정산'], 10).map((h) => h.nodeId)).toHaveLength(1);
      store.close();
    } finally {
      engine.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('커밋 메시지 색인', () => {
  let root: string;
  let store: CodeGraphStore;

  beforeEach(() => {
    root = resolve('.gestalt-test', `ko-commit-${randomUUID()}`);
    mkdirSync(join(root, '.gestalt'), { recursive: true });
    store = new CodeGraphStore(join(root, '.gestalt', 'code-graph.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const base: FakeCommit[] = [
    { files: ['src/a.ts'], subject: 'fix(a): 해상도 점수 보정', refs: 'origin/feat/CT-1' },
    { files: ['src/a.ts', 'src/b.ts'], subject: '[CT-1] 해상도 경계값', body: '본문의 정산 설명' },
  ];

  it('커밋마다 bigram과 파일을 쌓고 브랜치 이름의 티켓도 잇는다', () => {
    syncCoChange(store, root, { mode: 'full', runGit: fakeGit(root, sha(2), messageLog(base)) });
    const hits = store.getCommitTermHits(['해상', '정산'], 100);
    expect(
      hits
        .filter((h) => h.term === '해상')
        .map((h) => h.sha)
        .sort(),
    ).toEqual([sha(1), sha(2)]);
    expect(hits.filter((h) => h.term === '정산').map((h) => h.sha)).toEqual([sha(2)]);

    const commits = store.getTextCommits([sha(1), sha(2)]).sort((x, y) => x.seq - y.seq);
    expect(commits.map((c) => c.sha)).toEqual([sha(1), sha(2)]);
    expect(commits[1]!.files.sort()).toEqual([join(root, 'src/a.ts'), join(root, 'src/b.ts')]);

    const tickets = store.getTicketFiles(['CT-1']);
    expect(tickets.find((t) => t.filePath === join(root, 'src/a.ts'))!.count).toBe(2);
  });

  it('증분 수집은 새 커밋만 뒤에 붙이고 기존 색인을 그대로 둔다', () => {
    syncCoChange(store, root, { mode: 'full', runGit: fakeGit(root, sha(2), messageLog(base)) });
    const next: FakeCommit[] = [{ files: ['src/a.ts'], subject: '[CT-1] 해상도 반올림' }];
    syncCoChange(store, root, {
      mode: 'incremental',
      runGit: fakeGit(root, sha(3), '', { [`${sha(2)}..HEAD`]: messageLog(next, 2) }),
    });

    const commits = store.getTextCommits([sha(1), sha(2), sha(3)]).sort((x, y) => x.seq - y.seq);
    expect(commits.map((c) => [c.sha, c.seq])).toEqual([
      [sha(1), 1],
      [sha(2), 2],
      [sha(3), 3],
    ]);
    expect(store.getCommitTermHits(['해상'], 100)).toHaveLength(3);
    expect(store.getTicketFiles(['CT-1']).find((t) => t.filePath.endsWith('a.ts'))!.count).toBe(3);

    // HEAD가 그대로면 다시 안 읽어서 중복도 안 생긴다
    syncCoChange(store, root, { mode: 'incremental', runGit: fakeGit(root, sha(3), '') });
    expect(store.getCommitTermHits(['해상'], 100)).toHaveLength(3);
  });

  it('색인 버전이 다른 DB는 증분 요청에도 전량 다시 읽는다', () => {
    syncCoChange(store, root, { mode: 'full', runGit: fakeGit(root, sha(2), messageLog(base)) });
    store.setMeta(COMMIT_TEXT_INDEX_KEY, 'old');
    const summary = syncCoChange(store, root, {
      mode: 'incremental',
      runGit: fakeGit(root, sha(3), messageLog(base)),
    });
    expect(summary?.mode).toBe('full');
    expect(store.getCommitTermHits(['해상'], 100)).toHaveLength(2);
  });

  it('파일을 너무 많이 건드린 커밋은 색인하지 않는다', () => {
    const wide = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
    syncCoChange(store, root, {
      mode: 'full',
      runGit: fakeGit(root, sha(1), messageLog([{ files: wide, subject: '전체 포맷 정리 PAY-9' }])),
    });
    expect(store.getCommitTermHits(['포맷'], 100)).toEqual([]);
    expect(store.getTicketFiles(['PAY-9'])).toEqual([]);
  });
});

describe('한국어 포인터', () => {
  let root: string;
  let store: CodeGraphStore;
  const engine = new CodeGraphEngine();

  // 흔한 낱말이 IDF로 눌리도록 상관없는 커밋을 깔아둔다. 아래 낱말과 bigram이 겹치지 않게 골랐다
  const FILLER = ['메뉴', '화면', '버튼', '색상', '글꼴', '로그', '캐시', '배포', '설치', '문서'];

  beforeAll(() => {
    root = resolve('.gestalt-test', `ko-pointer-${randomUUID()}`);
    writeRepo(root, {
      'src/interview/scorer.ts':
        '/** 인터뷰 응답으로 해상도를 매긴다 */\nexport function computeResolution(): number {\n  return 0.8;\n}\n',
      'src/billing/refund.ts': 'export function processRefund(): void {}\n',
      'src/app.ts': 'export function main(): void {}\n',
    });
    engine.build(root, { mode: 'full' });
    store = new CodeGraphStore(join(root, '.gestalt', 'code-graph.db'));

    const commits: FakeCommit[] = [];
    for (let i = 0; i < 200; i++) {
      const a = FILLER[i % FILLER.length]!;
      const b = FILLER[(i * 7 + 3) % FILLER.length]!;
      const c = FILLER[(i * 3 + 1) % FILLER.length]!;
      commits.push({ files: ['src/app.ts'], subject: `${a} ${b} ${c} 레이아웃 손질` });
    }
    commits.push(
      { files: ['src/interview/scorer.ts'], subject: 'fix(interview): 해상도 점수 경계값 보정' },
      { files: ['src/interview/scorer.ts'], subject: '해상도 점수 반올림 오류' },
      { files: ['src/interview/scorer.ts', 'src/app.ts'], subject: '인터뷰 해상도 점수 기준 상향' },
      { files: ['src/billing/refund.ts'], subject: '[PAY-123] 환불 정산 금액 오류' },
    );
    syncCoChange(store, root, {
      mode: 'full',
      runGit: fakeGit(root, sha(999), messageLog(commits)),
    });
    store.refreshTextIndexStats();
  });

  afterAll(() => {
    store.close();
    engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  const rank = (prompt: string) => rankPointers(store, root, tokenizePrompt(prompt), 3);

  it('한글로만 쓴 프롬프트가 그 말로 고친 파일을 찾는다', () => {
    const picks = rank('해상도 점수가 0.8 넘었는데 완료가 안 돼요');
    expect(picks[0]?.relPath).toBe('src/interview/scorer.ts');
    expect(evidenceLabel(picks[0]!)).toBe(' (커밋 "해상도 점수가" 3건)');
  });

  it('무관한 한글 프롬프트는 아무것도 안 넣는다', () => {
    expect(rank('주말에 등산 가려는데 날씨 어때요')).toEqual([]);
  });

  it('한 어절만 맞으면 안 넣는다', () => {
    expect(rank('해상도 좀 알려줘요')).toEqual([]);
  });

  it('티켓 키는 다른 신호 없이도 그 파일을 1위로 올린다', () => {
    const picks = rank('PAY-123 다시 봐줘요');
    expect(picks[0]?.relPath).toBe('src/billing/refund.ts');
    expect(evidenceLabel(picks[0]!)).toContain('티켓 PAY-123 1건');
  });

  it('korean을 끄면 한국어 신호를 안 쓴다', () => {
    const t = tokenizePrompt('해상도 점수가 0.8 넘었는데 완료가 안 돼요');
    expect(rankPointers(store, root, t, 3, { korean: false })).toEqual([]);
  });
});
