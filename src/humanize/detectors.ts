/**
 * 룰 ID별 결정적 탐지기.
 *
 * 여기 있는 건 정규식만으로 오탐 없이 셀 수 있는 룰뿐이다. D-5 의인화 주어처럼
 * 뜻을 봐야 판단되는 룰은 일부러 뺐다 — 검사가 오탐으로 멈추면 아무도 안 쓴다.
 * 탐지기가 없는 룰은 모델이 자체검증으로 본다.
 */

export interface Detection {
  ruleId: string;
  count: number;
  samples: string[];
}

interface Detector {
  ruleId: string;
  run: (text: string) => string[];
}

const SAMPLE_CAP = 3;

/** 표 안 압축과 코드는 룰 적용 대상이 아니라서 센 뒤 빼야 한다 */
function proseOnly(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/`[^`\n]+`/g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('|'))
    .join('\n');
}

function matcher(ruleId: string, re: RegExp, onProse = true): Detector {
  return {
    ruleId,
    run: (text) => {
      const target = onProse ? proseOnly(text) : text;
      return [...target.matchAll(re)].map((m) => m[0]!.trim());
    },
  };
}

/** 문장 첫머리 접속사는 문장을 갈라서 봐야 한다 */
function sentenceInitial(ruleId: string, words: string[]): Detector {
  const re = new RegExp(`^(?:${words.join('|')})[\\s,]`);
  return {
    ruleId,
    run: (text) => {
      const hits: string[] = [];
      for (const chunk of splitSentences(proseOnly(text))) {
        const stripped = chunk.replace(/^[\s>*\-#\d.)]+/, '');
        const match = stripped.match(re);
        if (match) hits.push(match[0]!.trim());
      }
      return hits;
    },
  };
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 한글 뒤에는 \b가 성립하지 않는다(자모가 \w가 아님). 어미 끝은 후행 부정 탐색으로 막는다.
const NOT_HANGUL = '(?![가-힣])';
const JOSA = '(?:는|도|만|요)?';

const DETECTORS: Detector[] = [
  matcher('A-1', new RegExp(`[가-힣)\\]]\\s*에\\s*대(?:해서|하여|해|한)${JOSA}${NOT_HANGUL}`, 'g')),
  matcher(
    'A-2',
    new RegExp(`[가-힣)\\]]\\s*(?:를|을)?\\s*통(?:해서|하여|해)${JOSA}${NOT_HANGUL}`, 'g'),
  ),
  matcher('A-3', new RegExp(`[가-힣)\\]]\\s*에\\s*있어(?:서)?${JOSA}${NOT_HANGUL}`, 'g')),
  matcher('A-5', new RegExp(`(?:와|과)\\s*관련(?:하여|해서|해|된|한)${NOT_HANGUL}`, 'g')),
  matcher('A-7', /가지고\s*있(?:다|습니다|는|었|지)/g),
  // 되어진다는 지+ㄴ이 결합해 "진"으로 적히므로 자모 분리 형태로는 안 잡힌다
  matcher('A-8', /되어\s*(?:진|지[다고며])|지게\s*(?:된|되[다었어고])|되어\s*졌/g),
  matcher('A-9', new RegExp(`[가-힣)\\]]\\s*에\\s*의(?:해서|하여|해)${NOT_HANGUL}`, 'g')),
  matcher(
    'A-19',
    new RegExp(`[가-힣]\\s*(?:에서의|에로의|으로의|로의|에의|으로부터의)${NOT_HANGUL}`, 'g'),
  ),
  matcher('C-11', /[가-힣](?:하고|하며|되고|되며|고|며|지만|면서|아서|어서),/g),
  matcher('C-12', /[가-힣A-Za-z0-9]·[가-힣A-Za-z0-9]/g),
  matcher('D-1', /(?:결론적으로|요약하자면|요약하면|정리하자면|정리하면|종합하면|이를\s*통해)/g),
  matcher('D-2', /(?:시사하는\s*바가\s*크|주목할\s*만하)/g),
  matcher('D-3', /(?:본질적으로|핵심적으로)/g),
  matcher('D-4', /(?:파격적|압도적|획기적|혁신적|전례\s*없|폭발적)/g),
  matcher('D-6', /(?:할\s*때다|할\s*때입니다|할\s*시점|지금이야말로|할\s*순간)/g),
  matcher('F-7', /(?:증류|배선|결정화|평탄화|오케스트레이션|파이프라인화)/g),
  matcher('G-2', /(?:로\s*보인다|인\s*듯하다|로\s*판단된다|라고\s*여겨진다|로\s*여겨진다)/g),
  matcher('I-1', /(?:인\s*것이다|한\s*것이다|는\s*것이다|일\s*것이다)/g),
  matcher('I-3', /(?:다는\s*뜻이다|다는\s*의미다|다는\s*것이다)/g),
  matcher(
    'I-5',
    new RegExp(`(?:해당|이번|그)\\s*건${NOT_HANGUL}|[가-힣]\\s건(?:은|이|을|에|도)${NOT_HANGUL}`, 'g'),
  ),
  sentenceInitial('H-1', ['또한', '따라서', '즉', '나아가', '아울러', '게다가', '더욱이']),
  sentenceInitial('H-3', ['이는', '이\\s*점에서', '이\\s*관점에서', '이\\s*말은']),
];

export const DETECTABLE_RULE_IDS: string[] = DETECTORS.map((d) => d.ruleId);

export function detect(text: string, ruleIds?: readonly string[]): Detection[] {
  const wanted = ruleIds ? new Set(ruleIds) : null;
  const results: Detection[] = [];

  for (const detector of DETECTORS) {
    if (wanted && !wanted.has(detector.ruleId)) continue;
    const hits = detector.run(text);
    if (hits.length === 0) continue;
    results.push({
      ruleId: detector.ruleId,
      count: hits.length,
      samples: [...new Set(hits)].slice(0, SAMPLE_CAP),
    });
  }

  return results;
}

export function countByRule(text: string, ruleIds?: readonly string[]): Map<string, number> {
  return new Map(detect(text, ruleIds).map((d) => [d.ruleId, d.count]));
}

// --- 보존해야 하는 토큰 ---------------------------------------------------

const PROTECTED_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/g,
  /`[^`\n]+`/g,
  /https?:\/\/[^\s)\]]+/g,
  /"[^"\n]{2,}"|“[^”\n]{2,}”/g,
  /\d[\d,]*(?:\.\d+)?%?/g,
  /\b[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g,
  /\b[A-Z]{2,}\b/g,
];

/** 원문에서 한 글자도 바뀌면 안 되는 토큰을 뽑는다 */
export function protectedTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const re of PROTECTED_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const token = match[0]!.trim();
      if (token.length >= 2) tokens.add(token);
    }
  }
  return [...tokens];
}

export function missingProtectedTokens(before: string, after: string): string[] {
  return protectedTokens(before).filter((token) => !after.includes(token));
}

// --- 구조 지표 -------------------------------------------------------------

export interface StructureStats {
  sentences: number;
  headings: number;
  bullets: number;
  codeFences: number;
  links: number;
}

export function structureStats(text: string): StructureStats {
  const lines = text.split('\n');
  return {
    sentences: splitSentences(proseOnly(text)).length,
    headings: lines.filter((line) => /^#{1,6}\s/.test(line.trim())).length,
    bullets: lines.filter((line) => /^[-*+]\s|^\d+\.\s/.test(line.trim())).length,
    codeFences: (text.match(/```/g) ?? []).length,
    links: (text.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length,
  };
}
