/** 리뷰 대상에서 읽어낸 것. URL 로 주면 레포까지 함께 온다 */
export interface PrTarget {
  prNumber: number;
  /** URL 로 준 경우에만 있다. 숫자나 #숫자 로 주면 현재 레포를 쓴다 */
  owner?: string;
  repo?: string;
}

const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * 사용자가 준 리뷰 대상을 읽는다.
 *
 * 이 값은 뒤에서 상태 디렉토리 이름과 `gh` 인자가 된다. 문서가 이 파싱을 셸로 적던 때는
 * 대상 문자열을 작은따옴표 안에 합성해서, 따옴표가 섞인 값이 정수 검증에 닿기 전에
 * 명령으로 실행됐다. 문자열을 셸에 넘기지 않으면 그 자리가 없다.
 *
 * **URL 이면 레포도 함께 읽는다.** 번호만 뽑고 버리면 남의 레포 PR 을 가리켜도 조회는
 * 현재 레포의 같은 번호를 본다. 그 수로 승인이 나간다.
 *
 * 받는 꼴은 셋이다 — `18`, `#18`, `https://github.com/owner/repo/pull/18`.
 */
export function parseTarget(target: string): PrTarget {
  const trimmed = target.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(`PR URL 로 못 읽었습니다: ${target}`);
    }
    // 호스트를 먼저 본다. 안 보면 아무 도메인의 /pull/ 경로가 PR 번호로 읽혀
    // 조회 대상이 사용자가 지목한 것과 조용히 갈린다
    if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) {
      throw new Error(`github.com 주소가 아닙니다: ${target}`);
    }
    const m = PR_PATH.exec(url.pathname);
    if (!m) throw new Error(`PR URL 로 못 읽었습니다: ${target}`);
    const [, owner, repo, num] = m;
    if (!OWNER_REPO.test(owner!) || !OWNER_REPO.test(repo!)) {
      throw new Error(`레포를 못 읽었습니다: ${target}`);
    }
    return { prNumber: toPrNumber(num!, target), owner: owner!, repo: repo! };
  }

  return { prNumber: toPrNumber(trimmed.replace(/^#/, ''), target) };
}

/** 번호만 필요한 자리. 레포를 버리므로 대조가 필요한 곳에서는 parseTarget 을 쓴다 */
export function parsePrNumber(target: string): number {
  return parseTarget(target).prNumber;
}

function toPrNumber(raw: string, target: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`PR 번호로 못 읽었습니다: ${target}`);
  }
  const n = Number(raw);
  // 자릿수가 많으면 Number 가 지수 표기로 뭉개 정수 검사를 통과한다
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`PR 번호로 못 읽었습니다: ${target}`);
  }
  return n;
}
