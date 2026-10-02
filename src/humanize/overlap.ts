/**
 * 룰북 룰끼리 겹치는 자리를 찾는다.
 *
 * 룰북 PR 리뷰에서 "룰 두 개가 겹치면 어느 쪽이 이기나"가 반복해서 나왔다
 * (docs/experiments/2026-10-rule-overlap-check.md). 그 질문을 리뷰어가 찾기 전에 꺼낸다.
 *
 * 두 층으로 본다.
 * - 탐지기 행렬: 룰마다 금지 예시, 처방 예시, 예외 예시를 뽑아 전 룰 탐지기에 돌린다.
 *   결과가 룰북 문장과 어긋나면 결함이다.
 * - 겹침 후보: 탐지기로는 판정이 안 되는 겹침을 문장 단위로 추려 리뷰어에게 질문으로 넘긴다.
 *   이건 판정이 아니라 질문이라 게이트에 걸지 않는다.
 *
 * 탐지기는 주입받는다. 과거 커밋을 재현할 때 그 커밋의 탐지기로 돌려야 해서다.
 * 평소에는 `RULE_DETECTORS`를 넘긴다.
 */
import { detect, DETECTABLE_RULE_IDS } from './detectors.js';
import { citedRuleIds } from './rules.js';

const ANY_RULE_ID = /(?<![A-Za-z0-9-])([A-Z]{1,3}-\d{1,2})(?![0-9])/g;

/**
 * 문장이 부르는 룰 ID. `citedRuleIds`는 ai-tell 접두어(A~J)만 읽어서 comment-rules의
 * CM-, truncation-rules의 TR-를 못 본다. 범위 표기는 그쪽에 맡기고 나머지를 더한다.
 */
function ruleIdsIn(text: string): string[] {
  const ids = new Set(citedRuleIds(text));
  for (const m of text.matchAll(ANY_RULE_ID)) ids.add(m[1]!);
  return [...ids];
}

export type ExampleKind = 'before' | 'after' | 'exempt';

export interface RuleExample {
  ruleId: string;
  kind: ExampleKind;
  text: string;
  /** 예시가 나온 문장. 후보 질문에 그대로 붙인다 */
  sentence: string;
  line: number;
}

export interface RuleEntry {
  id: string;
  file: string;
  line: number;
  /** 행과 그 룰에 딸린 문단의 문장 전부 */
  sentences: RuleSentence[];
  examples: RuleExample[];
}

export interface RuleSentence {
  text: string;
  line: number;
  exception: boolean;
}

export interface DetectorSet {
  /** 탐지기가 있는 룰 ID */
  ids: readonly string[];
  /** 걸린 룰 ID와 걸린 문자열 */
  run: (text: string) => Array<{ ruleId: string; samples: string[] }>;
}

/** 이 레포 탐지기. 과거 커밋을 재현할 때는 그 커밋의 탐지기로 같은 꼴을 만들어 넘긴다 */
export const RULE_DETECTORS: DetectorSet = {
  ids: DETECTABLE_RULE_IDS,
  run: (text) => detect(text).map((d) => ({ ruleId: d.ruleId, samples: d.samples })),
};

export type FindingCode =
  | 'after-hit'
  | 'before-miss'
  | 'exempt-hit-self'
  | 'form-exempt-hit'
  | 'exempt-hit-other'
  | 'before-hit-other';

export interface MatrixFinding {
  code: FindingCode;
  /** error는 게이트를 막는다. info는 리뷰 단계에 보이기만 한다 */
  level: 'error' | 'info';
  ruleId: string;
  /** 걸린 탐지기 룰. before-miss는 자기 자신 */
  hitBy: string;
  example: RuleExample;
  message: string;
}

export type CandidateCode =
  | 'target-exempt-share'
  | 'exceptions-no-order'
  | 'cited-no-order'
  | 'shared-source';

export interface OverlapCandidate {
  code: CandidateCode;
  rules: string[];
  file: string;
  line: number;
  /** 리뷰어에게 넘길 질문 */
  question: string;
  evidence: string[];
}

export interface Undecidable {
  ruleId: string;
  file: string;
  line: number;
  before: number;
  exempt: number;
}

export interface OverlapReport {
  findings: MatrixFinding[];
  candidates: OverlapCandidate[];
  undecidable: Undecidable[];
}

