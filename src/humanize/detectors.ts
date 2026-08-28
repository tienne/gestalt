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
  /**
   * prose 는 detect 가 한 번 계산해 모든 탐지기에 나눠 주는, 산문만 남긴 텍스트다.
   *
   * 원문 그대로가 필요한 룰이 아직 없어 인자가 이것 하나다. 코드펜스나 표 안을
   * 봐야 하는 룰이 생기면 그때 raw text 를 함께 넘긴다.
   */
  run: (prose: string) => string[];
}

const SAMPLE_CAP = 3;

export interface ProseLine {
  text: string;
  number: number;
}

export interface ProseOptions {
  /** 인용줄을 뺀다. 보고 본문 어미처럼 작성자 말투가 아닌 걸 셀 때만 쓴다 */
  excludeQuotes?: boolean;
}

/**
 * 룰을 적용할 산문 줄만 남긴다.
 *
 * 코드펜스는 언어 태그가 붙었을 때만 코드로 본다. 태그 없는 펜스에는 실행 코드가 아니라
 * 서브에이전트가 지시로 읽는 한글 산문이 들어 있어서, 통째로 빼면 그 안의 S1이 그대로 샌다.
 * 인용줄도 마커만 떼고 산문으로 본다 — 스킬 문서 상단 규칙 블록이 전부 인용이라 빼면 검사가 비는다.
 * 표는 항목 압축이라 그대로 뺀다.
 */
export function proseLines(text: string, options: ProseOptions = {}): ProseLine[] {
  const lines: ProseLine[] = [];
  let inFence = false;
  let fenceIsCode = false;

  text.split('\n').forEach((raw, index) => {
    const trimmed = raw.trimStart();

    if (trimmed.startsWith('```')) {
      if (!inFence) fenceIsCode = trimmed.slice(3).trim().length > 0;
      inFence = !inFence;
      return;
    }
    if (inFence && fenceIsCode) return;
    if (trimmed.startsWith('|')) return;

    if (trimmed.startsWith('>')) {
      if (options.excludeQuotes) return;
      lines.push({ text: raw.replace(/^\s*>+\s?/, ''), number: index + 1 });
      return;
    }
    lines.push({ text: raw, number: index + 1 });
  });

  return lines;
}

