import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * peer 테스트용 합성 대화 기록. 실제 기록은 개인정보가 섞여 있어 복사하지 않는다.
 *
 * 가짜 비밀값은 조각을 이어 붙여 만든다. 레포 파일에 토큰 꼴 문자열이 그대로 있으면
 * 원격 저장소의 비밀값 검사가 push를 막을 수 있다.
 *
 * 나가면 안 되는 본문에는 `LEAK_` 표식을 심는다. 테스트는 출력 어디에도 `LEAK_`가
 * 없는지 문자열로 확인한다.
 *
 * 수동 확인용 파일이 필요하면 `pnpm tsx tests/fixtures/peer/transcript.ts <출력 경로>`.
 */

export const FAKE_HOME = '/Users/fake-user';

/** 4KB 뒤에 둔 표식. summary에서는 안 나오고 full에서는 나온다 */
export const TAIL_MARKER = 'TAIL_BEYOND_4KB';

const j = (...parts: string[]): string => parts.join('');

export const FAKE_SECRETS = {
  aws: j('AKIA', 'IOSFODNN7', 'EXAMPLE'),
  ghp: j('ghp', '_', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000'),
  gho: j('gho', '_', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1111'),
  githubPat: j('github', '_pat_', '11FAKEFAKE0_FAKEFAKEFAKEFAKEFAKEFAKE'),
  jwt: j(
    'eyJhbGciOiJIUzI1NiJ9',
    '.',
    'eyJzdWIiOiJmYWtlLXVzZXIifQ',
    '.',
    'ZmFrZS1zaWduYXR1cmUtbm90LXJlYWw',
  ),
  pemBody: 'FAKEPEMBODYNOTAREALKEY0000',
  apiKeyValue: 'fake-api-key-value-0000',
  tokenValue: 'fake-token-value-1111',
  secretValue: 'fake-secret-value-2222',
  passwordValue: 'fake-password-value-3333',
  skProj: j('sk-', 'proj-', 'FAKEFAKEFAKEFAKEFAKEFAKE0000'),
  skLive: j('sk_', 'live_', 'FAKEFAKEFAKEFAKE0000'),
  aiza: j('AIza', 'SyFAKEFAKEFAKEFAKEFAKEFAKEFAKE00000'),
  npm: j('npm_', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000'),
  glpat: j('glpat-', 'FAKEFAKEFAKEFAKE0000'),
  urlPassword: 'fake-url-pass-5555',
  /** 어떤 패턴에도 안 걸리고 키 이름으로만 가려지는 값 */
  keyOnlyValue: 'fake-plain-value-4444',
} as const;

const pem = j(
  '-----BEGIN ',
  'RSA PRIVATE KEY-----\n',
  FAKE_SECRETS.pemBody,
  '\n-----END ',
  'RSA PRIVATE KEY-----',
);

const base = {
  sessionId: 'fixture-session-0001',
  cwd: `${FAKE_HOME}/dev/proj`,
  version: '2.1.311',
  isSidechain: false,
};

let n = 0;
const at = (): string => new Date(Date.UTC(2026, 9, 27, 1, 0, n++)).toISOString();

export function fixtureLines(): string[] {
  n = 0;
  const lines: unknown[] = [
    { type: 'queue-operation', operation: 'enqueue', sessionId: base.sessionId, timestamp: at() },
    {
      ...base,
      type: 'attachment',
      timestamp: at(),
      attachment: { type: 'file', content: 'LEAK_ATTACHMENT body' },
    },
    {
      ...base,
      type: 'user',
      timestamp: at(),
      message: {
        role: 'user',
        content:
          '<system-reminder>LEAK_REMINDER CLAUDE.md 내용</system-reminder>\n' +
          `안녕하세요, ${FAKE_HOME}/dev/proj 에서 export API_KEY=${FAKE_SECRETS.apiKeyValue} 를 봐주세요` +
          '\n<system-reminder>LEAK_REMINDER2 메모리</system-reminder>',
      },
    },
    {
      ...base,
      type: 'api-request',
      timestamp: at(),
      params: { system: 'LEAK_API_REQUEST system prompt' },
    },
    { type: 'api-request-blob', hash: 'h', message: { content: 'LEAK_API_BLOB' } },
    { type: 'api-request-shape', shape: 'LEAK_API_SHAPE', timestamp: at() },
    {
      ...base,
      type: 'assistant',
      timestamp: at(),
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'LEAK_THINKING 속으로 생각', signature: 'LEAK_SIG' },
          { type: 'text', text: `확인해볼게요. 토큰 ${FAKE_SECRETS.ghp} 는 가려야겠죠` },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: {
              command: `GH_TOKEN=${FAKE_SECRETS.tokenValue} gh api user`,
              description: `${FAKE_HOME}/dev/proj 에서 실행`,
              password: FAKE_SECRETS.keyOnlyValue,
              headers: { Authorization: FAKE_SECRETS.keyOnlyValue, accept: 'json' },
            },
          },
        ],
      },
    },
    {
      ...base,
      type: 'user',
      timestamp: at(),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [
              {
                type: 'text',
                text:
                  `aws ${FAKE_SECRETS.aws}\ngho ${FAKE_SECRETS.gho}\npat ${FAKE_SECRETS.githubPat}\n` +
                  `jwt ${FAKE_SECRETS.jwt}\nCLIENT_SECRET=${FAKE_SECRETS.secretValue}\n` +
                  `DB_PASSWORD=${FAKE_SECRETS.passwordValue}\n${pem}\n` +
                  `openai ${FAKE_SECRETS.skProj}\nstripe ${FAKE_SECRETS.skLive}\n` +
                  `google ${FAKE_SECRETS.aiza}\nnpm ${FAKE_SECRETS.npm}\ngitlab ${FAKE_SECRETS.glpat}\n` +
                  `clone https://bob:${FAKE_SECRETS.urlPassword}@example.com/x.git\n` +
                  '<system-reminder>LEAK_REMINDER_IN_RESULT</system-reminder>',
              },
              { type: 'image', source: { type: 'base64', data: 'LEAK_IMAGE_DATA' } },
            ],
          },
        ],
      },
      toolUseResult: { stdout: 'LEAK_TOOL_USE_RESULT raw' },
    },
    {
      ...base,
      type: 'assistant',
      timestamp: at(),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'big.txt' } },
        ],
      },
    },
    {
      ...base,
      type: 'user',
      timestamp: at(),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            content: 'A'.repeat(5000) + TAIL_MARKER,
          },
        ],
      },
    },
    {
      ...base,
      isSidechain: true,
      type: 'user',
      timestamp: at(),
      message: { role: 'user', content: 'LEAK_SIDECHAIN 서브에이전트 프롬프트' },
    },
    {
      ...base,
      isSidechain: true,
      type: 'assistant',
      timestamp: at(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'LEAK_SIDECHAIN2 답' }] },
    },
    {
      ...base,
      type: 'user',
      isMeta: true,
      timestamp: at(),
      message: { role: 'user', content: 'LEAK_META 하네스가 끼운 줄' },
    },
    {
      ...base,
      type: 'system',
      subtype: 'stop_hook_summary',
      timestamp: at(),
      hookInfos: 'LEAK_SYSTEM',
    },
    { type: 'last-prompt', lastPrompt: 'LEAK_LAST_PROMPT', sessionId: base.sessionId },
    { type: 'tools-used', tools: ['LEAK_TOOLS_USED'], sessionId: base.sessionId },
    { type: 'cost-state', totalCostUSD: 1, modelUsage: 'LEAK_COST', sessionId: base.sessionId },
    { type: 'mode', mode: 'LEAK_MODE', sessionId: base.sessionId },
    { type: 'atis-latch', atis: 'LEAK_ATIS', sessionId: base.sessionId },
    { type: 'brand-new-kind', payload: 'LEAK_UNKNOWN_KIND', sessionId: base.sessionId },
    { type: 'another-new-kind', payload: 'LEAK_UNKNOWN_KIND2' },
    { type: 'ai-title', aiTitle: '가짜 세션 제목', sessionId: base.sessionId },
    {
      ...base,
      type: 'assistant',
      timestamp: at(),
      message: {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'LEAK_REDACTED_THINKING' },
          { type: 'text', text: '다 끝났어요.' },
        ],
      },
    },
    {
      ...base,
      type: 'user',
      timestamp: at(),
      message: { role: 'user', content: '고마워요 <system-reminder>LEAK_UNCLOSED_REMINDER' },
    },
  ];
  const out = lines.map((l) => JSON.stringify(l));
  // JSON이 아닌 줄도 모르는 줄로 센다
  out.splice(3, 0, '{not json LEAK_MALFORMED');
  return out;
}

/** 허용 목록 밖에서 뷰어로 나가면 안 되는 줄 수. 테스트가 "모르는 줄" 숫자를 맞춰 본다 */
export const FIXTURE_UNKNOWN_LINES = 3;

export function fixtureText(): string {
  return fixtureLines().join('\n') + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('usage: tsx tests/fixtures/peer/transcript.ts <out.jsonl>\n');
    process.exit(1);
  }
  writeFileSync(target, fixtureText());
  process.stdout.write(`${target}\n`);
}