/** 룰 표를 가진 문서만 룰북으로 본다. 표 머리가 "| ID | 패턴 |"이다 */
export function hasRuleTable(markdown: string): boolean {
  return /^\|\s*ID\s*\|\s*패턴\s*\|/m.test(markdown);
}

const RULE_ROW = /^\|\s*([A-Z]{1,3}-\d{1,2})\s*\|(.+)$/;
const ESCAPED_PIPE = '\u0000pipe\u0000';
const QUOTE = /"([^"\n]{1,60})"/g;

/**
 * 따옴표 하나가 예외 쪽에 놓였는지 보는 표지. "예외가 아니다", "예외로 안 본다"처럼
 * 뒤집는 꼴은 빼야 한다 — 그 문장은 오히려 대상을 늘린다.
 */
const EXCEPTION =
  /예외(?!가\s*아니|로\s*(?:안|보지)|가\s*되지|가\s*안|를\s*두지)|대상이\s*아니|대상에서\s*빠|비대상|에서만\s*(?:쓴다|남긴다|둔다)|그대로\s*(?:둔다|두지만)|빠진다|(?:안|못)\s*걸린다|Do-NOT/;

/**
 * 예외를 정의하는 문장. 따옴표 표지보다 좁다 — "예외가 전부 문맥이라 탐지기가 없다",
 * "서식으로만 예외를 주면"처럼 예외를 말하기만 하는 문장까지 세면 예외 개수가 부풀어
 * 순서 후보가 룰마다 뜬다.
 */
const EXCEPTION_DEF =
  /예외는|예외다|예외이다|대상이\s*아니다|에서만\s*(?:쓴다|남긴다|둔다)|그대로\s*둔다/;

/**
 * 탐지기가 형태로 거른다고 적은 문장. 여기 놓인 예외 예시를 자기 탐지기가 잡으면 룰북과
 * 탐지기가 같은 사실을 반대로 적은 것이다. 뜻으로 가르는 예외("문을 잠갔다")는 탐지기가
 * 걸고 사람이 다시 보는 게 정상이라 여기에 안 든다.
 */
const FORM_EXEMPT = /형태로\s*(?:빠지|빠진|빠져)|(?:안|못)\s*걸린다|자연히\s*안/;

/** 두 룰 사이에 경계를 긋는 말. 그냥 부르는 자리("F-10의 탐지기처럼")는 겹침 질문거리가 아니다 */
const BOUNDARY = /갈린다|갈리고|구별|경계/;

/**
 * 두 룰이 겹칠 때 어느 쪽으로 판정할지 정한 말.
 * "F-10이 본다"처럼 넘기는 꼴도 순서를 정한 것이다.
 */
const ORDER =
  /하나로\s*판정|하나로\s*본다|앞선다|먼저\s*(?:본다|판정|적용)|우선(?:한다|순위)|겹치면|최종형|함께\s*걸린다|도\s*걸린다|[이가]\s*본다|에\s*걸린다|안\s*겹친다|로\s*넘긴다/;

/** 처방을 내놓는 마디. 이 마디 안의 따옴표는 고친 꼴이다 */
const AFTER_CLAUSE =
  /(?:으로|로)\s*(?:쓴다|고친다|바꾼다|옮긴다|되돌린다|돌린다|환원|대체|대신)|환원한다|되돌린다|풀기|동사로|이렇게/;

/** 대상이라고 정해 말하는 마디. 이 마디 안의 따옴표는 금지 예시다 */
const TARGET_CLAUSE =
  /대상이(?:다|고|며|라)|(?<!안\s|못\s)걸린다|걸리고|금지|쓰지\s*않|가리키지\s*않|하지\s*않는다|지\s*말고|딱지|피해다|예외가\s*아니|예외로\s*안|예외가\s*되지/;

/**
 * 따옴표 바로 뒤 서술어. 마디보다 먼저 본다 — ""산출물"은 빠지고 "계측기"는 걸린다"처럼
 * 한 마디 안에서 따옴표마다 판정이 갈리는 자리가 있다.
 */
const EXEMPT_PREDICATE =
  /^\s*(?:은|는|도|만|이|가)?\s*(?:예외|대상이\s*아니|대상에서|빠지|빠진|그대로\s*(?:둔|쓴)|통과)/;
const TARGET_PREDICATE =
  /^\s*(?:은|는|이|가|도|을|를)?\s*(?:(?<!안\s|못\s)걸린|걸리(?!지\s*않)|대상이(?:다|고|며)|같은\s*자리|딱지)|^\s*처럼\s.*(?:도망가지|쓰지\s*않|지\s*말)/;
