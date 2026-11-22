import { cspHash } from '../../../src/architecture/csp.js';

/** 문서의 CSP meta 정책 문자열. 없으면 undefined */
export function cspOf(html: string): string | undefined {
  return /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1];
}

/** 정책에서 지시문 하나의 값 */
export function directive(policy: string, name: string): string | undefined {
  for (const part of policy.split(';')) {
    const [key, ...rest] = part.trim().split(/\s+/);
    if (key === name) return rest.join(' ');
  }
  return undefined;
}

/** 실행되는 인라인 script 본문. type이 붙은 데이터 블록은 뺀다 */
export function executableScripts(html: string): string[] {
  return [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .filter((m) => !/\btype=/.test(m[1] ?? ''))
    .map((m) => m[2]!);
}

export function inlineStyles(html: string): string[] {
  return [...html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
}

/** 정책이 문서 안 인라인 script와 style 전부를 해시로 덮는지 */
export function cspCoversInline(html: string): boolean {
  const policy = cspOf(html);
  if (!policy) return false;
  const scripts = directive(policy, 'script-src')?.split(' ') ?? [];
  const styles = directive(policy, 'style-src-elem')?.split(' ') ?? [];
  return (
    executableScripts(html).every((b) => scripts.includes(cspHash(b))) &&
    inlineStyles(html).every((b) => styles.includes(cspHash(b)))
  );
}
