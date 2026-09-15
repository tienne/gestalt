#!/usr/bin/env tsx
/**
 * 룰북에서 Claude Code output style `Tienne Voice`를 뽑아 홈으로 내보낸다.
 *
 * output style은 모든 세션에 항상 켜져 있어 어투를 강제하는 자리인데,
 * 지금까지 룰북에서 손으로 추려낸 스냅샷이라 룰 심각도를 바꿔도 따라오지 않았다.
 * 여기서 룰북을 읽어 다시 뽑는다 — 산문은 템플릿이 갖고, 룰 목록만 생성한다.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  citedRuleIds,
  parseRuleBook,
  s1Ids,
  type Rule,
  type RuleBook,
} from '../src/humanize/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, 'templates/tienne-voice.md');
const DEFAULT_OUT = join(homedir(), '.claude/output-styles/tienne-voice.md');

/**
 * 자가점검 게이트. 그룹 이름과 묶을 룰만 정하고 표기는 룰북에서 읽는다.
 * 여기 적힌 ID가 룰북에서 사라지거나 대화 S1이 아니게 되면 빌드가 멈춘다.
 *
 * 이 목록은 항상 켜진 프롬프트라 한 줄이 매 세션 비용이다. 룰을 더할 때 자동으로
 * 따라오지 않는다 — 룰북에만 두는 것도 정상 상태다. 넣을지는 그 룰이 실제로
 * 답변에서 반복해 나오는지를 보고 정한다.
 *
 * 넣기로 정했으면 SPOTLIGHT에도 같이 넣는다. 대화 기준 S1인 룰만 들어온다.
 * 아래 verify가 두 조건을 검사 대상으로 삼는다.
 */
const GATE: { name: string; ids: string[] }[] = [
  { name: '번역투', ids: ['A-1', 'A-3', 'A-7'] },
  { name: '결산 피벗', ids: ['D-1'] },
  { name: 'hype 어휘', ids: ['D-3', 'D-4'] },
  { name: '과잉 자책', ids: ['D-8'] },
  { name: '의인화 주어', ids: ['D-5'] },
  { name: '명사구 압축', ids: ['F-6'] },
  { name: '기술 비유 명사', ids: ['F-7'] },
  { name: '사무투 분류사', ids: ['I-5'] },
  { name: '측량투 명사', ids: ['I-6'] },
  { name: '리뷰 코멘트 호칭', ids: ['I-7'] },
  { name: '형식명사 수준', ids: ['I-8'] },
  { name: '추상명사 동사 결합', ids: ['D-9', 'F-8'] },
  { name: '가운뎃점 나열', ids: ['C-12'] },
  { name: '수량 예고', ids: ['C-14'] },
  { name: '명사구 종결', ids: ['E-8'] },
  { name: '화자 소거', ids: ['G-4'] },
  { name: '결함·원인 비유', ids: ['F-9'] },
  { name: '관용구 물리 동사', ids: ['F-10'] },
];

/**
 * 금지 목록에 펼칠 룰. 대화 S1 전부가 아니라 실제로 자주 걸리는 것만 고른다.
 * C-5(이모지 남발)처럼 칼럼·리포트 기준인 룰은 대화 어투와 충돌해서 뺐다.
 */
const SPOTLIGHT = [
  'A-1',
  'A-2',
  'A-3',
  'A-5',
  'A-7',
  'A-8',
  'B-3',
  'C-10',
  'C-12',
  'C-14',
  'D-1',
  'D-3',
  'D-4',
  'D-5',
  'D-8',
  'D-9',
  'E-8',
  'F-4',
  'F-5',
  'F-6',
  'F-7',
  'F-8',
  'F-9',
  'F-10',
  'G-4',
  'H-1',
  'I-1',
  'I-5',
  'I-6',
  'I-7',
  'I-8',
];

