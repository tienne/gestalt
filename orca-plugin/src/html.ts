// 문자열로 HTML을 그리는 화면(폰 페이지, 컨덕터 터미널)이 함께 쓰는 이스케이프.

/** 텍스트와 속성값 어디에 넣어도 안전하게 다섯 글자를 바꾼다 */
export function esc(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
