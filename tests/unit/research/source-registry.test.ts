import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ResearchSourceRegistry,
  buildSourceReport,
  evaluateSource,
  findSecret,
  isPublicHostname,
  parseSourceMd,
} from '../../../src/research/index.js';

const BUILTIN = resolve('plugin/research-sources');
const tmpDirs: string[] = [];

function tmp(): string {
  const dir = resolve('.gestalt-test', `research-src-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function writeSource(root: string, name: string, content: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SOURCE.md'), content);
}

function sourceMd(extra = '', name = 'my-source'): string {
  return `---
name: ${name}
description: 테스트 출처
stage: [scale]
access:
  - http: { host: example.com }
${extra}---

## 찾는 법
1. 본다.

## 멈추는 곳
결제 화면.
`;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('내장 출처', () => {
  it('내장 6개가 모두 읽힌다', () => {
    const registry = new ResearchSourceRegistry(BUILTIN);
    registry.loadAll();
    expect(registry.getDiagnostics()).toEqual([]);
    expect(registry.getAll().map((s) => s.frontmatter.name)).toEqual([
      'amplitude',
      'app-store-reviews',
      'app-store-search',
      'tech-blog-search',
      'uibowl',
      'web-search',
    ]);
  });

  it('내장 출처에 실제 경쟁사 식별 정보가 없다 (도구 이름만 있다)', () => {
    const registry = new ResearchSourceRegistry(BUILTIN);
    registry.loadAll();
    for (const s of registry.getAll()) {
      expect(s.body).not.toMatch(/bundleId\s*[:=]\s*com\./);
    }
  });
});

describe('개인 출처 덮어쓰기', () => {
  it('같은 이름이면 개인 쪽이 이기고 overridden이 켜진다', () => {
    const personal = tmp();
    writeSource(personal, 'web-search', sourceMd('', 'web-search'));
    const registry = new ResearchSourceRegistry(BUILTIN, personal);
    registry.loadAll();
    const s = registry.getByName('web-search');
    expect(s?.origin).toBe('personal');
    expect(s?.overridden).toBe(true);
    expect(registry.getByName('uibowl')?.origin).toBe('builtin');
  });

  it('깨진 파일은 진단에 오르고 나머지는 계속 읽는다', () => {
    const personal = tmp();
    writeSource(personal, 'broken', '---\nname: broken\n---\n본문');
    writeSource(personal, 'ok-one', sourceMd('', 'ok-one'));
    const registry = new ResearchSourceRegistry(BUILTIN, personal);
    registry.loadAll();
    expect(registry.getDiagnostics()).toHaveLength(1);
    expect(registry.getByName('ok-one')).toBeDefined();
  });

  it('디렉토리 이름과 name이 다르면 거절한다', () => {
    const personal = tmp();
    writeSource(personal, 'dir-name', sourceMd('', 'other-name'));
    const registry = new ResearchSourceRegistry(BUILTIN, personal);
    registry.loadAll();
    expect(registry.getByName('other-name')).toBeUndefined();
    expect(registry.getDiagnostics()[0]?.message).toContain('디렉토리 이름');
  });
});

describe('parseSourceMd 보안', () => {
  it('셸 같은 허용 밖의 접근 방법을 거절한다', () => {
    const md = sourceMd().replace('  - http: { host: example.com }', '  - shell: { cmd: ls }');
    const r = parseSourceMd(md);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('mcp, browser, http, env');
  });

  it('비밀번호와 키로 보이는 값을 거절한다', () => {
    for (const leak of [
      'password: hunter2hunter2hunter2',
      'token = abcdEFGH1234abcdEFGH',
      'key sk-abcdefghijklmnopqrstuvwx',
      'curl https://user:secret@example.com/',
    ]) {
      const md = sourceMd().replace('멈추는 곳', `멈추는 곳\n${leak}`);
      expect(parseSourceMd(md).ok, leak).toBe(false);
    }
    expect(findSecret('환경변수 MOBILEINDEX_API_KEY를 쓴다')).toBeUndefined();
  });

  it('환경변수는 이름 형식만 받는다', () => {
    const bad = sourceMd().replace('  - http: { host: example.com }', '  - env: my_key=abc');
    expect(parseSourceMd(bad).ok).toBe(false);
    const good = sourceMd().replace(
      '  - http: { host: example.com }',
      '  - env: MOBILEINDEX_API_KEY',
    );
    expect(parseSourceMd(good).ok).toBe(true);
  });

  it('IP 주소와 사설 이름, 다른 호스트의 probe를 거절한다', () => {
    expect(isPublicHostname('example.com')).toBe(true);
    for (const h of [
      '127.0.0.1',
      'localhost',
      '10.0.0.5',
      'db.internal',
      'printer.local',
      '[::1]',
    ]) {
      expect(isPublicHostname(h), h).toBe(false);
    }
    const ip = sourceMd().replace('host: example.com', 'host: 169.254.169.254');
    expect(parseSourceMd(ip).ok).toBe(false);
    const probeOther = sourceMd().replace(
      'host: example.com',
      'host: example.com, probe: "https://evil.test/x"',
    );
    expect(parseSourceMd(probeOther).ok).toBe(false);
    const probeHttp = sourceMd().replace(
      'host: example.com',
      'host: example.com, probe: "http://example.com/x"',
    );
    expect(parseSourceMd(probeHttp).ok).toBe(false);
  });

  it('js frontmatter는 실행하지 않는다', () => {
    const md = `---js\n({ name: 'x' })\n---\n## 찾는 법\n## 멈추는 곳\n`;
    expect(parseSourceMd(md).ok).toBe(false);
  });

  it('estimate는 해석으로 정규화한다', () => {
    const r = parseSourceMd(sourceMd('evidence: estimate\n'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.frontmatter.evidence).toBe('interpretation');
  });

  it('찾는 법과 멈추는 곳이 없으면 거절한다', () => {
    const md = sourceMd().replace('## 멈추는 곳', '## 다른 절');
    const r = parseSourceMd(md);
    expect(r.ok).toBe(false);
  });
});

