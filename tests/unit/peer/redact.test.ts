import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  isSensitiveKey,
  redactText,
  redactValue,
  truncateBytes,
} from '../../../src/peer/redact.js';
import { FAKE_HOME, FAKE_SECRETS } from '../../fixtures/peer/transcript.js';

const j = (...parts: string[]): string => parts.join('');

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

  it.each(['DB_PASS', 'MYSQL_PWD', 'COOKIE', 'AUTH', 'GOOGLE_APPLICATION_CREDENTIALS', 'GH_AUTH'])(
    '.env의 %s= 값을 가린다',
    (name) => {
      const v = FAKE_SECRETS.keyOnlyValue;
      expect(redactText(`${name}=${v}`, opts)).toBe(`${name}=${REDACTED}`);
    },
  );

  it.each([
    'BYPASS=1',
    '--bypass=true',
    'OAUTH_CLIENT_ID=abcdef',
    'AUTHOR=kim',
    'PWD=/home/u',
    'OLDPWD=/x',
    'COMPASS=n',
  ])('낱말 일부만 겹치는 %s는 안 건드린다', (input) => expect(redactText(input, opts)).toBe(input));

  it.each(['db_pass', 'passphrase'])('따옴표 친 %s 키의 값을 가린다', (key) => {
    const out = redactText(`{"${key}": "${FAKE_SECRETS.keyOnlyValue}"}`, opts);
    expect(out).toBe(`{"${key}": "${REDACTED}"}`);
  });

  it('따옴표 친 bypass 키는 안 건드린다', () => {
    expect(redactText('{"bypass": "y"}', opts)).toBe('{"bypass": "y"}');
  });

  it('따옴표가 안 닫힌 JSON 값은 그 줄 끝까지만 가리고 다음 줄의 민감한 키 값도 가린다', () => {
    const v = FAKE_SECRETS.tokenValue;
    const out = redactText(`{"password": "abc\n"api_token": "${v}", "n": 1}`, opts);
    expect(out).toBe(`{"password": "${REDACTED}"\n"api_token": "${REDACTED}", "n": 1}`);
  });

  it('JSON 키 값 안에 이스케이프하지 않은 줄바꿈이 있으면 닫는 따옴표를 찾지 않고 그 줄 끝까지만 가린다', () => {
    const out = redactText(`{"password": "line1\nline2", "x": 1}`, opts);
    expect(out).toBe(`{"password": "${REDACTED}"\nline2", "x": 1}`);
  });

  it.each([
    [
      'X-Auth-Token',
      'curl -H "X-Auth-Token: {v}" https://a.example.com',
      'curl -H "X-Auth-Token: {r}" https://a.example.com',
    ],
    [
      'PRIVATE-TOKEN',
      'curl -H "PRIVATE-TOKEN: {v}" https://gitlab.example.com',
      'curl -H "PRIVATE-TOKEN: {r}" https://gitlab.example.com',
    ],
    [
      'api-key',
      "curl -H 'api-key: {v}' https://x.openai.azure.com",
      "curl -H 'api-key: {r}' https://x.openai.azure.com",
    ],
    [
      'X-Goog-Api-Key',
      'curl -H "X-Goog-Api-Key: {v}" https://g.example.com',
      'curl -H "X-Goog-Api-Key: {r}" https://g.example.com',
    ],
    ['> X-CSRF-Token', '> X-CSRF-Token: {v}', '> X-CSRF-Token: {r}'],
    ['Api-Key', 'Api-Key: {v}', 'Api-Key: {r}'],
    ['< X-Client-Secret', '< X-Client-Secret: {v}', '< X-Client-Secret: {r}'],
    [
      'X-Client-Secret',
      'curl -H "X-Client-Secret: {v}" https://a.example.com',
      'curl -H "X-Client-Secret: {r}" https://a.example.com',
    ],
  ])('하이픈으로 이어진 %s 헤더 값을 가린다', (_name, input, expected) => {
    const v = FAKE_SECRETS.keyOnlyValue;
    expect(redactText(input.replace('{v}', v), opts)).toBe(expected.replace('{r}', REDACTED));
  });

  it.each([
    '  token: string;',
    '  accessToken: string,',
    '    secret: process.env.SECRET,',
    'max_tokens: 100',
    'Accept: */*',
    'Token: see below',
    'Xapi-Key: abcdef123456',
    'X-AuthToken: abcdef123456',
    "curl -H 'Xapi-Key: abcdef123456' https://a.example.com",
    "curl -H 'X-AuthToken: abcdef123456' https://a.example.com",
  ])('헤더 꼴이 아닌 %s 줄은 안 건드린다', (input) => expect(redactText(input, opts)).toBe(input));

  it.each([
    ["{'Cookie': 'sid={v}'}", "{'Cookie': '{r}'}"],
    ["{'X-Api-Key': '{v}', 'n': 1}", "{'X-Api-Key': '{r}', 'n': 1}"],
    ["{'db_pass': '{v}'}", "{'db_pass': '{r}'}"],
  ])('작은따옴표 친 키 %s의 값을 가린다', (input, expected) => {
    const v = FAKE_SECRETS.keyOnlyValue;
    expect(redactText(input.replace('{v}', v), opts)).toBe(expected.replace('{r}', REDACTED));
  });

  it("작은따옴표 친 'author'와 'bypass' 키는 안 건드린다", () => {
    const input = "{'author': 'kim', 'bypass': 'y'}";
    expect(redactText(input, opts)).toBe(input);
  });

  it.each([
    'Basic authentication is simple',
    'Use basic configuration here',
    'Basic Configuration',
    '## Basic TypeScript types',
    'Basic JavaScript tutorial',
    'Basic PostgreSQL setup',
    'see Basic README.md here',
    'see Basic CONTRIBUTING.md here',
    'Basic HTTP/1.1 auth',
    'Basic 2024-10-28 report',
    'Basic Usage/Examples',
    'Basic Ubuntu22.04 setup',
    'Basic IPv4/IPv6 setup',
  ])('영어 문장 %s의 Basic은 안 건드린다', (input) => expect(redactText(input, opts)).toBe(input));

  it.each([
    "{'Authorization': 'Basic dXNlcjpwYXNz'}",
    "{ authorization: 'Basic dXNlcjpwYXNz' }",
    'headers: { Authorization: "Basic dXNlcjpwYXNz" }',
    'Basic YWxhZGRpbjpvcGVuc2VzYW1l',
    'Basic YWRtaW46YQ==',
    "{ authorization: 'Basic YWRtaW46YQ==' }",
    'the header is Basic dXNlcjpwYXNz.',
  ])('%s의 Basic 값을 가린다', (input) => {
    const out = redactText(input, opts);
    expect(out).not.toContain('dXNlcjpwYXNz');
    expect(out).not.toContain('YWxhZGRpbjpvcGVuc2VzYW1l');
    expect(out).not.toContain('YWRtaW46YQ');
    expect(out).toContain(REDACTED);
  });

  it('알려진 과잉 가림: Basic 뒤 낱말이 base64 꼴과 겹치면 영어 문장도 가린다', () => {
    expect(redactText('Basic HTML/CSS tutorial', opts)).toBe(`Basic ${REDACTED} tutorial`);
    expect(redactText('Basic MongoDB4 setup', opts)).toBe(`Basic ${REDACTED} setup`);
  });

  it('Basic 값 바로 뒤에 마침표와 글자가 이어지면 값으로 안 본다', () => {
    expect(redactText('x Basic dXNlcjpwYXNz.x', opts)).toBe('x Basic dXNlcjpwYXNz.x');
  });

  it.each(['x BASIC dXNlcjpwYXNz', 'x Basic dXNlcjpwYXNzd29yZA', 'x Basic dXNlcjpw-YXNz_d29y'])(
    '헤더 줄과 따옴표 안 헤더 밖의 %s는 그대로 둔다(알려진 빈자리)',
    (input) => {
      expect(redactText(input, opts)).toBe(input);
    },
  );

  it.each([
    ['Authorization: BASIC dXNlcjpwYXNz', `Authorization: BASIC ${REDACTED}`],
    [
      'curl -H "Authorization: BASIC dXNlcjpwYXNz" https://a.example.com',
      `curl -H "Authorization: BASIC ${REDACTED}" https://a.example.com`,
    ],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA', `Authorization: Basic ${REDACTED}`],
    [
      "curl -H 'Authorization: Basic dXNlcjpw-YXNz_d29y' https://a.example.com",
      `curl -H 'Authorization: Basic ${REDACTED}' https://a.example.com`,
    ],
  ])('헤더 줄과 따옴표 안 헤더의 %s는 가린다', (input, expected) => {
    expect(redactText(input, opts)).toBe(expected);
  });

  it('값이 9000자인 쿠키 헤더도 원문 조각을 안 남긴다', () => {
    const v = 'q'.repeat(9_000);
    expect(redactText(`> Cookie: ${v}\n< X-Ok: 1`, opts)).toBe(`> Cookie: ${REDACTED}\n< X-Ok: 1`);
    expect(redactText(`curl -H "Cookie: ${v}" https://a.example.com`, opts)).toBe(
      `curl -H "Cookie: ${REDACTED}" https://a.example.com`,
    );
  });

  it.each([
    ['AWS ASIA', j('ASIA', 'IOSFODNN7', 'EXAMPLE')],
    ['AWS ABIA', j('ABIA', 'IOSFODNN7', 'EXAMPLE')],
    ['AWS ACCA', j('ACCA', 'IOSFODNN7', 'EXAMPLE')],
    ['GitHub ghu_', j('ghu', '_', 'FAKEFAKEFAKEFAKEFAKE0000')],
    ['GitHub ghs_', j('ghs', '_', 'FAKEFAKEFAKEFAKEFAKE0000')],
    ['GitHub ghr_', j('ghr', '_', 'FAKEFAKEFAKEFAKEFAKE0000')],
    ['Anthropic sk-ant-', j('sk-', 'ant-', 'FAKEFAKEFAKEFAKE0000')],
    ['Stripe rk_test_', j('rk_', 'test_', 'FAKEFAKEFAKEFAKE0000')],
    ['Slack xoxp-', j('xox', 'p-', '0000FAKE-FAKEFAKEFAKE')],
  ])('%s를 가린다', (_name, secret) => {
    expect(redactText(`v ${secret} end`, opts)).toBe(`v ${REDACTED} end`);
  });

  it('소문자 bearer 뒤 값도 가린다', () => {
    const out = redactText(`authorization: bearer ${FAKE_SECRETS.tokenValue}`, opts);
    expect(out).not.toContain(FAKE_SECRETS.tokenValue);
  });

  it('소문자 basic 뒤 값은 안 건드린다', () => {
    expect(redactText('use basic dXNlcjpwYXNz', opts)).toBe('use basic dXNlcjpwYXNz');
  });

  it.each(['Proxy-Authorization', 'X-Api-Key', 'Authorization', 'set-cookie'])(
    '줄 첫머리 %s: 헤더는 앞 공백이 있어도 줄 끝까지 가린다',
    (name) => {
      const out = redactText(`  ${name}: ${FAKE_SECRETS.keyOnlyValue} x\nnext`, opts);
      expect(out).toBe(`  ${name}: ${REDACTED}\nnext`);
    },
  );

  it.each(['DB_PASSWD', 'GCP_CREDENTIAL'])('%s= 값을 가린다', (name) => {
    expect(redactText(`${name}=${FAKE_SECRETS.keyOnlyValue}`, opts)).toBe(`${name}=${REDACTED}`);
  });

  it('대입 따옴표 값이 4096자 안에서 안 닫히면 첫 줄 끝까지만 가린다', () => {
    const out = redactText(`API_KEY="${'a'.repeat(5_000)}\nsecond" next`, opts);
    expect(out).toBe(`API_KEY=${REDACTED}\nsecond" next`);
  });

  it.each(['access_token', 'client_secret', 'passwd', 'x_auth', 'session_cookie'])(
    '따옴표 친 %s 키의 값을 가린다',
    (key) => {
      const out = redactText(`{"${key}": "${FAKE_SECRETS.keyOnlyValue}", "n": 1}`, opts);
      expect(out).toBe(`{"${key}": "${REDACTED}", "n": 1}`);
    },
  );

  it('JSON 키 값이 4096자 안에서 안 닫히면 그 줄 끝까지 가린다', () => {
    const out = redactText(`{"token": "${'a'.repeat(5_000)}"}\nnext`, opts);
    expect(out).toBe(`{"token": "${REDACTED}"\nnext`);
  });

  it('작은따옴표 키 값이 같은 줄 4096자 안에서 안 닫히면 못 가린다(알려진 빈자리)', () => {
    const long = `{'token': '${'a'.repeat(5_000)}'}`;
    expect(redactText(long, opts)).toBe(long);
    const multi = "{'token': 'line1\nline2'}";
    expect(redactText(multi, opts)).toBe(multi);
  });

  it.each([
    'SESSION=abcdef123456',
    '{"sid": "abcdef123456"}',
    '< X-Session: abcdef123456',
    '{"password": 12345}',
    "{ password: 'hunter2' }",
    'X_Auth-Token: abcdef123456',
    'X-Foo.Bar-Api-Key: abcdef123456',
  ])('목록 밖인 %s는 그대로 둔다(알려진 빈자리)', (input) => {
    expect(redactText(input, opts)).toBe(input);
  });

  it('새 패턴은 1MB 반복 입력도 100ms 안에 끝난다', () => {
    const MB = 1024 * 1024;
    const fill = (unit: string): string => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
    const inputs = [
      '_PASS',
      '_PWD',
      '_AUTH',
      'COOKIE',
      'CREDENTIALS',
      'DB_PASS=',
      '"pass": "',
      "'key': ",
      "'pass': '",
      "'x-api-key': '",
      "'",
      'Basic ',
      'a-',
      'x-token',
      '"a-',
      'a-a-a-a-a-a-a-a-a-a-a\n',
      'Cookie: x\n',
      '"Cookie: ',
    ].map(fill);
    inputs.push(
      'Basic a' + fill('a-'),
      'Basic ' + fill('A'),
      'Basic ' + fill('A').slice(2) + '.x',
      "'key': '" + fill('a'),
      '"' + fill('a-'),
    );
    for (const input of inputs) {
      // 첫 실행은 JIT과 GC가 섞인다. 역추적이 터지면 몇 초가 걸리므로 가장 빠른 값으로 본다
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        redactText(input, opts);
        best = Math.min(best, performance.now() - started);
      }
      expect(best, JSON.stringify(input.slice(0, 16))).toBeLessThan(100);
    }
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

  it('key로 끝나는 합성어 키 아래 값도 가린다', () => {
    const v = FAKE_SECRETS.keyOnlyValue;
    expect(redactValue({ headers: { accesskey: v, hotkey: 'k' } }, opts)).toEqual({
      headers: { accesskey: REDACTED, hotkey: 'k' },
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
    'accesskey',
    'accesskeys',
    'passwd',
    'credential',
    'credentials',
    'cookie',
    'SECRETKEY',
    'signingkey',
    'encryptionkey',
    'masterkey',
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
    'turnkey',
    'hotkey',
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
