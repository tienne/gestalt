// 비밀값처럼 생긴 테스트 값은 시크릿 스캐너에 안 걸리게 소스에 그대로 쓰지 않고 실행할 때 조각을 이어 만든다
import { describe, expect, it } from 'vitest';
import {
  SECRET_MASK,
  maskIrSecrets,
  maskSecrets,
  maskWarningMessages,
  secretMaskedWarnings,
} from '../../../src/architecture/secret-mask.js';
import type { ArchitectureIr } from '../../../src/architecture/types.js';
import { FAKE_TOKEN, noise } from './fake-secrets.js';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';

const join = (...parts: string[]): string => parts.join('');
const b64url = (s: string): string => Buffer.from(s).toString('base64url');

const SECRETS = {
  github: join('gh', 'p_', noise(1, 36)),
  githubFine: join('github', '_pat_', noise(2, 60, `${ALNUM}_`)),
  gitlab: join('gl', 'pat-', noise(3, 20)),
  slack: join('xo', 'xb-', noise(4, 12, '0123456789'), '-', noise(5, 24)),
  aws: join('AK', 'IA', noise(6, 16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')),
  google: join('AI', 'za', noise(7, 35)),
  stripe: join('sk', '_live_', noise(8, 24)),
  openai: join('sk', '-proj-', noise(9, 48)),
  anthropic: join('sk', '-ant-', 'api03-', noise(10, 40)),
  npm: join('np', 'm_', noise(11, 36)),
  huggingface: join('h', 'f_', noise(12, 34)),
  sendgrid: join('S', 'G.', noise(13, 22), '.', noise(14, 43)),
};

const PASSWORD = join('Tr', '0ub', '4dor', '-', noise(15, 8));
const JWT = join(
  b64url('{"alg":"HS256","typ":"JWT"}'),
  '.',
  b64url(`{"sub":"${noise(16, 10)}","iat":1700000000}`),
  '.',
  noise(17, 43, `${ALNUM}_-`),
);
const PRIVATE_KEY_BODY = noise(18, 64, `${ALNUM}+/`);
const PRIVATE_KEY = join(
  '-----BEGIN ',
  'RSA PRIVATE',
  ' KEY-----\n',
  PRIVATE_KEY_BODY,
  '\n',
  noise(19, 64, `${ALNUM}+/`),
  '\n-----END ',
  'RSA PRIVATE',
  ' KEY-----',
);
const RANDOM_QUOTED = noise(20, 40);
// 산문 속 생성 키 꼴. 대소문자와 숫자가 고루 섞이도록 만든다
const BARE_KEY = join('Kq8', noise(21, 10), 'Zt07', noise(22, 10), 'Lm4R', '9w');

function expectHidden(input: string, value: string): string {
  const r = maskSecrets(input);
  expect(r.text, input).not.toContain(value);
  expect(r.text).toContain(SECRET_MASK);
  expect(r.masked).toBeGreaterThan(0);
  // 두 번 돌려도 같은 결과다. 표식은 다시 안 가린다
  const again = maskSecrets(r.text);
  expect(again.text).toBe(r.text);
  expect(again.masked).toBe(0);
  return r.text;
}

function expectUntouched(input: string): void {
  const r = maskSecrets(input);
  expect(r.text, input).toBe(input);
  expect(r.masked, input).toBe(0);
}

describe('maskSecrets — 가려야 하는 값', () => {
  it.each(Object.entries(SECRETS))('알려진 키 형식 %s', (_name, key) => {
    expectHidden(`설정에 ${key} 를 넣었다`, key);
    expectHidden(`token = "${key}"`, key);
  });

  it('개인 키 블록은 BEGIN부터 END까지 통째로 가린다', () => {
    const out = expectHidden(`키 파일:\n${PRIVATE_KEY}\n끝`, PRIVATE_KEY_BODY);
    expect(out).toBe(`키 파일:\n${SECRET_MASK}\n끝`);
  });

  it('END가 없는 개인 키 블록은 글 끝까지 가린다', () => {
    const cut = PRIVATE_KEY.slice(0, PRIVATE_KEY.indexOf('-----END'));
    expectHidden(`앞 ${cut}`, PRIVATE_KEY_BODY);
  });

  it('JWT', () => {
    expectHidden(`Authorization: Bearer ${JWT}`, JWT);
  });

  it('DB 접속 주소의 비밀번호만 가리고 사용자와 호스트는 남긴다', () => {
    const out = expectHidden(`postgres://app:${PASSWORD}@db.internal:5432/app`, PASSWORD);
    expect(out).toBe(`postgres://app:${SECRET_MASK}@db.internal:5432/app`);
  });

  it.each([
    ['DB_PASSWORD = "%s"'],
    ['"apiKey": "%s"'],
    ["client_secret: '%s'"],
    ['const password = `%s`'],
    ['routeToken: "%s"'],
  ])('비밀 이름에 대입한 따옴표 값 %s', (tpl) => {
    expectHidden(tpl.replace('%s', PASSWORD), PASSWORD);
  });

  it('비밀번호 이름 아래 경로처럼 생긴 값은 프로젝트 파일 경로가 아니면 가린다', () => {
    const pw = join('k9/', 'Lm2', '.Qp8x');
    expectHidden(`'password' => '${pw}'`, pw);
  });

  it('비밀번호는 pk_로 시작해도 가린다', () => {
    const pw = join('pk', '_', noise(23, 20));
    expectHidden(`DB_PASSWORD = '${pw}'`, pw);
  });

  it('접근 토큰 이름에 붙은 ULID 꼴 값은 가린다', () => {
    const ulid = join('01H', noise(24, 23, '0123456789ABCDEFGHJKMNPQRSTVWXYZ'));
    expectHidden(`accessToken: '${ulid}'`, ulid);
  });

  it('따옴표 안 무작위 긴 글자는 이름이 없어도 가린다', () => {
    expectHidden(`config("${RANDOM_QUOTED}")`, RANDOM_QUOTED);
  });

  it('산문 속 따옴표 없는 생성 키 꼴', () => {
    expectHidden(`배포 키는 ${BARE_KEY} 로 넣어 두었다`, BARE_KEY);
  });

  it('따옴표 없는 대입 값', () => {
    const pw = join('hunter', '2', noise(40, 6));
    const key = join('Zk3', noise(41, 20));
    const out = expectHidden(`password=${pw} and API_KEY=${key}`, pw);
    expect(out).not.toContain(key);
    expect(maskSecrets(`password=${pw} and API_KEY=${key}`).masked).toBe(2);
    expectHidden(`export DB_PASSWORD=${pw}`, pw);
    expectHidden(`TOKEN := ${key}`, key);
    expectHidden(`DB_PASSWORD=${join('super', 'secret')}`, join('super', 'secret'));
  });

  it.each([
    ['점이 섞인 .env 비밀번호', 'DB_PASSWORD=Summer2024.Corp1', 'Summer2024.Corp1'],
    ['점이 섞인 export 키', 'export API_KEY=Zk3Lm9.Qp2Rt7Vx1', 'Zk3Lm9.Qp2Rt7Vx1'],
    ['소괄호가 든 비밀번호', 'password=Hunter(2)abc9', 'Hunter(2)abc9'],
    ['대괄호가 든 비밀번호', 'password=Hunter[2]abc9', 'Hunter[2]abc9'],
    ['중괄호가 든 비밀번호', 'password=Hun{2}ter9abc', 'Hun{2}ter9abc'],
  ])('따옴표 없는 대입 값 중 코드처럼 생긴 비밀번호 %s', (_name, text, secret) => {
    expectHidden(text, secret);
  });

  it('호출 인자 안 대입은 값만 가리고 닫는 괄호는 남긴다', () => {
    const out = expectHidden('login(password=Hunter(2)abc9)', 'Hunter(2)abc9');
    expect(out).toBe(`login(password=${SECRET_MASK})`);
  });

  // 바깥 대입이 값으로 나머지를 통째로 삼켜도 안쪽 대입을 다시 본다
  it.each([
    ['systemd Environment', 'Environment=DB_PASSWORD=Summer2024xK', 'Environment=DB_PASSWORD=%m'],
    ['콜론 뒤 .env 대입', 'env:DB_PASSWORD=Summer2024xK', 'env:DB_PASSWORD=%m'],
    ['대입 값 호출 인자', 'cfg=f(password=Summer2024xK)', 'cfg=f(password=%m)'],
    ['띄운 대입 값 호출 인자', 'x = f(password=a1b2c3d4e5)', 'x = f(password=%m)'],
    ['점 이름 콜론 뒤 대입', 'config.db:password=Summer2024xK', 'config.db:password=%m'],
    [
      '비밀 이름 대입 값 호출',
      'credentials=dict(password=Summer2024xK)',
      'credentials=dict(password=%m)',
    ],
    ['토큰 대입 값 호출', 'token=f(password=Summer2024xK)', 'token=f(password=%m)'],
    ['여러 겹 대입', 'k=v=w=password=Summer2024xK', 'k=v=w=password=%m'],
    ['비밀 아닌 이름 대입', 'KEY=DB_PASSWORD=Summer2024xK', 'KEY=DB_PASSWORD=%m'],
    ['대괄호로 감싼 대입', 'x=[password=Summer2024xK]', 'x=[password=%m]'],
    ['중괄호로 감싼 대입', 'x={password=Summer2024xK}', 'x={password=%m}'],
    ['명령행 인자', 'mysql --password=Summer2024xK', 'mysql --password=%m'],
  ])('바깥 대입 안쪽의 대입 %s', (_name, text, expected) => {
    const r = maskSecrets(text);
    expect(r.masked).toBe(1);
    expect(r.text).toBe(expected.replace('%m', SECRET_MASK));
    expectHidden(text, text.includes('a1b2c3d4e5') ? 'a1b2c3d4e5' : 'Summer2024xK');
  });

  it.each([
    'password=Hunter(2)',
    'password=Aa1(2)',
    'DB_PASSWORD=Summer(2024)',
    'password=Hunter2[x]',
    'password=Zk3Lm9.Qp2Rt7Vx1[0]',
    'pass:Abc(1)23',
  ])('닫는 괄호로 끝나는 비밀번호 %s', (text) => {
    const r = maskSecrets(text);
    expect(r.masked).toBe(1);
    expect(r.text).toBe(text.replace(/([:=]).*$/, `$1${SECRET_MASK}`));
  });

  it('콜론 뒤 따옴표 없는 값은 숫자와 글자가 섞였을 때만 가린다', () => {
    const key = join('Zk3', noise(42, 20));
    expectHidden(`client_secret: ${key}`, key);
  });

  it.each([
    ['token', '?token=%s&page=2'],
    ['access_token', 'https://api.example.com/cb?state=1&access_token=%s'],
    ['X-Amz-Signature', 'https://bucket.s3.amazonaws.com/a.png?X-Amz-Signature=%s'],
    ['fragment access_token', 'https://app.example.com/cb#access_token=%s&type=bearer'],
    ['sig', 'https://cdn.example.com/f?sig=%s'],
  ])('URL 쿼리와 fragment의 비밀 키 값 %s', (_name, tpl) => {
    const v = noise(43, 24);
    const out = expectHidden(tpl.replace('%s', v), v);
    expect(out).toContain('=' + SECRET_MASK);
  });

  it('한 글에 여러 비밀값이 섞여도 전부 가리고 개수를 센다', () => {
    const text = `a ${SECRETS.github} b postgres://u:${PASSWORD}@h/db c ${JWT}`;
    const r = maskSecrets(text);
    expect(r.masked).toBe(3);
    for (const v of [SECRETS.github, PASSWORD, JWT]) expect(r.text).not.toContain(v);
  });

  it('입력이 길어도 금방 끝난다', () => {
    const long = `${'a'.repeat(50_000)} ${'Q9'.repeat(20_000)} "${'x1'.repeat(10_000)}`;
    const t0 = Date.now();
    maskSecrets(long);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('maskSecrets — 가리면 안 되는 값', () => {
  const ulid = join('01H', noise(25, 23, '0123456789ABCDEFGHJKMNPQRSTVWXYZ'));
  const hash = noise(26, 40, HEX);
  const uuid = [
    noise(27, 8, HEX),
    noise(28, 4, HEX),
    noise(29, 4, HEX),
    noise(30, 4, HEX),
    noise(31, 12, HEX),
  ].join('-');
  const pubBody = noise(32, 24);

  it.each([
    ['환경변수 참조', 'const apiKey = process.env.API_KEY;'],
    ['환경변수 참조 따옴표', 'API_KEY = "process.env.API_KEY"'],
    ['import.meta.env', 'token: import.meta.env.VITE_TOKEN'],
    ['템플릿 참조', 'token = "${API_TOKEN}"'],
    ['셸 변수', 'DB_PASSWORD="$POSTGRES_PASSWORD"'],
    ['env()', 's3_secret_key = "env(S3_SECRET_KEY)"'],
    ['changeme', 'DB_PASSWORD = "changeme"'],
    ['your-...-here', 'API_KEY = "your-api-key-here"'],
    ['xxxx', 'SECRET = "xxxxxxxx"'],
    ['꺾쇠 안내', 'token: "<여기에 토큰>"'],
    ['한국어 안내', 'API_KEY = "여기에-키-입력"'],
    ['포르투갈어 안내', 'SECRET_KEY: "sua-chave-secreta-aqui-123"'],
    ['스페인어 안내', 'JWT_SECRET: "tu_clave_secreta_aqui_1"'],
    ['프랑스어 안내', 'SECRET_KEY: "votre_cle_secrete_ici_1"'],
    ['독일어 안내', 'SECRET_KEY: "deine-geheime-zeichenkette-1"'],
    ['자동 완성 낱말', 'autoComplete: "current-password"'],
    ['일반 URL', 'API_URL = "https://api.example.com/v1/orders"'],
    ['비밀번호 없는 접속 주소', 'postgres://db.internal:5432/app'],
    ['접속 주소 안내 비밀번호', 'postgres://user:password@localhost:5432/app'],
    ['파일 경로', 'src/architecture/secret-mask.ts:42 에서 가린다'],
    ['비밀 이름 아래 파일 경로', "'reset_password' => 'views/auth/reset-password.blade.php'"],
    ['CamelCase 식별자', 'ArchitecturePassthroughRenderDeltaSnapshotBuilder 를 부른다'],
    ['일반 문장', '결제 서버가 주문 DB에 쓰고 알림 큐로 이벤트를 보낸다.'],
    ['계정 ID 표식', '[계정 ID] 와 [배포 ID]'],
    ['콜론 뒤 낱말', 'auth: Keycloak'],
    ['헤더 이름', 'Authorization: Bearer'],
    ['타입 이름', 'token: AccessToken'],
    ['스키마 선언', 'apiKey: z.string()'],
    ['함수 호출 대입', 'const token = await getToken(user1);'],
    ['멤버 대입', 'const token = this.session.token;'],
    ['짧은 멤버 대입', 'token = this.token'],
    ['인덱싱 대입', 'const token = this.tokens[0];'],
    ['JSX 식', '<Auth token={session.accessToken} />'],
    ['JSX 식 변수', '<Login password={pw} />'],
    ['배열 리터럴', 'token: [tok1, tok2]'],
    ['호출 인자 안 호출 대입', 'login(password=getToken(user1))'],
    ['비밀번호 이름 인덱싱', 'password=argv[1]'],
    ['짧은 비밀번호 이름 인덱싱', 'pwd=args[0]'],
    ['비밀번호 이름 소문자 호출', 'password=input(2)'],
    ['바깥 대입 안 낱말 대입', 'KEY=a=b'],
    ['바깥 대입 안 시각', 'time=12:30:45'],
    ['바깥 대입 안 비밀 아닌 대입', 'foo=bar:baz=qux'],
    ['변수 대입', 'const password = input;'],
    ['비교', 'if (token === undefined) return;'],
    ['화살표', 'tokens.map(token => tokenize(token))'],
    ['문서 앵커', 'https://wiki.example.com/x#설치'],
    ['쿼리 안 템플릿 참조', 'https://api.example.com/cb?token=${TOKEN}'],
  ])('%s', (_name, text) => {
    expectUntouched(text);
  });

  it('UUID', () => {
    expectUntouched(`요청 id ${uuid}`);
    expectUntouched(`requestId: "${uuid}"`);
  });

  it('커밋 해시', () => {
    expectUntouched(`커밋 ${hash} 에서 바뀌었다`);
    expectUntouched(`sha: "${hash}"`);
  });

  it('ULID 레코드 id', () => {
    expectUntouched(`주문 ${ulid}`);
    expectUntouched(`routeToken: '${ulid}'`);
  });

  it.each(['pk_live_', 'pk_test_', 'sb_publishable_', 'phc_'])('공개 키 %s', (prefix) => {
    const key = join(prefix, pubBody, pubBody);
    expectUntouched(`const LOGO_API_KEY = '${key}';`);
    expectUntouched(`token: "${key}"`);
  });

  it('알파벳을 늘어놓은 지어낸 키는 형식이 맞아도 놔둔다', () => {
    const dummy = join('gh', 'p_', 'abcdefghijklmnopqrstuvwxyz', '0123456789');
    expectUntouched(`const token = '${dummy}';`);
  });

  it('빈 글자', () => {
    expect(maskSecrets('')).toEqual({ text: '', masked: 0 });
  });
});

describe('secretMaskedWarnings', () => {
  it('같은 자리는 한 번만 싣고 위치만 담는다', () => {
    const out = secretMaskedWarnings([
      { nodeId: 'api', field: 'description' },
      { nodeId: 'api', field: 'description' },
      { flowId: 'f1', field: 'steps[s1].label' },
      { field: 'sourcesUsed[0].identifier' },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ code: 'SECRET_MASKED', nodeId: 'api', field: 'description' });
    expect(out[1]).toMatchObject({ flowId: 'f1', field: 'steps[s1].label' });
    expect(Object.keys(out[2]!).sort()).toEqual(['code', 'field', 'message']);
  });
});

describe('maskWarningMessages', () => {
  it('경고 문구 안 비밀값을 가리고 나머지는 같은 객체로 둔다', () => {
    const clean = { code: 'X', message: '그냥 문구' };
    const dirty = { code: 'Y', message: `도구 "${SECRETS.github}"에 없는 action` };
    const [a, b] = maskWarningMessages([clean, dirty]);
    expect(a).toBe(clean);
    expect(b!.message).not.toContain(SECRETS.github);
    expect(b!.code).toBe('Y');
  });
});

describe('maskIrSecrets — 요약과 일러두기', () => {
  const baseIr = (): ArchitectureIr => ({
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'web', name: 'acme-web', root: '/repo/acme-web' }],
    nodes: [{ id: 'api', kind: 'api', label: 'api', repo: 'web', evidence: [] }],
    edges: [],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('노드 summary와 IR summary, note를 가리고 위치만 남긴다', () => {
    const ir = baseIr();
    ir.nodes[0]!.summary = `키 ${FAKE_TOKEN} 로 붙는다`;
    ir.summary = `전체 요약 ${FAKE_TOKEN}`;
    ir.note = `일러두기 ${FAKE_TOKEN}`;
    const snapshot = structuredClone(ir);

    const { ir: masked, hits } = maskIrSecrets(ir);
    expect(JSON.stringify(masked)).not.toContain(FAKE_TOKEN);
    expect(masked.nodes[0]!.summary).toContain(SECRET_MASK);
    expect(masked.summary).toContain(SECRET_MASK);
    expect(masked.note).toContain(SECRET_MASK);
    expect(hits).toEqual(
      expect.arrayContaining([
        { nodeId: 'api', field: 'summary' },
        { field: 'summary' },
        { field: 'note' },
      ]),
    );
    expect(hits).toHaveLength(3);
    expect(ir).toEqual(snapshot);
  });

  it('code가 아닌 근거의 위치를 가리고 code 근거 위치와 문서 앵커는 남긴다', () => {
    const ir = baseIr();
    const tok = noise(44, 24);
    const sig = noise(45, 40);
    ir.nodes[0]!.evidence = [
      { type: 'code', location: 'web:src/a.ts:3', visibility: 'public' },
      { type: 'doc', location: `https://api.example.com/x?token=${tok}`, visibility: 'public' },
      {
        type: 'doc',
        location: `https://b.s3.amazonaws.com/a?X-Amz-Signature=${sig}`,
        visibility: 'public',
      },
      {
        type: 'doc',
        location: `https://app.example.com/cb#access_token=${tok}`,
        visibility: 'public',
      },
      { type: 'doc', location: 'https://wiki.example.com/x#설치', visibility: 'public' },
    ];
    const { ir: masked, hits } = maskIrSecrets(ir);
    const locs = masked.nodes[0]!.evidence.map((e) => e.location);
    expect(locs[0]).toBe('web:src/a.ts:3');
    expect(locs[1]).toBe(`https://api.example.com/x?token=${SECRET_MASK}`);
    expect(locs[2]).not.toContain(sig);
    expect(locs[3]).toBe(`https://app.example.com/cb#access_token=${SECRET_MASK}`);
    expect(locs[4]).toBe('https://wiki.example.com/x#설치');
    expect(hits).toEqual(
      expect.arrayContaining([
        { nodeId: 'api', field: 'evidence[1].location' },
        { nodeId: 'api', field: 'evidence[2].location' },
        { nodeId: 'api', field: 'evidence[3].location' },
      ]),
    );
    expect(hits).toHaveLength(3);
  });

  it('칸이 없으면 키를 새로 만들지 않는다', () => {
    const ir = baseIr();
    ir.nodes[0]!.description = FAKE_TOKEN;
    const { ir: masked } = maskIrSecrets(ir);
    expect(masked).not.toBe(ir);
    expect('summary' in masked).toBe(false);
    expect('note' in masked).toBe(false);
    expect('summary' in masked.nodes[0]!).toBe(false);
  });
});