const AFTER_PREDICATE =
  /^\s*(?:으로|로)\s*(?:쓴다|고친다|바꾼다|옮긴다|되돌린다|돌린다|환원|대체|대신|풀)/;

const NOT_BUT = /^\s*(?:가|이)\s*아니라\s*$/;

function splitCells(row: string): string[] {
  return row
    .replace(/\\\|/g, ESCAPED_PIPE)
    .split('|')
    .map((cell) => cell.replaceAll(ESCAPED_PIPE, '|').trim());
}

/** 문장 끝 마침표로 자른다. 괄호 안 마침표나 소수점은 안 자른다 */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[다요음임함)"*`])\.(?=\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 따옴표 안이 예시가 아니라 표기법이면 뺀다 — "~에 대해(서)", "~를 통해/통하여" 같은 꼴이다.
 * 대문자 한 글자는 아무 명사 자리라 탐지기가 볼 수 있게 한글 한 글자로 바꾼다 — 탐지기
 * 상당수가 앞 글자가 한글인지를 본다("A에 대해 논의"는 A-1 탐지기에 안 걸린다).
 * 빗금은 예시 여럿을 나열한 표기라 나눈다. 가운뎃점은 C-12 예시 자체일 수 있어 여기서
 * 안 나누고 탐지할 때 나눈다 (variants).
 */
function normalizeExample(raw: string): string[] {
  if (raw.includes('~') || /^[-–]/.test(raw)) return [];
  const filled = raw.replace(/(?<![A-Za-z])[A-Z](?![A-Za-z])/g, '가');
  return filled
    .split('/')
    .map((s) => s.trim())
    .filter((s) => /[가-힣]/.test(s));
}

interface QuoteHit {
  text: string;
  start: number;
  end: number;
}

function quotesIn(sentence: string): QuoteHit[] {
  return [...sentence.matchAll(QUOTE)].map((m) => ({
    text: m[1]!,
    start: m.index!,
    end: m.index! + m[0]!.length,
  }));
}

/**
 * 문장을 마디로 자른다. 한 문장이 "~면 대상이고(…), ~면 예외다(…)"처럼 반대 판정을
 * 한꺼번에 들고 있어서 문장 단위로는 따옴표의 종류를 못 정한다.
 */
function clauseBounds(sentence: string): Array<[number, number]> {
  const bounds: Array<[number, number]> = [];
  const splitter = /\s—\s|(?<=\)),\s|;\s|(?<=[다고며])[,]\s/g;
  let start = 0;
  for (const m of sentence.matchAll(splitter)) {
    bounds.push([start, m.index!]);
    start = m.index! + m[0]!.length;
  }
  bounds.push([start, sentence.length]);
  return bounds;
}

type QuoteKind = ExampleKind | 'mention';

/**
 * 문장 하나에서 예시를 뽑아 종류를 붙인다.
 *
 * 마디 표지가 먼저고 문장 표지가 그다음이다. 표지가 아무것도 없는 따옴표는 예시가
 * 아니라 언급이다("F-8은 물리 "측량" 동사만 보므로") — 그걸 금지 예시로 세면 행렬이
 * 소음으로 찬다. 패턴 칸은 칸 전체가 금지라 기본값이 금지다.
 */
