/**
 * 한국어 텍스트를 색인 단어로 쪼갠다. 사전을 쓰지 않는다.
 *
 * 어절 끝의 흔한 조사와 어미를 짧은 목록으로 떼고 남은 줄기를 음절 bigram으로 쪼갠다.
 * "인터뷰 점수가" → 인터, 터뷰 / 점수. 형태소 분석기가 없어도 같은 낱말은 같은 bigram을
 * 내서 색인 쪽과 프롬프트 쪽이 만난다.
 *
 * 빌드(주석, 커밋 메시지 색인)와 훅(프롬프트)이 이 모듈 하나를 같이 쓴다. 훅의 기동 경로에
 * 들어가므로 의존성을 두지 않는다.
 */

const HANGUL_RUN = /[가-힣]+/g;
const HANGUL = /[가-힣]/;

/** 주석 하나에서 색인에 넣는 최대 글자 수. 긴 설명 주석 하나가 파일의 단어를 다 차지하지 않게 */
export const MAX_DOC_CHARS = 400;

/**
 * 뗄 꼬리. 긴 것부터 맞춰본다 — "에서"를 "서"보다 먼저 봐야 한다.
 * 떼고 남은 줄기가 2음절 미만이면 안 뗀다. "아이"에서 "이"를 떼면 다른 낱말이 된다.
 */
const SUFFIXES = [
  '했는데요',
  '했는데',
  '하는데',
  '해주세요',
  '했어요',
  '해줘요',
  '인데요',
  '거든요',
  '에서는',
  '으로는',
  '이라서',
  '라서',
  '해줘',
  '했어',
  '했다',
  '하고',
  '하는',
  '하면',
  '해서',
  '하게',
  '해요',
  '인데',
  '는데',
  '에서',
  '으로',
  '에게',
  '한테',
  '까지',
  '부터',
  '처럼',
  '보다',
  '이랑',
  '이나',
  '이고',
  '이면',
  '이다',
  '입니다',
  '합니다',
  '됩니다',
  '되는',
  '되고',
  '된다',
  '돼요',
  '안돼',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '에',
  '로',
  '의',
  '도',
  '만',
  '와',
  '과',
  '랑',
  '요',
].sort((a, b) => b.length - a.length);
const SUFFIX_SET = new Set(SUFFIXES);

/**
 * 어디에나 끼는 낱말. 대부분은 IDF가 눌러주지만 프롬프트에 너무 자주 나와서
 * 게이트의 "어절 둘 이상" 조건을 혼자 채워버리는 것만 뺀다.
 */
const KO_STOPWORDS = new Set([
  '코드',
  '파일',
  '수정',
  '확인',
  '작업',
  '이거',
  '그거',
  '저거',
  '여기',
  '거기',
  '지금',
  '이번',
  '다시',
  '그냥',
  '혹시',
  '어디',
  '어떻게',
  '부분',
  '내용',
  '관련',
  '사용',
  '추가',
  '처리',
  '문제',
  '기능',
  '정리',
  '진행',
  '같아',
  '같은',
  '있는',
  '없는',
  '있어',
  '없어',
  '그리고',
  '근데',
  '그래서',
  '이제',
  '먼저',
  '해줘',
  '봐줘',
  '알려줘',
  // 1음절 어절은 bigram 없이 그대로 색인되니 기능어가 그대로 맞는다
  '것',
  '거',
  '수',
  '좀',
  '뭐',
  '왜',
  '안',
  '잘',
  '더',
  '다',
  '또',
  '할',
  '한',
  '될',
  '된',
  '해',
  '해야',
  '하기',
  '하면',
  '있다',
  '없다',
  '같다',
]);

export function hasHangul(text: string): boolean {
  return HANGUL.test(text);
}

export function stripSuffix(eojeol: string): string {
  for (const s of SUFFIXES) {
    if (eojeol.length - s.length >= 2 && eojeol.endsWith(s)) return eojeol.slice(0, -s.length);
  }
  return eojeol;
}

/** 줄기를 bigram으로. 1음절이면 그 음절 하나 */
export function bigrams(stem: string): string[] {
  if (stem.length <= 1) return stem ? [stem] : [];
  const out: string[] = [];
  for (let i = 0; i < stem.length - 1; i++) out.push(stem.slice(i, i + 2));
  return out;
}

export interface KoEojeol {
  /** 조사와 어미를 뗀 줄기 */
  stem: string;
  /**
   * 프롬프트에 적힌 그대로의 어절. 주입 문구에 "어떤 단어로 걸렸는지"를 보여줄 때 쓴다.
   * 사전이 없어서 "해상도"도 조사 "도"로 보고 "해상"까지 자른다. 색인 쪽도 똑같이 잘라서
   * 매칭은 맞지만 줄기를 그대로 보여주면 낯선 말이 된다
   */
  surface: string;
  terms: string[];
}

/** 프롬프트용. 어절마다 줄기와 bigram을 따로 들고 간다. 게이트가 어절 수를 세야 해서다 */
export function koreanEojeols(text: string): KoEojeol[] {
  const out: KoEojeol[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(HANGUL_RUN)) {
    // "calculateTotal에서", "rules가"처럼 영문에 바로 붙은 조사는 낱말이 아니다
    const prev = text[m.index - 1];
    if (prev && /[A-Za-z0-9_)\]`'"]/.test(prev) && SUFFIX_SET.has(m[0])) continue;
    const stem = stripSuffix(m[0]);
    if (KO_STOPWORDS.has(stem) || KO_STOPWORDS.has(m[0]) || seen.has(stem)) continue;
    seen.add(stem);
    out.push({ stem, surface: m[0], terms: [...new Set(bigrams(stem))] });
  }
  return out;
}

/** 색인용. 텍스트 하나에서 나온 bigram 집합 */
export function koreanTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const e of koreanEojeols(text)) for (const t of e.terms) terms.add(t);
  return [...terms];
}

/**
 * 티켓 키로 보지 않는 접두어. `UTF-8`, `SHA-256`처럼 대문자-숫자 꼴인 표준 이름이다.
 */
const NOT_TICKETS = new Set([
  'UTF',
  'SHA',
  'ISO',
  'ES',
  'MD',
  'RFC',
  'HTTP',
  'TLS',
  'AES',
  'RSA',
  'P',
]);

/** `CT-31408`, `BIZRES-12636` 꼴. 대문자로 정규화해 돌려준다 */
export function extractTickets(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9])([A-Z][A-Z0-9]{0,15})-(\d{1,7})(?![0-9])/g)) {
    if (NOT_TICKETS.has(m[1]!)) continue;
    out.add(`${m[1]!}-${m[2]!}`);
  }
  return [...out];
}

/** 주석 원문을 색인할 텍스트로 줄인다. 한글이 없으면 undefined */
export function docText(raw: string): string | undefined {
  const text = raw
    .replace(/^\s*\/\*\*?|\*\/\s*$/g, '')
    .replace(/^\s*(\*|\/\/+)\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!hasHangul(text)) return undefined;
  return text.slice(0, MAX_DOC_CHARS);
}