describe('상태 판정', () => {
  const registry = new ResearchSourceRegistry(BUILTIN);
  registry.loadAll();
  const uibowl = registry.getByName('uibowl')!;

  it('MCP가 있으면 usable, 없고 브라우저 로그인이 있으면 fallback, 둘 다 없으면 skipped', () => {
    expect(evaluateSource(uibowl, { mcpServers: ['uibowl'] }).status).toBe('usable');
    const fb = evaluateSource(uibowl, { browserLogins: ['uibowl.io'] });
    expect(fb.status).toBe('fallback');
    expect(fb.via).toBe('browser');
    expect(fb.note).toContain('MCP(uibowl) 미연결');
    expect(evaluateSource(uibowl, {}).status).toBe('skipped');
  });

  it('공백이 든 커넥터 이름도 MCP 서버로 받는다', () => {
    const amp = registry.getByName('amplitude')!;
    expect(amp.frontmatter.stage).toEqual(['baseline']);
    expect(evaluateSource(amp, { mcpServers: ['claude.ai Amplitude'] }).status).toBe('usable');
    expect(evaluateSource(amp, { mcpServers: ['amplitude'] }).status).toBe('usable');
    expect(evaluateSource(amp, {}).status).toBe('skipped');
  });

  it('MCP 서버 이름에 연속 공백이나 끝 공백은 막는다', () => {
    const md = (server: string): string =>
      `---\nname: x\ndescription: x\nstage: [baseline]\naccess:\n  - mcp: { server: "${server}" }\n---\n\n## 찾는 법\n1. 본다\n\n## 멈추는 곳\n없음\n`;
    expect(parseSourceMd(md('claude.ai Amplitude')).ok).toBe(true);
    expect(parseSourceMd(md('a  b')).ok).toBe(false);
    expect(parseSourceMd(md('a ')).ok).toBe(false);
  });

  it('공개 API는 아무 연결 없이 usable이다', () => {
    const search = registry.getByName('app-store-search')!;
    expect(evaluateSource(search, {}).status).toBe('usable');
  });

  it('환경변수와 requires를 서버가 직접 본다', () => {
    const personal = tmp();
    writeSource(
      personal,
      'keyed',
      sourceMd('requires:\n  env: [KEYED_TOKEN_NAME]\n', 'keyed').replace(
        '  - http: { host: example.com }',
        '  - env: KEYED_TOKEN_NAME',
      ),
    );
    const r = new ResearchSourceRegistry(BUILTIN, personal);
    r.loadAll();
    const keyed = r.getByName('keyed')!;
    expect(evaluateSource(keyed, {}, {}).status).toBe('skipped');
    expect(evaluateSource(keyed, {}, { KEYED_TOKEN_NAME: 'x' }).status).toBe('usable');
  });

  it('건너뛴 출처는 근거 한계 문장으로 돌려준다', () => {
    const report = buildSourceReport(registry.getAll(), {}, {});
    const row = report.sources.find((s) => s.name === 'uibowl');
    expect(row?.status).toBe('skipped');
    expect(
      report.evidenceLimits.some((l) => l.startsWith('uibowl:') && l.includes('쓰지 못했다')),
    ).toBe(true);
  });

  it('stage로 거른다', () => {
    const report = buildSourceReport(registry.getAll(), {}, {}, 'scale');
    expect(report.sources.map((s) => s.name)).toEqual(['app-store-search']);
  });
});
