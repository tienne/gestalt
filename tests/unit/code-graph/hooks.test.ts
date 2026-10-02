/**
 * Claude Code 훅 — 켜짐 판정, 관련성 게이트, 세션 중복 방지, 데드라인, 기동 경계.
 *
 * 그래프는 진짜 엔진으로 빌드한다. 훅은 store만 읽으므로 엔진을 쓰는 건 테스트 준비뿐이다.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { CodeGraphEngine } from '../../../src/code-graph/engine.js';
import { CodeGraphStore } from '../../../src/code-graph/storage.js';
import {
  runHook,
  pointerKey,
  MAX_POINTERS,
  PROMPT_CONTEXT_MAX_CHARS,
  SESSION_MAP_MAX_CHARS,
} from '../../../src/code-graph/hooks/run.js';
import { isHooksEnabled, HOOKS_ENV } from '../../../src/code-graph/hooks/settings.js';
import { requestRefresh } from '../../../src/code-graph/hooks/background.js';
import { remember, MAX_REMEMBERED } from '../../../src/code-graph/hooks/state.js';
import { splitIdentifier, tokenizePrompt } from '../../../src/code-graph/hooks/rank.js';

const ON = { [HOOKS_ENV]: '1' };

const FILES: Record<string, string> = {
  'src/payment/invoiceCalculator.ts': [
    "import { applyTaxRules } from './taxRules.js';",
    '',
    'export function calculateInvoiceTotal(items: number[]): number {',
    '  const subtotal = items.reduce((a, b) => a + b, 0);',
    '  return applyTaxRules(subtotal);',
    '}',
    '',
    'export class InvoiceCalculator {',
    '  total(items: number[]) {',
    '    return calculateInvoiceTotal(items);',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/payment/taxRules.ts':
    'export function applyTaxRules(amount: number): number {\n  return amount * 1.1;\n}\n',
  'src/user/sessionManager.ts':
    'export function refreshUserSession(token: string): string {\n  return token;\n}\n',
  'src/app.ts': [
    "import { calculateInvoiceTotal } from './payment/invoiceCalculator.js';",
    "import { refreshUserSession } from './user/sessionManager.js';",
    '',
    'export function main() {',
    "  refreshUserSession('t');",
    '  return calculateInvoiceTotal([1, 2]);',
    '}',
    '',
  ].join('\n'),
  'tests/invoice.test.ts':
    "import { calculateInvoiceTotal } from '../src/payment/invoiceCalculator.js';\n\nexport const t = () => calculateInvoiceTotal([1]);\n",
  'docs/billing.md': '# billing\n',
};

const RELEVANT = 'calculateInvoiceTotal에서 tax rules가 안 붙는 것 같아요';
const IRRELEVANT = 'write a haiku about autumn leaves please';

let repoRoot: string;
const engine = new CodeGraphEngine();

function abs(rel: string): string {
  return join(repoRoot, rel);
}

function input(extra: Record<string, unknown>, session = randomUUID()): string {
  return JSON.stringify({ session_id: session, cwd: repoRoot, ...extra });
}

function context(out: string): string {
  const parsed = JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } };
  return parsed.hookSpecificOutput.additionalContext;
}

function makeRepo(tag: string): string {
  const root = resolve('.gestalt-test', `${tag}-${randomUUID()}`);
  for (const [rel, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

beforeAll(() => {
  repoRoot = makeRepo('hooks');
  engine.build(repoRoot, { mode: 'full' });
  const store = new CodeGraphStore(join(repoRoot, '.gestalt', 'code-graph.db'));
  const seed = abs('src/payment/invoiceCalculator.ts');
  const doc = abs('docs/billing.md');
  const [a, b] = seed < doc ? [seed, doc] : [doc, seed];
  store.mergeCoChange({
    pairs: [{ fileA: a!, fileB: b!, count: 6 }],
    solos: [
      { filePath: seed, count: 8 },
      { filePath: doc, count: 7 },
    ],
    meta: {
      headSha: 'a'.repeat(40),
      commitsUsed: 50,
      commitsScanned: 60,
      maxFilesPerCommit: 20,
      defaultMinPairCount: 3,
    },
    reset: true,
  });
  store.close();
  engine.close();
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('켜짐 판정', () => {
  it('설정이 없으면 꺼져 있다', async () => {
    expect(isHooksEnabled(repoRoot, {})).toBe(false);
    expect(await runHook('UserPromptSubmit', input({ prompt: RELEVANT }), { env: {} })).toBe('');
    expect(await runHook('SessionStart', input({}), { env: {} })).toBe('');
  });

  it('gestalt.json의 codeGraph.hooks.enabled로 켜고 환경변수 0이 그걸 끈다', () => {
    const root = resolve('.gestalt-test', `hooks-cfg-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    try {
      writeFileSync(
        join(root, 'gestalt.json'),
        JSON.stringify({ codeGraph: { hooks: { enabled: true } } }),
      );
      expect(isHooksEnabled(root, {})).toBe(true);
      expect(isHooksEnabled(root, { [HOOKS_ENV]: '0' })).toBe(false);
      writeFileSync(join(root, 'gestalt.json'), '{ broken');
      expect(isHooksEnabled(root, {})).toBe(false);
      expect(isHooksEnabled(root, { [HOOKS_ENV]: 'true' })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('그래프 DB가 없으면 출력 없이 끝나고 DB를 만들지 않는다', async () => {
    const root = resolve('.gestalt-test', `hooks-nodb-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    try {
      const raw = JSON.stringify({ session_id: 's', cwd: root, prompt: RELEVANT });
      for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'] as const) {
        expect(await runHook(event, raw, { env: ON })).toBe('');
      }
      expect(existsSync(join(root, '.gestalt'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('입력 JSON이 깨졌거나 cwd가 상대 경로면 출력이 없다', async () => {
    expect(await runHook('UserPromptSubmit', '{not json', { env: ON })).toBe('');
    expect(await runHook('UserPromptSubmit', 'null', { env: ON })).toBe('');
    expect(
      await runHook('UserPromptSubmit', JSON.stringify({ cwd: 'rel', prompt: RELEVANT }), {
        env: ON,
      }),
    ).toBe('');
  });
});

describe('SessionStart', () => {
  it('레포 맵을 상한 안에서 낸다', async () => {
    const out = await runHook('SessionStart', input({ source: 'startup' }), { env: ON });
    const text = context(out);
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(text.length).toBeLessThanOrEqual(SESSION_MAP_MAX_CHARS);
    expect(text).toContain('src/payment/');
    expect(text).toContain('src/payment/invoiceCalculator.ts (2곳에서 import)');
    expect(text).toContain('git 이력 50개 커밋에서');
  });

  it('co-change 쌍이 0개면 이력 안내 줄을 뺀다', async () => {
    const root = makeRepo('hooks-nocochange');
    const local = new CodeGraphEngine();
    try {
      local.build(root, { mode: 'full' });
      const store = new CodeGraphStore(join(root, '.gestalt', 'code-graph.db'));
      store.mergeCoChange({
        pairs: [],
        solos: [],
        meta: {
          headSha: 'b'.repeat(40),
          commitsUsed: 0,
          commitsScanned: 3,
          maxFilesPerCommit: 20,
          defaultMinPairCount: 3,
        },
        reset: true,
      });
      store.close();
      const raw = JSON.stringify({ session_id: 's', cwd: root, source: 'startup' });
      const text = context(await runHook('SessionStart', raw, { env: ON }));
      expect(text).not.toContain('git 이력');
    } finally {
      local.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('UserPromptSubmit', () => {
  it('12자 미만 프롬프트는 건너뛴다', async () => {
    expect(await runHook('UserPromptSubmit', input({ prompt: 'fix invoice' }), { env: ON })).toBe(
      '',
    );
  });

  it('관련 프롬프트에는 코드 본문 없이 포인터를 3개 이하로 넣는다', async () => {
    const out = await runHook('UserPromptSubmit', input({ prompt: RELEVANT }), { env: ON });
    const text = context(out);
    const pointers = text.split('\n').filter((l) => l.startsWith('- '));
    expect(pointers.length).toBeGreaterThan(0);
    expect(pointers.length).toBeLessThanOrEqual(MAX_POINTERS);
    expect(text.length).toBeLessThanOrEqual(PROMPT_CONTEXT_MAX_CHARS);
    expect(pointers[0]).toMatch(
      /^- src\/payment\/invoiceCalculator\.ts:3 — 함수 calculateInvoiceTotal/,
    );
    expect(text).toContain('src/payment/taxRules.ts:1');
    for (const body of ['return', 'reduce', '=>', '{']) expect(text).not.toContain(body);
  });

  it('무관한 프롬프트는 게이트에서 걸러진다', async () => {
    expect(await runHook('UserPromptSubmit', input({ prompt: IRRELEVANT }), { env: ON })).toBe('');
    // 토큰 하나만 맞으면 점수가 높아도 넣지 않는다
    expect(
      await runHook('UserPromptSubmit', input({ prompt: '오늘 회의록 정리해주세요 tax 관련' }), {
        env: ON,
      }),
    ).toBe('');
  });

  it('같은 세션에 같은 프롬프트를 다시 보내면 두 번째는 출력이 없다', async () => {
    const session = randomUUID();
    expect(
      await runHook('UserPromptSubmit', input({ prompt: RELEVANT }, session), { env: ON }),
    ).not.toBe('');
    expect(
      await runHook('UserPromptSubmit', input({ prompt: RELEVANT }, session), { env: ON }),
    ).toBe('');
    // 다른 세션은 따로 센다
    expect(await runHook('UserPromptSubmit', input({ prompt: RELEVANT }), { env: ON })).not.toBe(
      '',
    );
  });

  it('중복 판정은 줄 범위가 아니라 파일과 심볼 이름으로 한다', async () => {
    const root = makeRepo('hooks-shift');
    const local = new CodeGraphEngine();
    try {
      local.build(root, { mode: 'full' });
      const session = randomUUID();
      const raw = JSON.stringify({ session_id: session, cwd: root, prompt: RELEVANT });
      const first = context(await runHook('UserPromptSubmit', raw, { env: ON }));
      expect(first).toContain('invoiceCalculator.ts:3');

      const file = join(root, 'src/payment/invoiceCalculator.ts');
      writeFileSync(file, `// header\n// header\n${FILES['src/payment/invoiceCalculator.ts']}`);
      local.build(root, { mode: 'full' });
      expect(await runHook('UserPromptSubmit', raw, { env: ON })).toBe('');
    } finally {
      local.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('기억하는 포인터는 최근 40개까지다', () => {
    let list: string[] = [];
    for (let i = 0; i < 50; i++) list = remember(list, [pointerKey(`f${i}.ts`, 'x')]);
    expect(list).toHaveLength(MAX_REMEMBERED);
    expect(list[0]).toBe('f10.ts#x');
  });
});

describe('PostToolUse', () => {
  const edit = (session = randomUUID()) =>
    input(
      { tool_name: 'Edit', tool_input: { file_path: abs('src/payment/invoiceCalculator.ts') } },
      session,
    );

  it('고친 파일의 영향 범위와 co-change를 함께 넣는다', async () => {
    const text = context(await runHook('PostToolUse', edit(), { env: ON }));
    expect(text).toContain('src/payment/invoiceCalculator.ts를 고쳤어요');
    expect(text).toMatch(/참조하는 곳 2개 \(테스트 1개\): src\/app\.ts, tests\/invoice\.test\.ts/);
    expect(text).toContain('docs/billing.md (6회)');
  });

  it('같은 세션에서 같은 파일을 다시 고치면 다시 넣지 않는다', async () => {
    const session = randomUUID();
    expect(await runHook('PostToolUse', edit(session), { env: ON })).not.toBe('');
    expect(await runHook('PostToolUse', edit(session), { env: ON })).toBe('');
  });

  it('레포 밖 파일이나 file_path 없는 입력은 무시한다', async () => {
    const outside = input({ tool_name: 'Write', tool_input: { file_path: '/etc/hosts' } });
    expect(await runHook('PostToolUse', outside, { env: ON })).toBe('');
    expect(
      await runHook('PostToolUse', input({ tool_name: 'Edit', tool_input: {} }), { env: ON }),
    ).toBe('');
  });
});

describe('데드라인과 백그라운드 갱신', () => {
  it('데드라인을 넘기면 조용히 끝난다', async () => {
    expect(
      await runHook('UserPromptSubmit', input({ prompt: RELEVANT }), { env: ON, deadlineMs: 0 }),
    ).toBe('');
    let t = 0;
    // 질의 도중 시간이 크게 흐른 것처럼 만든다
    const now = () => (t += 400);
    expect(
      await runHook(
        'PostToolUse',
        input({ tool_name: 'Edit', tool_input: { file_path: abs('src/app.ts') } }),
        { env: ON, now },
      ),
    ).toBe('');
  });

  it('Stop은 출력 없이 갱신만 요청한다', async () => {
    const spawn = vi.fn();
    rmSync(join(repoRoot, '.gestalt', 'hooks', 'refresh.stamp'), { force: true });
    expect(await runHook('Stop', input({}), { env: ON, spawnRefresh: spawn })).toBe('');
    expect(spawn).toHaveBeenCalledWith(repoRoot);
  });

  it('간격 안의 재요청과 락이 잡힌 동안에는 다시 띄우지 않는다', () => {
    const root = resolve('.gestalt-test', `hooks-refresh-${randomUUID()}`);
    mkdirSync(join(root, '.gestalt'), { recursive: true });
    const spawn = vi.fn();
    try {
      const t0 = Date.now();
      expect(requestRefresh(root, spawn, 5000, t0)).toBe(true);
      expect(requestRefresh(root, spawn, 5000, t0 + 1000)).toBe(false);
      expect(requestRefresh(root, spawn, 5000, t0 + 6000)).toBe(true);

      const lock = join(root, '.gestalt', 'code-graph.lock');
      writeFileSync(lock, '{}');
      expect(requestRefresh(root, spawn, 5000, t0 + 20_000)).toBe(false);
      // 주인이 오래전에 죽어 남은 락은 막지 않는다
      const old = t0 / 1000 - 3600;
      utimesSync(lock, old, old);
      expect(requestRefresh(root, spawn, 5000, t0 + 20_000)).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('어휘 토큰', () => {
  it('식별자를 조각으로 쪼갠다', () => {
    expect(splitIdentifier('calculateInvoiceTotal')).toEqual(['calculate', 'invoice', 'total']);
    expect(splitIdentifier('HTTPServer_config-path')).toEqual(['http', 'server', 'config', 'path']);
  });

  it('불용어와 짧은 조각은 빼고 한글은 무시한다', () => {
    const t = tokenizePrompt('please fix the BlastRadius 계산 in src/code-graph');
    expect(t.parts).toEqual(['blast', 'radiu', 'src', 'graph']);
    expect(t.wholeNames.has('blastradius')).toBe(true);
  });

  it('에이전트 도구 이름은 대상으로 치지 않는다', () => {
    expect(tokenizePrompt('Edit 도구로 Bash 말고 Read 써서 고쳐줘').parts).toEqual([]);
  });
});

describe('기동 경계', () => {
  /**
   * 훅 모듈이 정적으로 끌어오는 파일을 따라가며 금지된 모듈이 없는지 본다.
   * 엔진은 typescript 파서를, MCP와 LLM 쪽은 SDK를 끌고 와서 기동이 수백 ms 늘어난다.
   */
  it('훅 모듈은 엔진, MCP, LLM, 임베딩을 import하지 않는다', () => {
    const forbidden = [
      /code-graph\/engine\.ts$/,
      /\/mcp\//,
      /\/llm\//,
      /providers\//,
      /embedding/,
      /plugins\//,
    ];
    const forbiddenPkgs = [
      'typescript',
      '@xenova/transformers',
      '@anthropic-ai/sdk',
      '@modelcontextprotocol/sdk',
      'zod',
      'dotenv',
    ];
    const seen = new Set<string>();
    const pkgs = new Set<string>();
    const queue = ['run.ts', 'background.ts', 'settings.ts'].map((f) =>
      resolve('src/code-graph/hooks', f),
    );
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = readFileSync(file, 'utf-8');
      for (const m of src.matchAll(/^import\s+(?:type\s)?[^'"]*?from\s+'([^']+)'/gm)) {
        if (/^import\s+type\s/.test(m[0])) continue;
        const spec = m[1]!;
        if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
        else if (!spec.startsWith('node:')) pkgs.add(spec);
      }
    }
    for (const f of seen) for (const re of forbidden) expect(f).not.toMatch(re);
    for (const p of forbiddenPkgs) expect([...pkgs]).not.toContain(p);
  });
});

describe('bin 엔트리', () => {
  const run = (args: string[], stdin: string | null, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'bin/gestalt-hook.ts', ...args], {
      input: stdin ?? undefined,
      env: { ...process.env, ...env },
      timeout: 15_000,
      encoding: 'utf-8',
      stdio: stdin === null ? ['pipe', 'pipe', 'pipe'] : undefined,
    });

  it('깨진 입력과 모르는 이벤트에도 exit 0으로 끝난다', () => {
    for (const [args, stdin] of [
      [['user-prompt-submit'], '{oops'],
      [['no-such-event'], '{}'],
      [[], ''],
    ] as const) {
      const r = run([...args], stdin, ON);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
  });

  it('관련 프롬프트면 훅 JSON을 stdout에 낸다', () => {
    const r = run(['user-prompt-submit'], input({ prompt: RELEVANT }), {
      ...ON,
      CLAUDE_PROJECT_DIR: repoRoot,
    });
    expect(r.status).toBe(0);
    expect(context(r.stdout)).toContain('calculateInvoiceTotal');
  });
});
