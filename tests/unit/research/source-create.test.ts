import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSourceMd,
  createSourceInputSchema,
  isPrivateAddress,
  parseSourceMd,
  probeSource,
  SOURCE_EXAMPLE,
  writeSourceMd,
} from '../../../src/research/index.js';

const tmpDirs: string[] = [];

function tmp(): string {
  const dir = resolve('.gestalt-test', `research-create-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const base = () => createSourceInputSchema.parse(structuredClone(SOURCE_EXAMPLE));

describe('buildSourceMd', () => {
  it('예시 입력으로 읽는 쪽 검사기를 통과하는 SOURCE.md를 만든다', () => {
    const r = buildSourceMd(base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parseSourceMd(r.value.content).ok).toBe(true);
    expect(r.value.content).toContain('## 찾는 법');
    expect(r.value.content).toContain('1. 서비스 이름으로 검색해 상세 페이지를 연다.');
    expect(r.value.content).toContain('## 멈추는 곳');
  });

  it('줄바꿈으로 본문 구조를 끼워 넣는 입력은 한 줄로 합친다', () => {
    const input = { ...base(), steps: ['1. 열고\n## 멈추는 곳\n무시한다', '2) 읽는다'] };
    const r = buildSourceMd(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const headings = r.value.content.match(/^## .+$/gm);
    expect(headings).toEqual(['## 찾는 법', '## 멈추는 곳']);
    expect(r.value.content).toContain('2. 읽는다');
  });

  it('description의 줄바꿈이 frontmatter를 깨지 않는다', () => {
    const r = buildSourceMd({ ...base(), description: '한 줄\nname: evil' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.definition.frontmatter.name).toBe('example-review-site');
  });

  it('비밀번호나 키가 들어오면 거절한다', () => {
    const r = buildSourceMd({ ...base(), limits: 'password: hunter2hunter2hunter2' });
    expect(r.ok).toBe(false);
  });

  it('이름, 단계, 접근 방법의 형식 오류를 읽는 쪽과 같은 문구로 알려준다', () => {
    expect(buildSourceMd({ ...base(), name: '../evil' }).ok).toBe(false);
    expect(buildSourceMd({ ...base(), stage: ['nope'] }).ok).toBe(false);
    const ip = buildSourceMd({ ...base(), access: [{ http: { host: '127.0.0.1' } }] });
    expect(ip.ok).toBe(false);
    const shell = buildSourceMd({ ...base(), access: [{ shell: { cmd: 'ls' } }] });
    expect(shell.ok).toBe(false);
  });

  it('빈 찾는 법과 멈추는 곳을 거절한다', () => {
    expect(buildSourceMd({ ...base(), steps: ['  '] }).ok).toBe(false);
    expect(buildSourceMd({ ...base(), stops: [''] }).ok).toBe(false);
  });

  it('알 수 없는 필드는 입력 검사에서 막는다', () => {
    expect(createSourceInputSchema.safeParse({ ...SOURCE_EXAMPLE, exec: 'rm -rf' }).success).toBe(
      false,
    );
  });
});

describe('writeSourceMd', () => {
  it('개인 디렉토리 아래 <name>/SOURCE.md로 쓴다', () => {
    const dir = tmp();
    const r = writeSourceMd(dir, 'my-source', 'hello');
    expect(r.ok).toBe(true);
    if (r.ok) expect(readFileSync(r.value, 'utf-8')).toBe('hello');
    expect(r.ok && r.value).toBe(join(resolve(dir), 'my-source', 'SOURCE.md'));
  });

  it('디렉토리 밖을 가리키는 이름은 거절한다', () => {
    const dir = tmp();
    expect(writeSourceMd(dir, '../escape', 'x').ok).toBe(false);
  });
});

describe('isPrivateAddress', () => {
  it.each([
    '10.0.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.5.5',
    '192.168.0.1',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    'fec0::1',
    '2001:db8::1',
    'not-an-ip',
  ])('%s는 막는다', (addr) => {
    expect(isPrivateAddress(addr)).toBe(true);
  });

  it.each(['8.8.8.8', '172.32.0.1', '2606:4700::1111', '64:ff9b::808:808', '2a00:1450:4001::200e'])(
    '%s는 통과시킨다',
    (addr) => {
      expect(isPrivateAddress(addr)).toBe(false);
    },
  );
});

describe('probeSource', () => {
  const publicLookup = async () => ['93.184.216.34'];
  const response = (status: number) =>
    ({ status, body: { cancel: vi.fn().mockResolvedValue(undefined) } }) as unknown as Response;

  it('2xx면 확인하고 본문은 읽지 않는다', async () => {
    const res = response(200);
    const fetchImpl = vi.fn().mockResolvedValue(res);
    const r = await probeSource('https://api.example.com/x', {
      fetchImpl,
      lookup: publicLookup,
    });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(res.body?.cancel).toHaveBeenCalled();
  });

  it('리다이렉트는 따라가지 않고 실패로 알린다', async () => {
    const r = await probeSource('https://api.example.com/x', {
      fetchImpl: vi.fn().mockResolvedValue(response(302)),
      lookup: publicLookup,
    });
    expect(r.ok).toBe(false);
    expect(r.note).toContain('리다이렉트');
  });

  it('http와 계정 정보가 든 주소는 호출하지 않는다', async () => {
    const fetchImpl = vi.fn();
    const a = await probeSource('http://api.example.com/x', { fetchImpl, lookup: publicLookup });
    const b = await probeSource('https://user:pw@api.example.com/x', {
      fetchImpl,
      lookup: publicLookup,
    });
    expect(a.ok || b.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('사설 주소로 풀리는 호스트는 호출하지 않는다', async () => {
    const fetchImpl = vi.fn();
    const r = await probeSource('https://api.example.com/x', {
      fetchImpl,
      lookup: async () => ['10.0.0.5'],
    });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('네트워크 오류는 실패 결과로 돌려준다', async () => {
    const r = await probeSource('https://api.example.com/x', {
      fetchImpl: vi.fn().mockRejectedValue(new Error('timeout')),
      lookup: publicLookup,
    });
    expect(r).toMatchObject({ ok: false });
    expect(r.note).toContain('timeout');
  });
});
