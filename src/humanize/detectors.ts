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
const SAMPLE_MAX = 80;

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

/**
 * 보고문에 실릴 조각을 눌러 둔다.
 *
 * 스캔 결과는 모델이 지시로 읽는 텍스트이고 sample 은 사용자 파일에서 잘라낸 원문이다.
 * 보고문이 큰따옴표로 감싸는 틀이라 인용 경계와 코드 표기를 흉내 낼 문자를 지운다.
 * 길이도 자른다 — D-9의 (?:\S+\s+)? 처럼 임의 토큰을 삼키는 탐지기가 있어서
 * 매치 하나가 수백 자로 늘어날 수 있다.
 *
 * 어투 탐지기와 맞춤법 검사가 같이 지나는 자리에 둔다. 한쪽만 누르면 표면이 넓은
 * 쪽이 그대로 새는데, 실제로 맞춤법만 누른 판이 그랬다.
 */
function clampSample(sample: string): string {
  return sample.replace(/[`"']|\p{C}/gu, ' ').slice(0, SAMPLE_MAX);
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
  // 방향, 결론, 판단, 논의가 스스로 움직이는 자리를 본다. 사이에 토큰 하나까지는
  // 건너뛰되 품사는 안 가린다. 조사를 필수로 둬야 부사격 "그 방향으로 갔어요"가 빠진다 —
  // 그건 룰북이 처방으로 내놓은 형태라 걸리면 처방을 다시 고치라고 시키는 꼴이 된다
  matcher('D-9', /(?:방향|결론|판단|논의)[이가은는도]\s*(?:\S+\s+)?(?:갔|가고|간다)/g),
  // '잠금 파일'처럼 명사로 굳은 자리는 빼고 동사형만 본다. 테스트나 기준을
  // 자물쇠에 빗대는 자리가 대상이다 — "테스트로 잠갔다" → "관련 테스트가 있다"
  matcher(
    'F-7',
    /(?:증류|배선|결정화|평탄화|오케스트레이션|파이프라인화|잠[그근갔글가긴겨겼기](?![가-힣]*파일))/g,
  ),
  // 목적어가 추상명사인 자리만 본다 — "온도를 재봤는데"는 멀쩡한 물리적 용법이다.
  // 어미를 통째로 확인해야 "재보정", "재보고"처럼 접두사 재-에 보-가 붙은 말이 빠진다.
  // 문자 클래스로 "보" 한 글자만 보면 그 둘이 그대로 걸린다
  matcher(
    'F-8',
    /(?:근거|의견|판단|영향|의미|가치|리스크)(?:를|을)\s*(?:재(?=봤|봐|보니|보면|본다|보았)|달아(?=[봤봐본보았뒀둔두])|달았)/g,
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
  // 산출은 뒤에 오는 조사와 활용형을 열거해서 본다. 열거한 것만 보는 닫힌 목록이라
  // "산출도", "산출된다"처럼 목록 밖 형태는 안 걸린다 — 늘릴 때는 코퍼스도 함께 늘린다.
  // 산출물, 산출량, 산출식은 그 자리에 다른 글자가 와서 빠진다. F-7의 "잠금 파일"과 같은 기준
  matcher(
    'I-6',
    /실측|계측|오탐|산출(?=(?:으?로|은|는|이|을|과|와|에)(?![가-힣])|하[여는지고]|한|했|해서)/g,
  ),
  // 리뷰 코멘트를 가리키는 호칭만 본다 — 내 것은 "남겼던 의견", 상대 것은 "짚어주신 부분".
  // 다섯 갈래다: 조사, 상대가 남겼음을 드러내는 활용형, "지적 N건", "지적 사항", "지적들".
  // 활용형을 지적하-까지 열면 "원칙 위반을 지적하고" 같은 일반 동사 용법이 걸린다.
  // 그 예외는 author-voice.md가 "산출물 문장에만 적용된다"로 적어둔 자리다
  matcher(
    'I-7',
    new RegExp(
      `지적\\s*(?:을|이|은|도|만|에|의|과|와)${NOT_HANGUL}|지적(?:해\\s*주|하신|받|당)|지적\\s*\\d+\\s*건|지적\\s*사항|지적들`,
      'g',
    ),
  ),
  // 관형형 어간을 열거해야 명사+보조사("설계는 수준이")와 등급을 말하는 동사 관형형
  // ("요구되는 수준")이 빠진다. [가-힣]는 으로 열면 둘 다 걸린다.
  // 보 는 단독으로 두면 "정보는", "확보는"의 끝 음절을 먹어서 복합 어간으로만 적는다.
  // 하 는 같은 구멍이 남지만("부하는 수준이") 그걸 빼면 "확인하는 수준"을 통째로 놓친다.
  // 뒤따르는 조사는 안 본다 — 어간 열거가 이미 등급 자리를 걸러서, 조사까지 막으면
  // "다듬는 수준으로 끝냈어요" 처럼 잡아야 할 자리만 빠진다
  matcher('I-8', /(?:하|다듬|손보|고치|살펴보|알아보|들여다보|넘기|훑)는\s*수준/g),
  sentenceInitial('H-1', ['또한', '따라서', '즉', '나아가', '아울러', '게다가', '더욱이']),
  sentenceInitial('H-3', ['이는', '이\\s*점에서', '이\\s*관점에서', '이\\s*말은']),
];

export const DETECTABLE_RULE_IDS: string[] = DETECTORS.map((d) => d.ruleId);

export function detect(text: string, ruleIds?: readonly string[]): Detection[] {
  return detectOn(proseOnly(text), ruleIds);
}

function detectOn(prose: string, ruleIds?: readonly string[]): Detection[] {
  const wanted = ruleIds ? new Set(ruleIds) : null;
  const results: Detection[] = [];

  for (const detector of DETECTORS) {
    if (wanted && !wanted.has(detector.ruleId)) continue;
    const hits = detector.run(prose);
    if (hits.length === 0) continue;
    results.push({
      ruleId: detector.ruleId,
      count: hits.length,
      samples: [...new Set(hits)].map(clampSample).slice(0, SAMPLE_CAP),
    });
  }

  return results;
}

/** 맞춤법 한 건. 무엇이 틀렸고 무엇으로 고치는지, 몇 건인지와 실제 사례를 담는다 */
export interface SpacingIssue {
  label: string;
  fix: string;
  count: number;
  samples: string[];
}

/**
 * 후보 넷을 돌려보고 둘만 남겼다.
 *
 * 백틱 안에 조사가 들어간 자리("`c:로`")는 레포에서 8건이 걸렸는데 그중 여섯이
 * `파일:라인`, `human:이름` 같은 형식 표기였다. 영문 일반 뒤 조사("main 에")는 인라인
 * 코드를 지운 자국과 작성자가 인용한 코드 예시를 통째로 먹었다.
 *
 * 공백을 같은 줄로 한정하는 건 \s+ 가 줄바꿈을 건너뛰어 다음 줄 첫 조사에 붙기 때문이다.
 * 왼쪽 경계를 후행 부정으로 막는 건 성능이다 — 그게 없으면 영문 러닝 안 모든 위치에서
 * 매칭을 다시 시작해 길이의 제곱으로 늘어난다. 6만 자에서 5.9초가 0.5밀리초가 됐다.
 */
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
    re: /(?<![A-Za-z])[A-Za-z]{2,}[ \t]+(?:합니다|했습니다|해요|할게요|하겠습니다|한다|하면|하고)(?![가-힣])/g,
  },
];

/**
 * 어투가 아니라 맞춤법인 자리를 센다. 등급과 따로 가는 값이다.
 *
 * 리뷰 코멘트는 커밋 해시나 브랜치명을 문장에 그대로 섞기 때문에 조사 처리가 반복해서
 * 어긋난다 (author-voice.md §기계적 점검). S1 총계에 섞으면 윤문 등급이 맞춤법 때문에
 * 떨어지므로 ScanReport가 이 값을 따로 들고 간다.
 */
export function spacingIssues(text: string): SpacingIssue[] {
  return spacingOn(proseOnly(text));
}

function spacingOn(prose: string): SpacingIssue[] {
  const out: SpacingIssue[] = [];

  for (const { label, fix, re } of SPACING) {
    const hits = [...prose.matchAll(re)].map((m) => m[0]!.trim());
    if (hits.length === 0) continue;
    // 샘플은 사용자 파일에서 잘라낸 원문이고 보고문은 모델이 지시로 읽는다.
    // 개행과 백틱을 눌러 두면 잘라낸 조각이 보고문의 구조를 흉내 내지 못한다
    const samples = [...new Set(hits)].map(clampSample).slice(0, SAMPLE_CAP);
    out.push({ label, fix, count: hits.length, samples });
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

/**
 * 어투와 맞춤법을 한 산문 위에서 함께 본다.
 *
 * detect 와 spacingIssues 를 따로 부르면 줄 분할과 인용 제거가 두 번 돈다. 비용은 작지만
 * (500KB 입력에서 12%) 진짜 문제는 나중에 한쪽만 산문 기준이 바뀌면 어투와 맞춤법이 서로
 * 다른 텍스트를 보게 되는 것이다. 산문 정의를 여기 한 군데로 모은다.
 */
export function scanProse(
  text: string,
  ruleIds?: readonly string[],
): { detections: Detection[]; spacing: SpacingIssue[] } {
  const prose = proseOnly(text);
  return { detections: detectOn(prose, ruleIds), spacing: spacingOn(prose) };
}