/**
 * 처방 칸에서 금지 목록에 꼭 실을 문장. 룰 ID와 그 문장을 가리키는 조각이다.
 *
 * shortPrescription은 처방을 앞 문장부터 담다가 멈춘다. 처방이 두 문장 이하인 룰이
 * 46개고 세 문장 이상이 22개인데, F-9(13문장)와 F-10(13문장)은 그다음으로 긴 B-3보다도
 * 갑절이라 뒤쪽 판정 기준에 영영 안 닿는다. 상한을 올려도 사이 문장들이 먼저 자리를
 * 채운다. 룰북의 문장 차례는 사람이 읽는 순서이지 중요도 순서가 아니라서 그렇다.
 *
 * 세 문장 이상인 나머지 스무 개도 뒤쪽이 잘리기는 한다. E-8과 I-5가 그런 자리인데
 * 잘리는 게 예외 조항이라 룰이 넓게 걸리는 쪽으로 어긋난다. 이번엔 안 올렸다.
 *
 * GATE, SPOTLIGHT와 같은 성격이다 — 룰을 더할 때 자동으로 안 따라오고 룰북에만 두는
 * 것도 정상 상태다. 여기 올리면 그 룰의 줄이 HOIST_MAX만큼 길어지고 그만큼이 매 세션
 * 비용이다. 안 올린 룰의 줄은 한 글자도 안 바뀐다. 올릴지는 그 판정 기준이 실제로
 * 답변에서 어긋나는지를 보고 정한다.
 *
 * 올리는 룰은 SPOTLIGHT에도 있어야 한다. 금지 목록에 없는 룰은 올려도 한 글자도 안
 * 실리고 verify가 그 자리를 본다.
 *
 * 조각은 룰북을 안 고치고 문장 하나만 가리키게 쓴다. 처방에서 못 찾거나 두 문장에
 * 걸리면 verify가 빌드를 세운다 — 룰북을 손보다 문장이 바뀌면 그 자리에서 드러난다.
 */
export const HOIST: Record<string, string> = {
  'F-9': '"뿌리"는 root 한 단어가',
};

const PATTERN_MAX = 44;
export const PRESCRIPTION_MAX = 76;
const EXAMPLE_MAX = 40;
/** HOIST가 올린 문장의 상한. 올린 룰의 줄만 이만큼 길어진다 */
export const HOIST_MAX = 76;

/** 룰 ID 나열은 목록이라 C-12 예외다. 나머지 가운뎃점은 산문으로 새므로 쉼표로 편다 */
const RULE_ID_CHAIN = /^[A-J]-\d{1,2}(?:·[A-J]-\d{1,2})+$/;

/** 가운뎃점 자체가 대상인 룰은 예시를 쉼표로 펴면 뭘 금지하는지가 사라진다 */
const KEEP_MIDDLE_DOT = new Set(['C-12']);

/**
 * 룰북 처방 앞에 붙은 빈도 조건은 문서 기준이다.
 * 대화·리뷰는 1회부터 교정하므로(룰북 앞머리의 "말투 감도" 안내) 조건절을 걷어낸다.
 * 문장 중간은 건드리지 않는다 — 지우면 남은 절이 어그러진다.
 */
const DOC_FREQUENCY = [/^\d+회\s*(초과|이상)\s*시\s*/, /^반복분만\s*/];

/** 문서 기준 예외를 설명하는 문장. 대화 어투에는 오해만 준다 */
const DOC_ONLY_EVIDENCE = /문서 산문|대조 코퍼스|KatFish|\(\S+\s*\d{4}\)/;

