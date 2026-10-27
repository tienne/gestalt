import { describe, expect, it } from 'vitest';
import { REDACTED, redactText, redactValue, truncateBytes } from '../../../src/peer/redact.js';
import { FAKE_HOME, FAKE_SECRETS } from '../../fixtures/peer/transcript.js';

const opts = { home: FAKE_HOME };

describe('redactText', () => {
  it.each([
    ['AWS 액세스 키', `key ${FAKE_SECRETS.aws} end`],
    ['GitHub ghp_', `token ${FAKE_SECRETS.ghp}`],
    ['GitHub gho_', `token ${FAKE_SECRETS.gho}`],
    ['GitHub github_pat_', `token ${FAKE_SECRETS.githubPat}`],
    ['JWT', `Authorization ${FAKE_SECRETS.jwt}`],
  ])('%s를 가린다', (_name, input) => {
    const out = redactText(input, opts);
    expect(out).toContain(REDACTED);
    for (const secret of Object.values(FAKE_SECRETS)) expect(out).not.toContain(secret);
  });

  it('PEM 개인키 블록을 통째로 가린다', () => {
    const pem = [
      'before',
      '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
      FAKE_SECRETS.pemBody,
      'second line of body',
      '-----END ' + 'OPENSSH PRIVATE KEY-----',
      'after',
    ].join('\n');
    const out = redactText(pem, opts);
    expect(out).not.toContain(FAKE_SECRETS.pemBody);
    expect(out).not.toContain('second line of body');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('끝 표시가 잘린 PEM도 끝까지 가린다', () => {
    const out = redactText('-----BEGIN ' + `PRIVATE KEY-----\n${FAKE_SECRETS.pemBody}`, opts);
    expect(out).not.toContain(FAKE_SECRETS.pemBody);
  });

  it.each([
    ['API_KEY', FAKE_SECRETS.apiKeyValue],
    ['GH_TOKEN', FAKE_SECRETS.tokenValue],
    ['CLIENT_SECRET', FAKE_SECRETS.secretValue],
    ['DB_PASSWORD', FAKE_SECRETS.passwordValue],
    ['aws_secret_access_key', FAKE_SECRETS.secretValue],
  ])('%s= 값은 이름만 남기고 가린다', (name, value) => {
    for (const input of [`${name}=${value}`, `export ${name}="${value}"`, `${name}='${value}'`]) {
      const out = redactText(input, opts);
      expect(out).not.toContain(value);
      expect(out).toContain(`${name}=${REDACTED}`);
    }
  });

  it('따옴표 친 JSON 키의 값을 가린다', () => {
    const out = redactText(`{"api_key": "${FAKE_SECRETS.apiKeyValue}", "name": "ok"}`, opts);
    expect(out).not.toContain(FAKE_SECRETS.apiKeyValue);
    expect(out).toContain('"name": "ok"');
  });

  it('Bearer 헤더 값을 가린다', () => {
    const out = redactText(`Authorization: Bearer ${FAKE_SECRETS.tokenValue}`, opts);
    expect(out).not.toContain(FAKE_SECRETS.tokenValue);
    expect(out).toContain(`Bearer ${REDACTED}`);
  });

  it('홈 디렉토리 경로를 ~로 바꾸고 이름이 이어지는 다른 경로는 안 건드린다', () => {
    expect(redactText(`${FAKE_HOME}/dev/proj`, opts)).toBe('~/dev/proj');
    expect(redactText(`cd ${FAKE_HOME}`, opts)).toBe('cd ~');
    expect(redactText(`${FAKE_HOME}2/x`, opts)).toBe(`${FAKE_HOME}2/x`);
  });

  it('코드의 `key = value`는 가리지 않는다', () => {
    expect(redactText('const key = value;', opts)).toBe('const key = value;');
  });
});

describe('redactValue', () => {
  it('객체 안 문자열을 전부 가린다', () => {
    const out = JSON.stringify(
      redactValue(
        { cmd: `GH_TOKEN=${FAKE_SECRETS.tokenValue}`, list: [FAKE_SECRETS.aws], n: 1 },
        opts,
      ),
    );
    expect(out).not.toContain(FAKE_SECRETS.tokenValue);
    expect(out).not.toContain(FAKE_SECRETS.aws);
    expect(out).toContain('"n":1');
  });
});

describe('truncateBytes', () => {
  it('UTF-8 글자 중간에서 자르지 않는다', () => {
    const { text, truncated } = truncateBytes('가'.repeat(10), 7);
    expect(truncated).toBe(true);
    expect(text).toBe('가가');
  });

  it('한도 안이면 그대로 둔다', () => {
    expect(truncateBytes('abc', 3)).toEqual({ text: 'abc', truncated: false });
  });
});
