/**
 * 설명본이 원문에 발을 붙이고 있는지 본다.
 *
 * terms.ts 가 뽑는 건 영문 꼴의 전문용어라 용어를 금지한 대상에게는 쓸 수 없다. 그 대상에게
 * 용어를 남기라고 요구하면 룰북과 검사가 서로 반대를 지시한다. 그렇다고 아무것도 안 재면
 * 원문과 무관한 글이 통과한다 — 실제로 그랬다. WAL 저장소 설명 자리에 점심 메뉴 이야기를
 * 넣어도 다른 축이 전부 통과하는 상태였다.
 *
 * 그래서 용어가 아니라 한글 내용어를 본다. 룰북이 금지한 건 전문용어지 내용이 아니라서
 * 이 축은 어느 대상에게나 걸 수 있다.
 *
 * **이 축은 지표지 관문이 아니다.** 어휘 겹침으로는 좋은 의역과 무관한 글을 못 가른다 —
 * 둘 다 원문 어휘를 안 남긴다. 재보면 WAL 원문을 냉장고 쪽지에 빗댄 정확한 설명이 겹침 0이다.
 * 반대로 무관한 글이 흔한 부사 몇 개로 겹치기도 한다. 그래서 checkGrounding 은 채택 금지를
 * 안 내고 경고까지만 간다. 내용이 원문과 맞는지는 accuracy 가 본다.
 *
 * 원문 내용어를 상위 몇 개로 좁히지 않는다. 좁혀 보니 빈도가 전부 1인 짧은 원문에서 긴 말이
 * 앞으로 밀려 정작 주제어(읽기, 쓰기, 모드)가 목록에서 빠졌다.
 */

/**
 * 뒤에서 벗겨 낼 조사.
 *
 * 형태소 분석기를 안 쓴다. 이 축이 재는 건 겹치느냐 하나라 어간을 완벽히 복원할 이유가 없다.
 * 분석기를 붙이면 의존성이 하나 늘어 이 검사가 LLM 없이 돈다는 성질만큼 값이 안 나온다.
 * 긴 것부터 적어야 짧은 것이 먼저 먹지 않는다.
 *
 * 글자로 자르는 값은 여기 있다. 마지막 음절이 단독 조사와 같은 명사(속도, 결과, 효과)는
 * 조사 없이 홀로 쓰이면 어간이 한 글자로 잘려 사라진다. 반대로 활용이 덜 벗겨진 꼴은
 * (결과였 과 결과) 같은 말인데 안 겹친다. 겹침을 하나만 요구하고 판정이 경고까지라
 * 이 정도 놓침은 받아들인다.
 */
const JOSA =
  /(?:으로써|으로서|에서는|에게서|이라는|라는|으로|에서|에게|한테|까지|부터|보다|처럼|만큼|이나|나마|조차|마저|밖에|대로|이랑|하고|와의|과의|의|를|을|이|가|은|는|도|만|에|와|과|랑|로|께)$/;

/** 종결어미. 어간만 남겨야 "깨진다"와 "깨져요"가 같은 말로 겹친다 */
const TAIL = /(?:습니다|았어요|었어요|해요|예요|이에요|입니다|하다|한다|된다|이다|다|요)$/;

/**
 * 어느 글에나 나오는 말.
 *
 * 이런 말이 겹쳤다는 건 같은 주제를 다뤘다는 신호가 못 된다. 실제로 점심 메뉴 이야기가
 * API 설명 원문과 "오늘" 하나로 겹쳐 통과할 뻔했다.
 *
 * 손으로 적은 목록이라 빠진 말이 남는다 — 리뷰에서 "다른", "매우", "사실", "항상"으로
 * 같은 통과가 재현됐고 그것들을 넣어도 다음 말이 또 나온다. 목록을 늘려 막을 문제가
 * 아니라서 판정을 경고로 낮추는 쪽을 골랐다.
 */
const STOPWORDS = new Set([
  '오늘',
  '어제',
  '내일',
  '지금',
  '다음',
  '이번',
  '우리',
  '저희',
  '사람',
  '경우',
  '때문',
  '정도',
  '대로',
  '생각',
  '문제',
  '부분',
  '내용',
  '상태',
  '방법',
  '자리',
  '하나',
  '여기',
  '거기',
  '전부',
  '모두',
  '그냥',
  '조금',
  '아주',
]);

/**
 * 이만큼은 나와야 겹침을 물을 수 있다.
 *
 * 원문이 영문 스택 트레이스뿐이면 한글 내용어가 거의 없다. 그 자리에서 겹침을 요구하면
 * 설명이 무엇을 쓰든 걸린다. 잴 근거가 없으면 안 재는 쪽이 맞다.
 */
export const MIN_CONTENT_WORDS = 4;

function stemCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();

  for (const raw of text.split(/[^가-힣]+/)) {
    if (raw.length < 2) continue;
    const stem = raw.replace(TAIL, '').replace(JOSA, '');
    if (stem.length < 2 || STOPWORDS.has(stem)) continue;
    counts.set(stem, (counts.get(stem) ?? 0) + 1);
  }

  return counts;
}

/** 되풀이되는 말이 앞에 온다. 사람에게 무엇을 놓쳤는지 보일 때 그 순서가 쓸모 있다 */
export function contentWords(text: string): string[] {
  return [...stemCounts(text)]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .map(([stem]) => stem);
}

export interface Grounding {
  /** 원문에서 뽑은 내용어 */
  source: string[];
  /** 그중 설명본이 담은 것 */
  shared: string[];
  /** 원문에 한글 내용어가 모자라 판정을 미뤘나 */
  unmeasurable: boolean;
}

/** 사람에게 보일 때 원문 내용어를 이만큼만 적는다. 전부 적으면 보고문이 목록으로 덮인다 */
export const EVIDENCE_WORDS = 12;

export function groundingOf(source: string, explanation: string): Grounding {
  const words = contentWords(source);
  if (words.length < MIN_CONTENT_WORDS) {
    return { source: words, shared: [], unmeasurable: true };
  }

  const inExplanation = new Set(contentWords(explanation));
  return {
    source: words,
    shared: words.filter((word) => inExplanation.has(word)),
    unmeasurable: false,
  };
}
