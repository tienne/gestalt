import { describe, expect, it } from 'vitest';
import { resolveRemoteUrl } from '../../../src/harness-review/remote-url.js';

const aliases: Record<string, string> = { 'github-work': 'github.com', 'corp-git': 'git.acme.dev' };
const fakeSsh = (alias: string) => aliases[alias] ?? alias;

describe('resolveRemoteUrl', () => {
  it('SSH 호스트 별칭을 실제 호스트로 바꾼다', () => {
    expect(resolveRemoteUrl('git@github-work:acme/widget-kit.git', fakeSsh)).toBe(
      'git@github.com:acme/widget-kit.git',
    );
    expect(resolveRemoteUrl('ssh://git@github-work/acme/widget-kit.git', fakeSsh)).toBe(
      'ssh://git@github.com/acme/widget-kit.git',
    );
  });

  it('github.com이 아닌 곳을 가리키는 별칭은 그 호스트로 풀린다', () => {
    expect(resolveRemoteUrl('git@corp-git:acme/widget-kit.git', fakeSsh)).toBe(
      'git@git.acme.dev:acme/widget-kit.git',
    );
  });

  it('이미 github.com이거나 https 주소, 로컬 경로는 ssh를 부르지 않는다', () => {
    const never = () => {
      throw new Error('ssh를 부르면 안 된다');
    };
    for (const url of [
      'git@github.com:acme/widget-kit.git',
      'https://gitlab.example/acme/widget-kit.git',
      '/tmp/acme/widget-kit',
    ]) {
      expect(resolveRemoteUrl(url, never)).toBe(url);
    }
  });

  it('별칭을 못 풀면 받은 주소를 그대로 돌려준다', () => {
    expect(resolveRemoteUrl('git@unknown:acme/widget-kit.git', () => null)).toBe(
      'git@unknown:acme/widget-kit.git',
    );
  });
});
