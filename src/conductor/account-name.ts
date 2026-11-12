/** GitHub 계정 이름 꼴. 엔터프라이즈 관리형 계정의 `_`까지 받는다 */
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/**
 * 설정에서 읽은 계정 이름이 GitHub 계정 꼴인지 본다. `gh --user` 인자로 가기 전에 거른다.
 * '-'로 시작하는 값은 gh가 옵션으로 읽는다.
 */
export function isAccountName(v: string): boolean {
  return ACCOUNT_RE.test(v);
}
