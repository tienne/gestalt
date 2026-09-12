/**
 * 사용자가 준 리뷰 대상에서 PR 번호를 뽑는다.
 *
 * 이 값은 뒤에서 상태 디렉토리 이름(`pr-<번호>`)이 되고 `gh` 인자로 들어간다. 문서가
 * 이 파싱을 셸로 적던 때는 대상 문자열을 작은따옴표 안에 합성해서, 따옴표가 섞인 값이
 * 정수 검증에 닿기도 전에 명령으로 실행됐다. 문자열을 셸에 넘기지 않으면 그 자리가 없다.
 *
 * 받는 꼴은 셋이다 — `18`, `#18`, `https://github.com/owner/repo/pull/18`.
 */
export function parsePrNumber(target: string): number {
  const trimmed = target.trim();
  const fromUrl = /\/pull\/(\d+)(?:[/?#].*)?$/.exec(trimmed);
  const raw = fromUrl ? fromUrl[1]! : trimmed.replace(/^#/, '');
  if (!/^\d+$/.test(raw)) {
    throw new Error(`PR 번호로 못 읽었습니다: ${target}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`PR 번호로 못 읽었습니다: ${target}`);
  }
  return n;
}
