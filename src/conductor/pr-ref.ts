// PR 감시의 중복 방지가 prRef 문자열 일치에 기대므로 저장 전에 한 꼴로 맞춘다
const SHORT = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const URL_FORM =
  /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?(?:[?#].*)?$/;

/** `owner/name#번호`나 GitHub PR URL을 `owner/name#번호`로 바꾼다. 둘 다 아니면 null */
export function normalizePrRef(input: string): string | null {
  const s = input.trim();
  const m = SHORT.exec(s) ?? URL_FORM.exec(s);
  if (!m) return null;
  return `${m[1]!}/${m[2]!}#${Number(m[3]!)}`;
}

/** 정규화된 prRef에서 `owner/name`을 뽑는다 */
export function repoOfPrRef(prRef: string): string | null {
  const n = normalizePrRef(prRef);
  return n ? n.slice(0, n.indexOf('#')) : null;
}
