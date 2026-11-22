import { describe, expect, it } from 'vitest';
import { buildCsp, cspMeta } from '../../../src/architecture/csp.js';
import {
  DEFAULT_ARCHITECTURE_LIVE_PORT,
  liveConnectSrc,
  liveOrigin,
} from '../../../src/architecture/live-port.js';
import { directive } from './csp-check.js';

const sources = { scripts: ['console.info(1)'], styles: ['body{}'] };

describe('buildCsp', () => {
  it('본인용만 라이브 서버 주소 한 줄을 connect-src로 연다', () => {
    const policy = buildCsp('private', sources);
    expect(directive(policy, 'connect-src')).toBe(
      `http://127.0.0.1:${DEFAULT_ARCHITECTURE_LIVE_PORT}`,
    );
    expect(directive(policy, 'default-src')).toBe("'none'");
    // 다른 호스트나 와일드카드, 스킴만 적은 출처는 없다
    expect(policy).not.toMatch(/\*|https:|ws:|localhost/);
    expect(policy.match(/https?:\/\//g)).toHaveLength(1);
  });

  it('공유본은 connect-src none 그대로이고 127.0.0.1 주소가 한 글자도 없다', () => {
    const policy = buildCsp('shared', sources);
    expect(directive(policy, 'connect-src')).toBe("'none'");
    expect(policy).not.toContain('127.0.0.1');
    expect(policy).not.toMatch(/https?:/);
  });

  it('같은 입력이면 같은 정책 문자열을 낸다', () => {
    expect(buildCsp('private', sources)).toBe(buildCsp('private', sources));
    expect(cspMeta('private', sources)).toContain(liveConnectSrc());
  });
});

describe('live-port', () => {
  it('출처와 connect-src가 같은 포트를 가리킨다', () => {
    expect(liveOrigin(7999)).toBe('http://127.0.0.1:7999');
    expect(liveConnectSrc(7999)).toBe('connect-src http://127.0.0.1:7999');
    expect(liveOrigin()).toBe(`http://127.0.0.1:${DEFAULT_ARCHITECTURE_LIVE_PORT}`);
  });
});