function unchain(text: string): string {
  return text.replace(/[가-힣A-Za-z0-9~-]+(?:·[가-힣A-Za-z0-9~-]+)+/g, (chain) =>
    RULE_ID_CHAIN.test(chain) ? chain : chain.split('·').join(', '),
  );
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** 패턴 칸은 조건과 근거까지 담고 있다. 무엇이 걸리는지만 남긴다 */
function shortPattern(pattern: string): string {
  let text = pattern.replace(/\*\*/g, '').replace(/`/g, '');

  // 부연은 대시 뒤에 붙는다
  text = text.split(' — ')[0]!.trim();

  // 긴 괄호는 예시다. 짧은 건 "(서)"처럼 이름의 일부라 남긴다
  const paren = text.search(/\s*\([^)]{12,}/);
  const dropped = paren >= 0 ? text.slice(paren).trim() : '';
  if (paren >= 0) text = text.slice(0, paren).trim();

  // 빈도 조건은 대화에서 1회부터 걸리므로 지운다
  text = text.replace(/\s*(한 글에\s*)?\d+회\s*(이상|\+)?(\s*반복)?$/, '');
  text = text.replace(/\s*(단락|연속)\s*[≥>]=?\s*\d+회.*$/, '');
  text = text.replace(/\s*연속\s*\d+회\+?$/, '');
  text = text.replace(/\s{2,}/g, ' ').trim();

  // 이름만 남으면 뭐가 걸리는지 안 보인다. 잘라낸 예시를 짧게 되붙인다
  if (text.length < 18 && dropped) {
    const inner = dropped
      .replace(/^\(|\)$/g, '')
      .split(/[,·]/)
      .map((part) => part.trim())
      .slice(0, 3)
      .join(', ');
    text = `${text}(${inner})`;
  }

  return clamp(unchain(text), PATTERN_MAX);
}

/** 대화 어투 기준으로 처방을 씻어 문장으로 나눈다. 아래 셋이 같은 목록을 본다 */
export function prescriptionSentences(prescription: string): string[] {
  let text = prescription.replace(/\*\*/g, '').replace(/`/g, '').trim();

  // 영어 원문 예시는 대화 어투 참고에 쓸모가 없고 자리만 차지한다
  text = text.replace(/\("[^"]*[A-Za-z]{4}[^"]*"\s*→\s*/g, '(');

  for (const condition of DOC_FREQUENCY) text = text.replace(condition, '');
  text = text.trim().replace(/^,\s*/, '');

  return text.split(/(?<=\.)\s+/);
}

/**
 * 처방은 근거 문헌까지 이어진다. 무엇으로 바꾸는지까지만 남긴다.
 *
 * `kept`는 산출 문자열에 온전히 남은 문장 수다. 마지막 문장이 상한에 잘리면 담은 수보다
 * 하나 적다 — 아래 중복 검사가 이 값을 봐야 잘린 문장을 실렸다고 오해하지 않는다.
 */
export function shortPrescription(sentences: string[]): { text: string; kept: number } {
  let out = '';
  let taken = 0;

  for (const sentence of sentences) {
    if (out && DOC_ONLY_EVIDENCE.test(sentence)) break;
    if (out && out.length + sentence.length > PRESCRIPTION_MAX) break;
    out = out ? `${out} ${sentence}` : sentence;
    taken += 1;
    if (out.length >= 28) break;
  }

  const trimmed = unchain(out.replace(/\.$/, ''));
  const text = clamp(trimmed, PRESCRIPTION_MAX);

  return { text, kept: text === trimmed ? taken : taken - 1 };
}

/** HOIST 조각이 걸리는 문장 자리를 전부 준다. 아래 둘이 이 하나를 같이 본다 */
export function hoistHits(sentences: string[], needle: string): number[] {
  return sentences.flatMap((sentence, at) => (sentence.includes(needle) ? [at] : []));
}

/**
 * 금지 목록 한 줄의 처방 칸. 앞 문장 요약 뒤에 HOIST가 올린 문장을 잇는다.
 *
 * 중복은 문자열이 아니라 문장 자리로 거른다. 앞 요약은 clamp와 unchain을 거쳐 원문과
 * 달라지므로 포함 검사로는 같은 문장인지 못 가른다.
 */
export function bannedPrescription(rule: Rule, hoist: Record<string, string> = HOIST): string {
  const sentences = prescriptionSentences(rule.prescription);
  const { text, kept } = shortPrescription(sentences);

  const needle = hoist[rule.id];
  if (needle === undefined) return text;

  // verify가 조각이 문장 하나만 가리키는지 이미 봤다. kept 안쪽이면 앞 요약이 그 문장을 담았다
  const hits = hoistHits(sentences, needle);
  const at = hits.length === 1 ? hits[0]! : -1;
  if (at < 0 || at < kept) return text;

  return `${text}. ${clamp(unchain(sentences[at]!.replace(/\.$/, '')), HOIST_MAX)}`;
}

/** 자가점검에 붙일 예시. 룰북이 따옴표나 괄호로 적어둔 걸린 말들을 그대로 쓴다 */
function example(id: string, pattern: string): string {
  const quoted = pattern.match(/"([^"]{2,})"/);
  const parened = pattern.match(/\(([^)]{4,})\)/);
  const raw = quoted?.[1] ?? parened?.[1] ?? shortPattern(pattern);
  const shown = raw.split('/').slice(0, 3).join(' / ');
  return clamp(KEEP_MIDDLE_DOT.has(id) ? shown : unchain(shown), EXAMPLE_MAX);
}

function renderBanned(book: RuleBook): string {
  return SPOTLIGHT.map((id) => {
    const rule = book.rules.get(id)!;
    const name = KEEP_MIDDLE_DOT.has(id)
      ? rule.pattern.split(' — ')[0]!.trim()
      : shortPattern(rule.pattern);
    return `- **${id} ${clamp(name, PATTERN_MAX)}** → ${bannedPrescription(rule)}`;
  }).join('\n');
}

function renderSelfCheck(book: RuleBook): string {
  return GATE.map((group, index) => {
    const shown = group.ids.map((id) => example(id, book.rules.get(id)!.pattern)).join(' / ');
    const ids = group.ids.join(', ');
    return `${index + 1}. ${group.name}(${shown}) 없는가 — ${ids}`;
  }).join('\n');
}

