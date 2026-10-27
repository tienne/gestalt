import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  isSensitiveKey,
  redactText,
  redactValue,
  truncateBytes,
} from '../../../src/peer/redact.js';
import { FAKE_HOME, FAKE_SECRETS } from '../../fixtures/peer/transcript.js';

const opts = { home: FAKE_HOME };

describe('redactText', () => {
  it.each([
    ['AWS 액세스 키', `key ${FAKE_SECRETS.aws} end`],
    ['GitHub ghp_', `token ${FAKE_SECRETS.ghp}`],
    ['GitHub gho_', `token ${FAKE_SECRETS.gho}`],
    ['GitHub github_pat_', `token ${FAKE_SECRETS.githubPat}`],
    ['JWT', `Authorization ${FAKE_SECRETS.jwt}`],
    ['OpenAI sk-proj-', `key ${FAKE_SECRETS.skProj}`],
    ['Stripe sk_live_', `key ${FAKE_SECRETS.skLive}`],
    ['Google AIza', `key ${FAKE_SECRETS.aiza}`],
    ['npm 토큰', `//registry.npmjs.org/:_authToken ${FAKE_SECRETS.npm}`],
    ['GitLab glpat-', `token ${FAKE_SECRETS.glpat}`],
    ['Slack xoxb-', `SLACK ${FAKE_SECRETS.slack}`],
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

  it('이름이 64자보다 길어도 값을 가린다', () => {
    const out = redactText(`${'X'.repeat(70)}_API_KEY=${FAKE_SECRETS.apiKeyValue} rest`, opts);
    expect(out).not.toContain(FAKE_SECRETS.apiKeyValue);
    expect(out).toContain(`_API_KEY=${REDACTED} rest`);
  });

  it('역추적이 터지는 입력도 1초 안에 끝난다', () => {
    for (const input of ['a.'.repeat(100_000), 'KEY'.repeat(70_000), '"key": '.repeat(30_000)]) {
      const started = performance.now();
      redactText(input, opts);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });

  it('이스케이프된 따옴표 값을 가린다', () => {
    const out = redactText(`run "PASSWORD=\\"${FAKE_SECRETS.passwordValue}\\" ls"`, opts);
    expect(out).not.toContain(FAKE_SECRETS.passwordValue);
    expect(out).toContain(`PASSWORD=${REDACTED} ls`);
  });

  it('감싼 대입 값 안의 이스케이프된 따옴표 뒤까지 가린다', () => {
    const out = redactText(JSON.stringify(`PASSWORD="a\\"${FAKE_SECRETS.passwordValue}" ls`), opts);
    expect(out).not.toContain(FAKE_SECRETS.passwordValue);
    expect(out).toContain(`PASSWORD=${REDACTED} ls`);
  });

  it('감싼 대입 값이 백슬래시로 끝나도 다음 대입까지 가린다', () => {
    const out = redactText(
      JSON.stringify(`PASSWORD="a\\\\" TOKEN="${FAKE_SECRETS.tokenValue}" ls`),
      opts,
    );
    expect(out).not.toContain(FAKE_SECRETS.tokenValue);
    expect(out).toContain(`PASSWORD=${REDACTED} TOKEN=${REDACTED} ls`);
  });

  it('따옴표 안 줄바꿈 뒤 조각까지 가린다', () => {
    const out = redactText(`API_KEY="first\n${FAKE_SECRETS.apiKeyValue}" next`, opts);
    expect(out).not.toContain('first');
    expect(out).not.toContain(FAKE_SECRETS.apiKeyValue);
    expect(out).toBe(`API_KEY=${REDACTED} next`);
  });

  it('못 닫힌 따옴표는 줄 끝까지 가린다', () => {
    const out = redactText(`SECRET='${FAKE_SECRETS.secretValue} more\nnext line`, opts);
    expect(out).toBe(`SECRET=${REDACTED}\nnext line`);
  });

  it('이스케이프된 JSON 키의 값을 가린다', () => {
    const out = redactText(`{\\"api_key\\": \\"${FAKE_SECRETS.apiKeyValue}\\", \\"n\\": 1}`, opts);
    expect(out).not.toContain(FAKE_SECRETS.apiKeyValue);
    expect(out).toContain(`\\"api_key\\": \\"${REDACTED}\\"`);
    expect(out).toContain('\\"n\\": 1');
  });

  it('URL의 비밀번호만 가리고 사용자 이름과 호스트는 남긴다', () => {
    const out = redactText(`git clone https://bob:${FAKE_SECRETS.urlPassword}@example.com/x`, opts);
    expect(out).toBe(`git clone https://bob:${REDACTED}@example.com/x`);
  });

  it('사용자 이름 없이 비밀번호만 둔 URL도 가린다', () => {
    const out = redactText(`REDIS_URL=redis://:${FAKE_SECRETS.urlPassword}@localhost:6379`, opts);
    expect(out).toBe(`REDIS_URL=redis://:${REDACTED}@localhost:6379`);
  });

  it('@가 있어도 비밀번호 자리가 아니면 안 건드린다', () => {
    for (const input of ['http://host:8080/x@y', 'git@github.com:a/b', 'ssh://git@host:22/repo']) {
      expect(redactText(input, opts)).toBe(input);
    }
  });

  it('따옴표 친 JSON 키의 값을 가린다', () => {
    const out = redactText(`{"api_key": "${FAKE_SECRETS.apiKeyValue}", "name": "ok"}`, opts);
    expect(out).not.toContain(FAKE_SECRETS.apiKeyValue);
    expect(out).toContain('"name": "ok"');
  });

  it('감싼 JSON 값 안의 이스케이프된 따옴표 뒤까지 가린다', () => {
    const v = FAKE_SECRETS.passwordValue;
    const out = redactText(JSON.stringify(JSON.stringify({ password: `a"${v}`, n: 1 })), opts);
    expect(out).not.toContain(v);
    expect(out).toContain('\\"n\\":1');
  });

  it('감싼 JSON 값이 백슬래시로 끝나도 다음 키의 값까지 가린다', () => {
    const v = FAKE_SECRETS.tokenValue;
    const out = redactText(
      JSON.stringify(JSON.stringify({ password: 'a\\', api_token: v, n: 1 })),
      opts,
    );
    expect(out).not.toContain(v);
    expect(out).toContain('\\"n\\":1');
  });

  it.each(['cookie', 'credentials', 'authorization', 'pwd'])(
    '따옴표 친 %s 키의 값을 가린다',
    (key) => {
      const out = redactText(`{"${key}": "${FAKE_SECRETS.keyOnlyValue}"}`, opts);
      expect(out).toBe(`{"${key}": "${REDACTED}"}`);
    },
  );

  it('따옴표 친 author 키는 안 건드린다', () => {
    expect(redactText('{"author": "kim"}', opts)).toBe('{"author": "kim"}');
  });

  it('Bearer 헤더 값을 가린다', () => {
    const out = redactText(`Authorization: Bearer ${FAKE_SECRETS.tokenValue}`, opts);
    expect(out).not.toContain(FAKE_SECRETS.tokenValue);
    expect(out).toContain(`Bearer ${REDACTED}`);
  });

  it('Basic 헤더 값을 가린다', () => {
    const out = redactText(`Authorization: Basic ${FAKE_SECRETS.tokenValue}`, opts);
    expect(out).toBe(`Authorization: Basic ${REDACTED}`);
  });

  it('curl이 찍는 쿠키 헤더 줄은 콜론 뒤를 줄 끝까지 가린다', () => {
    const v = FAKE_SECRETS.keyOnlyValue;
    const out = redactText(`> Cookie: sid=${v}\n< Set-Cookie: sid=${v}; Path=/\n< X-Ok: 1`, opts);
    expect(out).toBe(`> Cookie: ${REDACTED}\n< Set-Cookie: ${REDACTED}\n< X-Ok: 1`);
  });

  it('따옴표 안 헤더는 닫는 따옴표 앞까지만 가리고 뒤 URL은 남긴다', () => {
    const v = FAKE_SECRETS.keyOnlyValue;
    const out = redactText(`curl -H "X-Api-Key: ${v}" https://api.example.com/v1 -s`, opts);
    expect(out).toBe(`curl -H "X-Api-Key: ${REDACTED}" https://api.example.com/v1 -s`);
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

  it('민감한 키 아래 값은 패턴에 안 걸려도 가린다', () => {
    const v = FAKE_SECRETS.keyOnlyValue;
    const out = redactValue(
      {
        password: v,
        token: 42,
        cookies: ['sid=abc'],
        'x-api-key': v,
        headers: { Authorization: v, accept: 'json' },
        auth: { user: 'bob', pwd: v },
        file_path: '/tmp/a',
      },
      opts,
    );
    expect(out).toEqual({
      password: REDACTED,
      token: REDACTED,
      cookies: REDACTED,
      'x-api-key': REDACTED,
      headers: { Authorization: REDACTED, accept: 'json' },
      auth: { user: 'bob', pwd: REDACTED },
      file_path: '/tmp/a',
    });
  });
});

describe('isSensitiveKey', () => {
  it.each([
    'apiKey',
    'APIKey',
    'x-api-key',
    'AUTH_TOKEN',
    'client.secret',
    'Set-Cookie',
    'apikey',
    'accesstoken',
    'privatekey',
    'secrets',
    'passphrase',
    'DB_PASS',
  ])('%s는 민감하다', (key) => expect(isSensitiveKey(key)).toBe(true));

  it.each([
    'keyword',
    'author',
    'monkey',
    'file_path',
    'tokenizer',
    'max_tokens',
    'tokens',
    'bypass',
  ])('%s는 아니다', (key) => expect(isSensitiveKey(key)).toBe(false));
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