function classify(
  ruleId: string,
  sentence: string,
  line: number,
  fallback: QuoteKind,
): RuleExample[] {
  const quotes = quotesIn(sentence);
  const exceptional = EXCEPTION.test(sentence);
  const clauses = clauseBounds(sentence);

  const kinds: QuoteKind[] = quotes.map((quote, index) => {
    const [from, to] = clauses.find(([a, b]) => quote.start >= a && quote.start < b) ?? [
      0,
      sentence.length,
    ];
    const clause = sentence.slice(from, to);
    const lead = sentence.slice(from, quote.start);
    // 패턴 칸의 화살표는 원어에서 금지어로 간다 (`canonical → "정본"`)
    if (/→\s*\**\s*$/.test(lead)) return fallback === 'before' ? 'before' : 'after';
    if (/^\s*→/.test(sentence.slice(quote.end))) return 'before';

    // 나열된 따옴표("A", "B", "C"는 빠지고)는 마지막 따옴표 뒤 서술어를 함께 쓴다
    let last = index;
    while (
      quotes[last + 1] &&
      /^[\s,]*(?:이나|나|와|과|랑)?[\s,]*$/.test(
        sentence.slice(quotes[last]!.end, quotes[last + 1]!.start),
      )
    ) {
      last += 1;
    }
    const nextStart = quotes[last + 1]?.start ?? to;
    const predicate = sentence.slice(
      quotes[last]!.end,
      Math.min(nextStart, to, quotes[last]!.end + 30),
    );
    if (EXEMPT_PREDICATE.test(predicate)) return 'exempt';
    if (TARGET_PREDICATE.test(predicate)) return 'before';
    if (AFTER_PREDICATE.test(predicate)) return 'after';

    if (EXCEPTION.test(clause)) return 'exempt';
    if (TARGET_CLAUSE.test(clause)) return 'before';
    if (AFTER_CLAUSE.test(clause)) return 'after';
    if (exceptional) return 'exempt';
    return fallback;
  });

  quotes.forEach((quote, index) => {
    const next = quotes[index + 1];
    if (next && NOT_BUT.test(sentence.slice(quote.end, next.start))) {
      kinds[index] = 'before';
      kinds[index + 1] = 'after';
    }
  });

  const examples: RuleExample[] = [];
  quotes.forEach((quote, index) => {
    const kind = kinds[index]!;
    if (kind === 'mention') return;
    for (const text of normalizeExample(quote.text)) {
      examples.push({ ruleId, kind, text, sentence, line });
    }
  });
  return examples;
}

interface Heading {
  level: number;
  ids: string[];
}

/** 헤딩이 룰 하나만 부르면 그 아래 문단은 그 룰 몫이다 */
function headingIds(text: string): string[] {
  const ids = ruleIdsIn(text);
  return ids.length === 1 ? ids : [];
}

/** 문단 첫 볼드 구절에 룰 ID가 있으면 그 문단은 그 룰 몫이다 ("(F-9 오적용 주의)") */
function leadIds(text: string): string[] {
  const lead = text.match(/^\*\*([^*]+)\*\*/);
  return lead ? ruleIdsIn(lead[1]!) : [];
}

/**
 * 룰북 하나를 룰 단위로 읽는다.
 *
 * 룰은 표의 행에만 있지 않다. 행이 길어지면 상세를 표 아래 문단으로 빼서, 겹침 사례의
 * 절반이 그 문단에서 나왔다(ca3a2dbb의 '원본' 경계). 그래서 룰 하나만 부르는 헤딩 아래
 * 문단과 볼드 도입구가 룰을 부르는 문단을 그 룰에 붙인다.
 */
