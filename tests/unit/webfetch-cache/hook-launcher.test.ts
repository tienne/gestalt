/**
 * scripts/webfetch-cache-hook.sh — 켜고 끄기, 저장 조건, 304일 때만 적중하는 규칙.
 *
 * 가짜 원본 서버가 같은 프로세스에서 돌아서 spawnSync를 쓰면 이벤트 루프가 막혀 응답을 못 한다.
 * 그래서 훅은 비동기 spawn으로 부른다.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { delimiter, join, resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const SCRIPT = resolve('scripts/webfetch-cache-hook.sh');

function hasTool(name: string): boolean {
  return (process.env['PATH'] ?? '').split(delimiter).some((dir) => existsSync(join(dir, name)));
}
// 훅이 의존하는 도구가 없는 머신에서는 저장과 적중을 확인할 수 없다
const HAS_DEPS = hasTool('jq') && hasTool('curl') && (hasTool('sha256sum') || hasTool('shasum'));

interface Seen {
  method: string;
  headers: IncomingHttpHeaders;
}

interface Origin {
  server: Server;
  base: string;
  seen: Seen[];
  etag: string | undefined;
  lastModified: string | undefined;
}

let root: string;
let project: string;
let origin: Origin;

async function startOrigin(): Promise<Origin> {
  const o: Origin = {
    server: createServer(),
    base: '',
    seen: [],
    etag: '"v1"',
    lastModified: undefined,
  };
  o.server.on('request', (req, res) => {
    o.seen.push({ method: req.method ?? '', headers: req.headers });
    const matchesEtag = o.etag !== undefined && req.headers['if-none-match'] === o.etag;
    const matchesDate =
      o.lastModified !== undefined && req.headers['if-modified-since'] === o.lastModified;
    if (matchesEtag || matchesDate) {
      res.writeHead(304);
      res.end();
      return;
    }
    const headers: Record<string, string> = {};
    if (o.etag !== undefined) headers['ETag'] = o.etag;
    if (o.lastModified !== undefined) headers['Last-Modified'] = o.lastModified;
    res.writeHead(200, headers);
    res.end('body');
  });
  await new Promise<void>((done) => o.server.listen(0, '127.0.0.1', done));
  o.base = `http://127.0.0.1:${(o.server.address() as AddressInfo).port}`;
  return o;
}

function hook(
  mode: 'pre' | 'post',
  payload: unknown,
  env: Record<string, string> = {},
  pathOverride?: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(SCRIPT, [mode], {
      env: {
        PATH: pathOverride ?? process.env['PATH'] ?? '',
        HOME: root,
        CLAUDE_PROJECT_DIR: project,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', fail);
    child.on('close', (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

const ON = { GESTALT_WEBFETCH_CACHE: '1' };

function post(url: string, prompt: string, response: unknown, env: Record<string, string> = ON) {
  return hook(
    'post',
    { tool_name: 'WebFetch', tool_input: { url, prompt }, tool_response: response },
    env,
  );
}

function pre(url: string, prompt: string, env: Record<string, string> = ON) {
  return hook('pre', { tool_name: 'WebFetch', tool_input: { url, prompt } }, env);
}

const cacheDir = () => join(project, '.gestalt', 'webfetch-cache');
const cacheFiles = () => (existsSync(cacheDir()) ? readdirSync(cacheDir()) : []);

beforeEach(async () => {
  root = resolve('.gestalt-test', `webfetch-cache-${randomUUID()}`);
  project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  origin = await startOrigin();
});

afterEach(async () => {
  await new Promise<void>((done) => origin.server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

describe('webfetch-cache-hook.sh — 켜고 끄기', () => {
  it('기본은 꺼짐이라 원본 요청도 파일도 없이 exit 0', async () => {
    const url = `${origin.base}/doc`;
    const r = await post(url, 'q', { result: 'summary' }, {});
    expect(r.status).toBe(0);
    expect(origin.seen).toHaveLength(0);
    expect(cacheFiles()).toEqual([]);

    const p = await pre(url, 'q', {});
    expect(p.status).toBe(0);
    expect(origin.seen).toHaveLength(0);
  });

  it('gestalt.json에 enabled:false면 꺼짐', async () => {
    writeFileSync(join(project, 'gestalt.json'), '{"webFetchCache":{"enabled":false}}');
    await post(`${origin.base}/doc`, 'q', { result: 'summary' }, {});
    expect(origin.seen).toHaveLength(0);
    expect(cacheFiles()).toEqual([]);
  });

  it('gestalt.json의 enabled:true로 켠다', async () => {
    writeFileSync(join(project, 'gestalt.json'), '{"webFetchCache":{"enabled":true}}');
    await post(`${origin.base}/doc`, 'q', { result: 'summary' }, {});
    expect(cacheFiles()).toHaveLength(1);
  });

  it('GESTALT_WEBFETCH_CACHE=0은 gestalt.json의 enabled:true보다 우선한다', async () => {
    writeFileSync(join(project, 'gestalt.json'), '{"webFetchCache":{"enabled":true}}');
    const r = await post(
      `${origin.base}/doc`,
      'q',
      { result: 'summary' },
      { GESTALT_WEBFETCH_CACHE: '0' },
    );
    expect(r.status).toBe(0);
    expect(origin.seen).toHaveLength(0);
    expect(cacheFiles()).toEqual([]);
  });

  it('env 값은 대소문자와 공백을 가리지 않는다', async () => {
    await post(
      `${origin.base}/doc`,
      'q',
      { result: 'summary' },
      { GESTALT_WEBFETCH_CACHE: ' TRUE ' },
    );
    expect(cacheFiles()).toHaveLength(1);
  });
});

describe.skipIf(!HAS_DEPS)('webfetch-cache-hook.sh — 저장과 적중', () => {
  it('post로 저장한 뒤 같은 요청에 원본이 304를 주면 exit 2와 stderr로 본문을 돌려준다', async () => {
    const url = `${origin.base}/doc`;
    const body = 'line1\n`code` $HOME \\n backslash\n한글 본문';
    expect((await post(url, 'q', { result: body })).status).toBe(0);
    expect(cacheFiles()).toHaveLength(1);

    origin.seen.length = 0;
    const r = await pre(url, 'q');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('[gestalt webfetch-cache] 캐시 적중');
    expect(r.stderr).toContain(url);
    expect(r.stderr).toContain(body);
    expect(origin.seen).toHaveLength(1);
    expect(origin.seen[0]!.method).toBe('HEAD');
    expect(origin.seen[0]!.headers['if-none-match']).toBe('"v1"');
  });

  it('Last-Modified만 있어도 If-Modified-Since로 확인한다', async () => {
    origin.etag = undefined;
    origin.lastModified = 'Wed, 21 Oct 2026 07:28:00 GMT';
    const url = `${origin.base}/doc`;
    await post(url, 'q', { result: 'summary' });
    origin.seen.length = 0;
    const r = await pre(url, 'q');
    expect(r.status).toBe(2);
    expect(origin.seen[0]!.headers['if-modified-since']).toBe(origin.lastModified);
    expect(origin.seen[0]!.headers['if-none-match']).toBeUndefined();
  });

  it('원본이 바뀌어 200을 주면 통과한다', async () => {
    const url = `${origin.base}/doc`;
    await post(url, 'q', { result: 'summary' });
    origin.etag = '"v2"';
    const r = await pre(url, 'q');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('원본에 닿지 않으면 통과한다', async () => {
    const url = `${origin.base}/doc`;
    await post(url, 'q', { result: 'summary' });
    await new Promise<void>((done) => origin.server.close(() => done()));
    const r = await pre(url, 'q');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    // afterEach가 닫은 서버를 다시 닫지 않게 새로 띄운다
    origin = await startOrigin();
  });

  it('검증 헤더가 없으면 저장하지 않고 옛 항목도 지운다', async () => {
    const url = `${origin.base}/doc`;
    await post(url, 'q', { result: 'summary' });
    expect(cacheFiles()).toHaveLength(1);

    origin.etag = undefined;
    origin.lastModified = undefined;
    await post(url, 'q', { result: 'summary' });
    expect(cacheFiles()).toEqual([]);
  });

  it('같은 URL이라도 prompt가 다르면 적중하지 않는다', async () => {
    const url = `${origin.base}/doc`;
    await post(url, '요약해줘', { result: 'summary' });
    origin.seen.length = 0;
    const r = await pre(url, '표로 정리해줘');
    expect(r.status).toBe(0);
    expect(origin.seen).toHaveLength(0);
    // 두 prompt는 서로 다른 항목이다
    await post(url, '표로 정리해줘', { result: 'table' });
    expect(cacheFiles()).toHaveLength(2);
  });

  it('tool_response가 문자열이어도 저장한다', async () => {
    const url = `${origin.base}/doc`;
    await post(url, 'q', 'plain string body');
    const r = await pre(url, 'q');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('plain string body');
  });

  it('본문을 못 꺼내는 tool_response는 저장하지 않는다', async () => {
    await post(`${origin.base}/doc`, 'q', { unknown: 1 });
    await post(`${origin.base}/doc`, 'q', 42);
    await post(`${origin.base}/doc`, 'q', { result: '' });
    expect(cacheFiles()).toEqual([]);
  });

  it('본문이 100만 자를 넘으면 저장하지 않는다', async () => {
    await post(`${origin.base}/doc`, 'q', { result: 'x'.repeat(1_000_001) });
    expect(cacheFiles()).toEqual([]);
  });

  it('캐시 파일은 본인만 읽는다', async () => {
    await post(`${origin.base}/doc`, 'q', { result: 'summary' });
    const file = join(cacheDir(), cacheFiles()[0]!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(cacheDir()).mode & 0o777).toBe(0o700);
    const saved = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    expect(saved).toMatchObject({ url: `${origin.base}/doc`, prompt: 'q', etag: '"v1"' });
    expect(saved['content']).toBe('summary');
  });

  it('원본에는 쿠키와 인증 헤더를 싣지 않는다', async () => {
    const url = `${origin.base}/doc`;
    await post(url, 'q', { result: 'summary' });
    await pre(url, 'q');
    expect(origin.seen.length).toBeGreaterThan(0);
    for (const s of origin.seen) {
      expect(s.headers['cookie']).toBeUndefined();
      expect(s.headers['authorization']).toBeUndefined();
    }
  });
});

describe.skipIf(!HAS_DEPS)('webfetch-cache-hook.sh — 다루지 않는 입력', () => {
  it.each([
    ['file 스킴', 'file:///etc/hosts'],
    ['ftp 스킴', 'ftp://127.0.0.1/doc'],
    ['사용자 정보가 든 URL', 'http://user:pass@127.0.0.1:9/doc'],
    ['공백이 든 URL', 'http://127.0.0.1:9/a b'],
    ['빈 URL', ''],
  ])('%s → 요청도 저장도 없이 통과한다', async (_name, url) => {
    const a = await post(url, 'q', { result: 'summary' });
    const b = await pre(url, 'q');
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(origin.seen).toHaveLength(0);
    expect(cacheFiles()).toEqual([]);
  });

  it('깨진 stdin이어도 exit 0', async () => {
    expect((await hook('post', 'not json', ON)).status).toBe(0);
    expect((await hook('pre', '', ON)).status).toBe(0);
  });

  it('알 수 없는 모드는 exit 0', async () => {
    const r = await new Promise<number | null>((done) => {
      const child = spawn(SCRIPT, ['bogus'], { env: { ...process.env, ...ON } });
      child.on('close', done);
      child.stdin.end('{}');
    });
    expect(r).toBe(0);
  });

  it('손상된 캐시 파일은 통과한다', async () => {
    const url = `${origin.base}/doc`;
    await post(url, 'q', { result: 'summary' });
    const file = join(cacheDir(), cacheFiles()[0]!);
    writeFileSync(file, '{ not json');
    origin.seen.length = 0;
    const r = await pre(url, 'q');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(origin.seen).toHaveLength(0);
  });

  it('캐시 파일의 url이 요청과 다르면 통과한다', async () => {
    const url = `${origin.base}/doc`;
    await post(url, 'q', { result: 'summary' });
    const file = join(cacheDir(), cacheFiles()[0]!);
    const saved = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...saved, url: `${origin.base}/other` }));
    origin.seen.length = 0;
    expect((await pre(url, 'q')).status).toBe(0);
    expect(origin.seen).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DEPS)('webfetch-cache-hook.sh — 의존성과 경로', () => {
  /** jq나 curl만 빼고 나머지 도구는 그대로 쓸 수 있는 PATH를 만든다 */
  function pathWithout(...missing: string[]): string {
    const bin = join(root, `bin-${randomUUID()}`);
    mkdirSync(bin, { recursive: true });
    const tools = [
      'bash',
      'env',
      'cat',
      'grep',
      'tr',
      'cut',
      'awk',
      'sed',
      'mkdir',
      'mv',
      'rm',
      'chmod',
      'date',
      'sha256sum',
      'shasum',
      'jq',
      'curl',
    ].filter((t) => !missing.includes(t));
    for (const tool of tools) {
      const dir = (process.env['PATH'] ?? '')
        .split(delimiter)
        .find((d) => existsSync(join(d, tool)));
      if (dir) symlinkSync(join(dir, tool), join(bin, tool));
    }
    return bin;
  }

  it('jq나 curl이 없으면 조용히 통과한다', async () => {
    const payload = {
      tool_input: { url: `${origin.base}/doc`, prompt: 'q' },
      tool_response: { result: 'summary' },
    };
    for (const missing of ['jq', 'curl']) {
      const r = await hook('post', payload, ON, pathWithout(missing));
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    }
    expect(origin.seen).toHaveLength(0);
    expect(cacheFiles()).toEqual([]);

    // 같은 입력이 전체 PATH에서는 저장되므로 위 결과는 의존성 확인 때문이다
    await hook('post', payload, ON);
    expect(cacheFiles()).toHaveLength(1);
  });

  it.skipIf(!hasTool('sha256sum') || !hasTool('shasum'))(
    'sha256sum이 없어도 shasum으로 같은 키를 만든다',
    async () => {
      const url = `${origin.base}/doc`;
      await post(url, 'q', { result: 'summary' });
      const withSumTool = cacheFiles();
      rmSync(cacheDir(), { recursive: true });

      const r = await hook(
        'post',
        { tool_input: { url, prompt: 'q' }, tool_response: { result: 'summary' } },
        ON,
        pathWithout('sha256sum'),
      );
      expect(r.status).toBe(0);
      expect(cacheFiles()).toEqual(withSumTool);
    },
  );

  it('GESTALT_WEBFETCH_CACHE_DIR의 절대 경로를 쓰고 상대 경로는 무시한다', async () => {
    const dir = join(root, 'elsewhere');
    await post(
      `${origin.base}/doc`,
      'q',
      { result: 'summary' },
      { ...ON, GESTALT_WEBFETCH_CACHE_DIR: dir },
    );
    expect(readdirSync(dir)).toHaveLength(1);
    expect(cacheFiles()).toEqual([]);

    await post(
      `${origin.base}/doc`,
      'q',
      { result: 'summary' },
      { ...ON, GESTALT_WEBFETCH_CACHE_DIR: 'relative/dir' },
    );
    expect(cacheFiles()).toHaveLength(1);
    expect(existsSync(join(project, 'relative'))).toBe(false);
  });
});