/** 템플릿과 상수가 인용한 ID가 룰북에 살아있고 대화 S1인지 본다 */
function verify(book: RuleBook, template: string): string[] {
  const errors: string[] = [];
  const chatS1 = new Set(s1Ids(book, 'chat'));
  const declared = [...new Set([...SPOTLIGHT, ...GATE.flatMap((g) => g.ids)])];

  for (const id of declared) {
    if (!book.rules.get(id)) {
      errors.push(`${id}: 룰북에 없는 ID를 build-output-style.ts가 인용합니다`);
      continue;
    }
    if (!chatS1.has(id)) {
      errors.push(`${id}: 대화 기준 S1이 아닌데 output style이 강제합니다`);
    }
  }

  const spotlight = new Set(SPOTLIGHT);

  // 올려둔 조각이 실제로 문장 하나를 가리키는지 본다. 룰북 문장이 바뀌면 여기서 걸린다
  for (const [id, needle] of Object.entries(HOIST)) {
    const rule = book.rules.get(id);
    if (!rule) {
      errors.push(`${id}: HOIST가 룰북에 없는 ID를 가리킵니다`);
      continue;
    }
    if (!spotlight.has(id)) {
      errors.push(`${id}: HOIST에 올렸는데 금지 목록에 없습니다 (SPOTLIGHT에 추가하세요)`);
    }

    const hits = hoistHits(prescriptionSentences(rule.prescription), needle);
    if (hits.length !== 1) {
      const why = hits.length === 0 ? '못 찾습니다' : `문장 ${hits.length}개에 걸립니다`;
      errors.push(
        `${id}: scripts/build-output-style.ts 의 HOIST 조각을 처방에서 ${why}. ` +
          `룰북 문장을 고쳤으면 조각도 맞추세요 — "${needle}"`,
      );
    }
  }

  for (const group of GATE) {
    for (const id of group.ids) {
      if (!spotlight.has(id)) {
        errors.push(`${id}: 자가점검이 부르는데 금지 목록에 없습니다 (SPOTLIGHT에 추가하세요)`);
      }
    }
  }

  // 템플릿 산문(Before/After 표)이 인용한 ID도 같은 기준으로 본다
  for (const id of citedRuleIds(template)) {
    if (!book.rules.has(id)) {
      errors.push(`${id}: 템플릿이 룰북에 없는 ID를 인용합니다`);
    } else if (!chatS1.has(id)) {
      errors.push(`${id}: 템플릿이 대화 S1이 아닌 룰을 근거로 듭니다`);
    }
  }

  return errors;
}

export function buildOutputStyle(): string {
  const book = parseRuleBook();
  const template = readFileSync(TEMPLATE_PATH, 'utf-8');

  const errors = verify(book, template);
  if (errors.length > 0) {
    throw new Error(`룰북과 어긋납니다:\n  ${errors.join('\n  ')}`);
  }

  const rendered = template
    .replace('{{BANNED_RULES}}', renderBanned(book))
    .replace('{{SELF_CHECK}}', renderSelfCheck(book));

  const leftover = rendered.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    throw new Error(`채우지 못한 자리: ${leftover.join(', ')}`);
  }

  return rendered;
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outPath = outIndex >= 0 ? resolve(args[outIndex + 1]!) : DEFAULT_OUT;
  const checkOnly = args.includes('--check');
  const dryRun = args.includes('--dry-run');

  let rendered: string;
  try {
    rendered = buildOutputStyle();
  } catch (error) {
    console.error(`output style 생성 실패: ${(error as Error).message}`);
    process.exit(1);
  }

  if (dryRun) {
    // 홈은 사람마다 다르다. CI가 볼 수 있는 건 룰북과 템플릿이 맞물리는지까지다
    console.log(`output style 룰 정합 통과 (금지 ${SPOTLIGHT.length}개, 게이트 ${GATE.length}개)`);
  } else if (checkOnly) {
    let current = '';
    try {
      current = readFileSync(outPath, 'utf-8');
    } catch {
      console.error(`${outPath} 가 없습니다. pnpm build:output-style 로 만드세요`);
      process.exit(1);
    }
    if (current !== rendered) {
      console.error(`${outPath} 가 룰북과 어긋납니다. pnpm build:output-style 로 다시 뽑으세요`);
      process.exit(1);
    }
    console.log(`output style 최신 상태 (${outPath})`);
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, rendered, 'utf-8');
    const lines = rendered.split('\n').length;
    console.log(
      `output style 생성: ${outPath} (${lines}줄, 금지 ${SPOTLIGHT.length}개, 게이트 ${GATE.length}개)`,
    );
  }
}