export function parseRuleEntries(markdown: string, file: string): RuleEntry[] {
  const entries = new Map<string, RuleEntry>();
  const lines = markdown.split('\n');
  let heading: Heading = { level: 0, ids: [] };
  let inFence = false;
  /** 대체어 표처럼 "쓰지 말 것 | 이렇게" 칸을 가진 표의 칸 위치 */
  let pairColumns: { before: number; after: number } | null = null;

  const entryOf = (id: string, line: number): RuleEntry => {
    let entry = entries.get(id);
    if (!entry) {
      entry = { id, file, line, sentences: [], examples: [] };
      entries.set(id, entry);
    }
    return entry;
  };

  /** 패턴 칸은 칸 전체가 금지라 표지 없는 따옴표를 금지 예시로 본다. 나머지는 언급이다 */
  const addProse = (entry: RuleEntry, text: string, line: number, fallback: QuoteKind) => {
    for (const sentence of sentencesOf(text)) {
      entry.sentences.push({ text: sentence, line, exception: EXCEPTION_DEF.test(sentence) });
      entry.examples.push(...classify(entry.id, sentence, line, fallback));
    }
  };

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const headingMatch = raw.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      heading = { level, ids: headingIds(headingMatch[2]!) };
      pairColumns = null;
      return;
    }

    const row = raw.match(RULE_ROW);
    if (row) {
      const id = row[1]!;
      const cells = splitCells(row[2]!);
      const entry = entryOf(id, lineNo);
      entry.line = lineNo;
      const pattern = cells[0] ?? '';
      const prescription = cells[cells.length - 2] ?? cells[cells.length - 1] ?? '';
      addProse(entry, pattern, lineNo, 'before');
      addProse(entry, prescription, lineNo, 'mention');
      return;
    }

    if (raw.startsWith('|')) {
      const cells = splitCells(raw.slice(1));
      const beforeCol = cells.findIndex((c) => c.includes('쓰지 말 것'));
      const afterCol = cells.findIndex((c) => c === '이렇게');
      if (beforeCol >= 0 && afterCol >= 0) {
        pairColumns = { before: beforeCol, after: afterCol };
        return;
      }
      const owner = heading.ids[0];
      if (pairColumns && owner && !/^\|[\s|:-]+$/.test(raw)) {
        const entry = entryOf(owner, lineNo);
        const pick = (col: number, kind: ExampleKind) => {
          const cell = (cells[col] ?? '').replace(/`/g, '');
          for (const part of cell.split(/\s*\/\s*|,\s*/)) {
            const text = part.replace(/"/g, '').trim();
            if (/[가-힣]/.test(text)) {
              entry.examples.push({ ruleId: owner, kind, text, sentence: raw, line: lineNo });
            }
          }
        };
        pick(pairColumns.before, 'before');
        pick(pairColumns.after, 'after');
      }
      return;
    }

    const text = raw.trim();
    if (!text) return;
    const owners = leadIds(text).length > 0 ? leadIds(text) : heading.ids;
    for (const id of owners) {
      // 표보다 문단이 먼저 나오면(머리말의 오적용 주의) 행 줄 번호는 행을 만날 때 고친다
      addProse(entryOf(id, lineNo), text, lineNo, 'mention');
    }
  });

  return [...entries.values()];
}

/**
 * 예시는 문장 조각이라 뒤에 공백을 붙여 돌린다. H-1처럼 낱말 뒤 공백을 요구하는 탐지기가
 * "또한" 하나만으로는 안 걸려서다.
 */
function hitsFor(detectors: DetectorSet, text: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const { ruleId, samples } of detectors.run(`${text} `)) map.set(ruleId, samples);
  return map;
}

/**
 * 가운뎃점으로 나열한 예시(`또한·따라서·즉`)는 낱낱이도 돌린다.
 * 통째로만 돌리면 다른 룰 예시가 전부 C-12에 걸린다. 낱낱으로만 돌리면 C-12 자기 예시를 놓친다.
 * 그래서 자기 룰은 둘 중 하나라도 걸리면 잡은 것으로, 다른 룰은 낱낱으로만 본다.
 */
function exampleHits(
  detectors: DetectorSet,
  text: string,
): { self: Map<string, string[]>; others: Map<string, string[]> } {
  const whole = hitsFor(detectors, text);
  if (!text.includes('·')) return { self: whole, others: whole };
  const parts = new Map<string, string[]>();
  for (const part of text.split('·')) {
    for (const [id, samples] of hitsFor(detectors, part.trim())) parts.set(id, samples);
  }
  return { self: new Map([...whole, ...parts]), others: parts };
}

/** 두 룰 사이에 순서를 정한 문장이 있는지. 어느 쪽 룰에 적혀 있어도 된다 */
function hasOrder(a: RuleEntry | undefined, b: RuleEntry | undefined): boolean {
  const mentions = (from: RuleEntry | undefined, to: string) =>
    (from?.sentences ?? []).some((s) => ruleIdsIn(s.text).includes(to) && ORDER.test(s.text));
  if (!a || !b) return false;
  return mentions(a, b.id) || mentions(b, a.id);
}

/**
 * 탐지기 행렬.
 *
 * - 처방(after)이 아무 탐지기에나 걸리면 룰북이 시키는 대로 고친 글이 다시 걸린다 (error)
 * - 예외로 둔 말을 다른 룰 탐지기가 잡으면 두 룰이 같은 말에 반대로 판정한다.
 *   둘 사이에 순서를 정한 문장이 없으면 error다
 * - 형태로 빠진다고 적은 예외를 자기 탐지기가 잡으면 선언과 탐지기가 갈라진 것이다 (error)
 * - 뜻으로 가르는 예외를 자기 탐지기가 잡는 건 룰북이 "넓게 건다"고 적어둔 룰이 많아 info다
 * - 금지 예시를 자기 탐지기가 못 잡는 건 룰북이 탐지기 범위를 좁혀 적어둔 자리가 섞여 info다
 * - 금지 예시가 다른 룰에도 걸리는 건 순서 문장이 없을 때만 보인다 (info)
 */
export function runMatrix(entries: RuleEntry[], detectors: DetectorSet): MatrixFinding[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const detectable = new Set(detectors.ids);
  const findings: MatrixFinding[] = [];
  const seen = new Set<string>();

  const push = (finding: MatrixFinding) => {
    const key = `${finding.code}|${finding.ruleId}|${finding.hitBy}|${finding.example.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  for (const entry of entries) {
    for (const example of entry.examples) {
      const { self, others: hits } = exampleHits(detectors, example.text);

      if (example.kind === 'after') {
        for (const [hitBy, samples] of self) {
          push({
            code: 'after-hit',
            level: 'error',
            ruleId: entry.id,
            hitBy,
            example,
            message: `${entry.id} 처방 "${example.text}"이 ${hitBy}에 걸린다 (${samples.join(', ')})`,
          });
        }
        continue;
      }

      if (example.kind === 'exempt') {
        for (const [hitBy, samples] of hits) {
          if (hitBy === entry.id && FORM_EXEMPT.test(example.sentence)) {
            push({
              code: 'form-exempt-hit',
              level: 'error',
              ruleId: entry.id,
              hitBy,
              example,
              message: `${entry.id}가 형태로 빠진다고 적은 "${example.text}"를 자기 탐지기가 잡는다 (${samples.join(', ')})`,
            });
            continue;
          }
          if (hitBy === entry.id) {
            push({
              code: 'exempt-hit-self',
              level: 'info',
              ruleId: entry.id,
              hitBy,
              example,
              message: `${entry.id}가 예외로 둔 "${example.text}"를 자기 탐지기가 잡는다 (${samples.join(', ')})`,
            });
            continue;
          }
          const ordered = hasOrder(entry, byId.get(hitBy));
          push({
            code: 'exempt-hit-other',
            level: ordered ? 'info' : 'error',
            ruleId: entry.id,
            hitBy,
            example,
            message: `${entry.id}가 예외로 둔 "${example.text}"를 ${hitBy}가 잡는다${ordered ? '' : ' — 둘 사이 순서를 정한 문장이 없다'}`,
          });
        }
        continue;
      }

      if (detectable.has(entry.id) && !self.has(entry.id)) {
        push({
          code: 'before-miss',
          level: 'info',
          ruleId: entry.id,
          hitBy: entry.id,
          example,
          message: `${entry.id} 금지 예시 "${example.text}"를 자기 탐지기가 못 잡는다`,
        });
      }
      for (const [hitBy] of hits) {
        if (hitBy === entry.id || hasOrder(entry, byId.get(hitBy))) continue;
        push({
          code: 'before-hit-other',
          level: 'info',
          ruleId: entry.id,
          hitBy,
          example,
          message: `${entry.id} 금지 예시 "${example.text}"가 ${hitBy}에도 걸린다 — 둘 사이 순서를 정한 문장이 없다`,
        });
      }
    }
  }

  return findings;
}

const JOSA_TAIL =
  /(?:에서는|에서|으로는|으로|로는|이라는|라는|이다|이고|이며|에는|에게|까지|부터|처럼|이나|은|는|이|가|을|를|에|의|와|과|도|만|로|다|요)$/;

/** 내용어 낱말. 조사를 떼고 두 글자 이상만 남긴다 */
export function contentWords(text: string): string[] {
  return (text.match(/[가-힣]+/g) ?? [])
    .map((w) => (w.length > 2 ? w.replace(JOSA_TAIL, '') : w))
    .filter((w) => w.length >= 2);
}

/** 한글 음절을 로마자 자음 뼈대로. 음차와 영어 원어가 같은 말인지 거칠게 맞춰 본다 */
// 초성 ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ, 종성은 대표음으로
const INITIAL = [
  'g',
  'g',
  'n',
  't',
  't',
  'r',
  'm',
  'b',
  'b',
  's',
  's',
  '',
  's',
  's',
  's',
  'g',
  't',
  'p',
  'h',
];
const FINAL = [
  '',
  'g',
  'g',
  'g',
  'n',
  'n',
  'n',
  't',
  'r',
  'g',
  'm',
  'b',
  's',
  't',
  'b',
  'r',
  'm',
  'b',
  'b',
  't',
  't',
  'ng',
  't',
  't',
  'g',
  't',
  'b',
  't',
];

export function hangulSkeleton(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)! - 0xac00;
    if (code < 0 || code > 11171) continue;
    out += INITIAL[Math.floor(code / 588)]! + FINAL[code % 28]!;
  }
  return out;
}

/** 영어를 같은 뼈대로. 한국어 음차가 구분하지 않는 자음을 한데 모은다 */
export function latinSkeleton(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/ph/g, 'p')
    .replace(/th/g, 't')
    .replace(/ch|sh|j|z|c(?=[eiy])|x/g, 's')
    .replace(/ck|q|c|k/g, 'g')
    .replace(/[aeiouwy]/g, '')
    .replace(/f/g, 'p')
    .replace(/v/g, 'b')
    .replace(/l/g, 'r')
    .replace(/d/g, 't')
    .replace(/(.)\1+/g, '$1');
}

function squeeze(skeleton: string): string {
  return skeleton.replace(/(.)\1+/g, '$1');
}

/** 영어 원어가 다른 룰의 음차와 같은 말인지 본다. 짧은 말은 우연히 맞아서 뺀다 */
function sameSource(latin: string, hangul: string): boolean {
  const a = latinSkeleton(latin);
  const b = squeeze(hangulSkeleton(hangul));
  if (a.length < 6 || b.length < 6) return false;
  return a === b;
}

/** 두 단어 이상 영어 구. "=low-hanging fruit", "(source of truth)" 같은 원어 표기다 */
function englishPhrases(text: string): string[] {
  return [...text.matchAll(/[A-Za-z][A-Za-z-]+(?:\s+[A-Za-z][A-Za-z-]+)+/g)].map((m) => m[0]!);
}

/** 두 단어 이상 한글 구. 음차는 낱말 사이를 띄어 쓴다 ("로우 행잉 프룻") */
function hangulPhrases(text: string): string[] {
  return [...text.matchAll(/[가-힣]+(?:\s+[가-힣]+){1,3}/g)].map((m) => m[0]!);
}

export interface CandidateOptions {
  /**
   * 이번 변경에서 새로 생긴 문장. 주면 그 문장이 끼는 후보만 남긴다.
   * 안 주면 전부 낸다 — 룰북 전체를 훑을 때다.
   */
  changed?: ReadonlySet<string>;
}

/**
 * 탐지기로 판정이 안 되는 겹침을 질문으로 뽑는다.
 *
 * 판정이 아니다. 같은 낱말이 금지와 예외에 함께 나온다고 다 모순은 아니다 —
 * "원본"처럼 어느 쪽인지 가르는 문장이 이미 있을 수 있다. 그래서 리뷰어가 읽을
 * 질문으로만 넘기고 게이트에 걸지 않는다.
 */
export function findCandidates(
  entries: RuleEntry[],
  options: CandidateOptions = {},
): OverlapCandidate[] {
  const { changed } = options;
  const isNew = (sentence: string) => !changed || changed.has(sentence);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const candidates: OverlapCandidate[] = [];

  for (const entry of entries) {
    // 1. 같은 룰 안에서 금지 예시와 예외 예시가 같은 낱말을 쓴다
    const targets = entry.examples.filter((e) => e.kind === 'before');
    const exempts = entry.examples.filter((e) => e.kind === 'exempt');
    const exceptions = entry.sentences.filter((s) => s.exception);
    const shared = new Map<string, { target: RuleExample; exempt: RuleExample }>();
    for (const target of targets) {
      const words = new Set(contentWords(target.text));
      for (const exempt of exempts) {
        // 한 문장이 둘을 맞세워 가르면 경계를 이미 그은 것이다
        if (exempt.sentence === target.sentence) continue;
        if (!isNew(exempt.sentence) && !isNew(target.sentence)) continue;
        for (const word of contentWords(exempt.text)) {
          if (words.has(word) && !shared.has(word)) shared.set(word, { target, exempt });
        }
      }
    }
    for (const [word, { target, exempt }] of shared) {
      candidates.push({
        code: 'target-exempt-share',
        rules: [entry.id],
        file: entry.file,
        line: exempt.line,
        question: `${entry.id}의 금지 예시 "${target.text}"와 예외 예시 "${exempt.text}"가 "${word}"를 함께 쓴다. 금지 예시가 이 예외로 빠지지 않나?`,
        evidence: [target.sentence, exempt.sentence],
      });
    }

    // 2. 예외가 둘 이상인데 둘이 같은 대상에 걸릴 때 순서가 없다
    if (exceptions.length >= 2 && exceptions.some((s) => isNew(s.text))) {
      const ordered = entry.sentences.some((s) => /앞선다|먼저|우선/.test(s.text));
      if (!ordered) {
        const fresh = exceptions.find((s) => isNew(s.text))!;
        candidates.push({
          code: 'exceptions-no-order',
          rules: [entry.id],
          file: entry.file,
          line: fresh.line,
          question: `${entry.id}에 예외가 ${exceptions.length}개인데 둘이 한 대상에 함께 걸리면 어느 쪽이 앞서는지 적혀 있지 않다. 새 예외가 기존 예외나 판정 기준과 반대로 가는 입력이 있나?`,
          evidence: exceptions.map((s) => s.text),
        });
      }
    }

    // 3. 다른 룰을 부르며 경계를 긋는데 둘 다 걸릴 때 어느 쪽인지 안 정했다
    for (const sentence of entry.sentences) {
      if (!isNew(sentence.text) || !BOUNDARY.test(sentence.text)) continue;
      for (const other of ruleIdsIn(sentence.text)) {
        if (other === entry.id || !byId.has(other)) continue;
        if (hasOrder(entry, byId.get(other))) continue;
        // `(F-4·F-5 오적용 주의)`처럼 두 룰이 함께 가진 문단은 한 룰 몫으로 읽는다
        if (byId.get(other)!.sentences.some((s) => s.text === sentence.text)) continue;
        candidates.push({
          code: 'cited-no-order',
          rules: [entry.id, other],
          file: entry.file,
          line: sentence.line,
          question: `${entry.id}가 ${other}와의 경계를 적었지만 둘에 함께 걸리는 말을 어느 쪽으로 판정할지 없다. ${other}의 예외가 ${entry.id} 대상을 면제하지 않나?`,
          evidence: [sentence.text],
        });
      }
    }
  }

  const cites = (from: RuleEntry, to: string) =>
    from.sentences.some((s) => ruleIdsIn(s.text).includes(to));

  // 4. 두 룰이 같은 영어 원어를 서로 다른 처방으로 다룬다 (음차와 직역)
  for (const a of entries) {
    for (const aSentence of a.sentences) {
      for (const phrase of englishPhrases(aSentence.text)) {
        for (const b of entries) {
          if (b.id === a.id) continue;
          if (cites(a, b.id) || cites(b, a.id)) continue;
          for (const bSentence of b.sentences) {
            if (!isNew(aSentence.text) && !isNew(bSentence.text)) continue;
            const match = hangulPhrases(bSentence.text).find((h) => sameSource(phrase, h));
            if (!match) continue;
            candidates.push({
              code: 'shared-source',
              rules: [a.id, b.id],
              file: a.file,
              line: aSentence.line,
              question: `${a.id}의 "${phrase}"와 ${b.id}의 "${match}"는 같은 원어다. 두 룰이 서로를 안 부른다 — 한쪽 처방대로 옮기면 다른 쪽에 걸리지 않나?`,
              evidence: [aSentence.text, bSentence.text],
            });
          }
        }
      }
    }
  }

  return dedupeCandidates(candidates);
}

function dedupeCandidates(candidates: OverlapCandidate[]): OverlapCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.code}|${[...c.rules].sort().join(',')}|${c.question}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 탐지기가 없어 자기 예시를 판정할 수 없는 룰. 건너뛰지 않고 목록으로 드러낸다 */
export function undecidableRules(entries: RuleEntry[], detectors: DetectorSet): Undecidable[] {
  const detectable = new Set(detectors.ids);
  return entries
    .filter((e) => !detectable.has(e.id))
    .map((e) => ({
      ruleId: e.id,
      file: e.file,
      line: e.line,
      before: e.examples.filter((x) => x.kind === 'before').length,
      exempt: e.examples.filter((x) => x.kind === 'exempt').length,
    }));
}

/** 이번 변경에서 새로 생긴 문장. 문장 단위로 비교해야 긴 행 한 칸의 수정이 행 전체로 번지지 않는다 */
export function changedSentences(base: RuleEntry[], head: RuleEntry[]): Set<string> {
  const old = new Set(base.flatMap((e) => e.sentences.map((s) => s.text)));
  return new Set(head.flatMap((e) => e.sentences.map((s) => s.text)).filter((s) => !old.has(s)));
}

export function checkOverlap(
  entries: RuleEntry[],
  detectors: DetectorSet,
  options: CandidateOptions = {},
): OverlapReport {
  return {
    findings: runMatrix(entries, detectors),
    candidates: findCandidates(entries, options),
    undecidable: undecidableRules(entries, detectors),
  };
}