function proseOnly(text: string, options: ProseOptions = {}): string {
  return proseLines(text, options)
    .map((line) => line.text)
    .join('\n')
    .replace(/`[^`\n]+`/g, ' ');
}

function matcher(ruleId: string, re: RegExp): Detector {
  return {
    ruleId,
    run: (prose) => [...prose.matchAll(re)].map((m) => m[0]!.trim()),
  };
}

/** 문장 첫머리 접속사는 문장을 갈라서 봐야 한다 */
function sentenceInitial(ruleId: string, words: string[]): Detector {
  const re = new RegExp(`^(?:${words.join('|')})[\\s,]`);
  return {
    ruleId,
    run: (prose) => {
      const hits: string[] = [];
      for (const chunk of splitSentences(prose)) {
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
  // 미덕(virtue)·불투명(opaque)은 한국어에서 제 뜻으로도 쓰여 오탐이 난다. 표에만 두고 모델이 본다
  // 의미론은 조사가 붙어 오므로 NOT_HANGUL을 못 쓴다. 형용사로 굳은 "의미론적"만 뺀다
  matcher('B-5', /물질화|내구성\s*있|의미론(?!적)/g),
  matcher('C-11', /[가-힣](?:하고|하며|되고|되며|고|며|지만|면서|아서|어서),/g),
  matcher('C-12', /[가-힣A-Za-z0-9]·[가-힣A-Za-z0-9]/g),
  matcher('D-1', /(?:결론적으로|요약하자면|요약하면|정리하자면|정리하면|종합하면|이를\s*통해)/g),
  matcher('D-2', /(?:시사하는\s*바가\s*크|주목할\s*만하)/g),
  matcher('D-3', /(?:본질적으로|핵심적으로)/g),
  matcher('D-4', /(?:파격적|압도적|획기적|혁신적|전례\s*없|폭발적)/g),
  matcher('D-6', /(?:할\s*때다|할\s*때입니다|할\s*시점|지금이야말로|할\s*순간)/g),
  matcher('D-8', /(?:뼈아[프픈팠]|뜨끔|부끄럽|(?:제일|가장|많이)\s*아팠)/g),
  // 방향, 결론이 스스로 움직이는 자리만 본다. 사이에 부사 한 토큰까지 허용한다
  matcher('D-9', /(?:방향|결론|판단|논의)[이가은는도]?\s*(?:\S+\s+)?(?:갔|가고|간다)/g),
  // '잠금 파일'처럼 명사로 굳은 자리는 빼고 동사형만 본다. 테스트나 기준을
  // 자물쇠에 빗대는 자리가 대상이다 — "테스트로 잠갔다" → "관련 테스트가 있다"
  matcher(
    'F-7',
    /(?:증류|배선|결정화|평탄화|오케스트레이션|파이프라인화|잠[그근갔글가긴겨겼기](?![가-힣]*파일))/g,
  ),
  // 목적어가 추상명사인 자리만 본다 — "온도를 재봤는데"는 멀쩡한 물리적 용법이다.
  // "재확인"처럼 접두사로 붙는 자리를 피하려고 뒤따르는 어미까지 확인한다
  matcher(
    'F-8',
    /(?:근거|의견|판단|영향|의미|가치|리스크)(?:를|을)\s*(?:재|달아)(?=[봤본보았어])/g,
  ),
  matcher('G-2', /(?:로\s*보인다|인\s*듯하다|로\s*판단된다|라고\s*여겨진다|로\s*여겨진다)/g),
  matcher('I-1', /(?:인\s*것이다|한\s*것이다|는\s*것이다|일\s*것이다)/g),
  matcher('I-3', /(?:다는\s*뜻이다|다는\s*의미다|다는\s*것이다)/g),
  matcher(
    'I-5',
    new RegExp(
      `(?:해당|이번|그)\\s*건${NOT_HANGUL}|[가-힣]\\s건(?:은|이|을|에|도)${NOT_HANGUL}`,
      'g',
    ),
  ),
  // "산출물"은 명사로 굳은 자리라 뺀다. F-7이 "잠금 파일"을 빼는 것과 같은 기준
  matcher('I-6', /실측|계측|오탐|산출(?!물)/g),
  // 동사 관형형만 본다. "높은 수준"처럼 등급을 실제로 말하는 자리는 대상이 아니다
  matcher('I-8', /[가-힣]는\s*수준/g),
  // "지적 재산", "지적 능력", "지적인"은 제 뜻으로 쓰이는 자리라 조사와 활용형만 본다.
  // 리뷰 코멘트를 가리키는 호칭이 대상이다 — 내 것은 "남겼던 의견", 상대 것은 "짚어주신 부분"
  matcher(
    'I-7',
    new RegExp(
      `지적\\s*(?:을|이|은|도|만|에|의|과|와)${NOT_HANGUL}|지적(?:하|해|했|한|받|당)|지적\\s*\\d+\\s*건|지적\\s*사항`,
      'g',
    ),
  ),
  sentenceInitial('H-1', ['또한', '따라서', '즉', '나아가', '아울러', '게다가', '더욱이']),
  sentenceInitial('H-3', ['이는', '이\\s*점에서', '이\\s*관점에서', '이\\s*말은']),
];

export const DETECTABLE_RULE_IDS: string[] = DETECTORS.map((d) => d.ruleId);

export function detect(text: string, ruleIds?: readonly string[]): Detection[] {
  const wanted = ruleIds ? new Set(ruleIds) : null;
  const results: Detection[] = [];
  // 탐지기 29개가 각자 부르면 줄 분할과 인용 제거가 스물네 번 반복된다. 한 번만 한다
  const prose = proseOnly(text);

  for (const detector of DETECTORS) {
    if (wanted && !wanted.has(detector.ruleId)) continue;
    const hits = detector.run(prose);
    if (hits.length === 0) continue;
    results.push({
      ruleId: detector.ruleId,
      count: hits.length,
      samples: [...new Set(hits)].slice(0, SAMPLE_CAP),
    });
  }

  return results;
}

/**
 * 어투가 아니라 맞춤법인 자리. 등급과 따로 센다.
 *
 * 리뷰 코멘트는 커밋 해시나 브랜치명을 문장에 그대로 섞기 때문에 조사 처리가 반복해서
 * 어긋난다 (author-voice.md §기계적 점검). S1 총계에 섞으면 윤문 등급이 맞춤법 때문에
 * 떨어지므로 ScanReport가 따로 들고 간다.
 *
 * 두 가지를 재보고 뺐다. 백틱 안에 조사가 들어간 자리("`c:로`")는 레포에서 8건이 걸렸는데
 * 그중 여섯이 `파일:라인`, `human:이름` 같은 형식 표기였다. 영문 일반 뒤 조사("main 에")는
 * 인라인 코드를 지운 자국과 작성자가 인용한 코드 예시를 통째로 먹었다. 줄바꿈을 건너뛰지
 * 않도록 공백은 같은 줄로 한정한다.
 */
export interface SpacingIssue {
  label: string;
  fix: string;
  count: number;
  samples: string[];
}

const SPACING: Array<{ label: string; fix: string; re: RegExp }> = [
  {
    label: '식별자 뒤 조사를 띄어 썼다',
    fix: '붙여 쓴다 (`6564d04 에서` → `6564d04에서`)',
    // 16진수로만 이뤄진 영단어를 거르려고 숫자를 최소 하나 요구한다
    re: /\b(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}[ \t]+(?:에서|에|로|은|는|이|가|을|를|와|과|의)(?![가-힣])/g,
  },
  {
    label: '외래어와 하다를 띄어 썼다',
    fix: '붙여 쓰거나 우리말로 (`Approve 합니다` → `Approve합니다` / `승인합니다`)',
    re: /[A-Za-z]{2,}[ \t]+(?:합니다|했습니다|해요|할게요|하겠습니다|한다|하면|하고)(?![가-힣])/g,
  },
];

export function spacingIssues(text: string): SpacingIssue[] {
  const prose = proseOnly(text);
  const out: SpacingIssue[] = [];

  for (const { label, fix, re } of SPACING) {
    const hits = [...prose.matchAll(re)].map((m) => m[0]!.trim());
    if (hits.length === 0) continue;
    out.push({ label, fix, count: hits.length, samples: [...new Set(hits)].slice(0, SAMPLE_CAP) });
  }

  return out;
}

export function countByRule(text: string, ruleIds?: readonly string[]): Map<string, number> {
  return new Map(detect(text, ruleIds).map((d) => [d.ruleId, d.count]));
}

export interface ReportRegisterStats {
  plainEndings: number;
  formalEndings: number;
}

/**
 * 보고 본문에서 평서체와 합니다체가 섞였는지만 보수적으로 센다.
 * 어미는 인용문에서 남의 말투가 그대로 딸려오므로 여기서만 인용줄을 뺀다.
 */
export function reportRegisterStats(text: string): ReportRegisterStats {
  let plainEndings = 0;
  let formalEndings = 0;

  for (const sentence of splitSentences(proseOnly(text, { excludeQuotes: true }))) {
    const trimmed = sentence.trim();
    if (/[가-힣]니다[.!?…]?$/.test(trimmed)) {
      formalEndings += 1;
    } else if (/[가-힣]다[.!?…]?$/.test(trimmed)) {
      plainEndings += 1;
    }
  }

  return { plainEndings, formalEndings };
}

// --- 보존해야 하는 토큰 ---------------------------------------------------

const PROTECTED_PATTERNS: RegExp[] = [
  // 언어 태그가 붙은 펜스만 원본 코드다. 태그 없는 펜스는 프롬프트 산문이라 윤문 대상이다
  /```[^\s`][^\n`]*\n[\s\S]*?```/g,
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
