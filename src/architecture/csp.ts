import { createHash } from 'node:crypto';

export type CspAudience = 'private' | 'shared';

export interface CspSources {
  /** 실행되는 인라인 script 본문. type="application/json" 데이터 블록은 실행되지 않으니 넣지 않는다 */
  scripts: readonly string[];
  /** 인라인 style 요소 본문 */
  styles: readonly string[];
}

/** 인라인 본문의 CSP 해시. 브라우저처럼 본문 UTF-8 바이트의 sha256을 base64로 적는다 */
export function cspHash(body: string): string {
  return `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
}

// 두 정책이 같이 쓰는 지시문. 외부로 나가는 길(이미지 말고는 전부)과 base, form을 닫는다.
// 이미지는 캡처와 아이콘이 전부 data: URI라 그것만 연다.
// style 속성(style="left:..px")은 서버가 숫자로만 만드는 배치 값이라 style-src-attr로 따로 연다.
// 이 값이 없으면 캔버스 배치가 전부 무너진다. style 요소는 해시로만 연다
function baseDirectives(scripts: string, styles: string): string[] {
  return [
    "default-src 'none'",
    `script-src ${scripts}`,
    `style-src ${styles}`,
    `style-src-elem ${styles}`,
    "style-src-attr 'unsafe-inline'",
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
  ];
}

/**
 * 공유본 정책. 남에게 넘기는 파일이라 어떤 통신도 하지 않는다고 connect-src 'none'으로 적어 둔다.
 */
const SHARED_DIRECTIVES = (scripts: string, styles: string): string[] => [
  ...baseDirectives(scripts, styles),
  "connect-src 'none'",
];

/**
 * 본인용 정책. 지금은 connect-src를 따로 적지 않아 default-src 'none'을 따르므로 통신은 공유본처럼 막힌다.
 * 로컬 서버와 주고받는 기능이 들어오면 여기에만 connect-src를 더한다. 공유본 정책과 섞지 않으려고 따로 둔다
 */
const PRIVATE_DIRECTIVES = (scripts: string, styles: string): string[] =>
  baseDirectives(scripts, styles);

function hashList(bodies: readonly string[]): string {
  // 같은 본문이 두 번 나와도 해시는 한 번만 적는다. 정렬해 두면 렌더 순서가 바뀌어도 같은 문자열이 나온다
  const hashes = [...new Set(bodies.map(cspHash))].sort();
  return hashes.length > 0 ? hashes.join(' ') : "'none'";
}

/** 인라인 본문 해시로 CSP 정책 문자열을 만든다. 같은 본문이면 같은 문자열이다 */
export function buildCsp(audience: CspAudience, sources: CspSources): string {
  const scripts = hashList(sources.scripts);
  const styles = hashList(sources.styles);
  const directives =
    audience === 'shared'
      ? SHARED_DIRECTIVES(scripts, styles)
      : PRIVATE_DIRECTIVES(scripts, styles);
  return directives.join('; ');
}

/** `<meta http-equiv="Content-Security-Policy">` 한 줄. 정책 문자열에는 따옴표 말고 이스케이프할 글자가 없다 */
export function cspMeta(audience: CspAudience, sources: CspSources): string {
  return `<meta http-equiv="Content-Security-Policy" content="${buildCsp(audience, sources)}">`;
}
