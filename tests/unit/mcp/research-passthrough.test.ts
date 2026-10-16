import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { researchInputSchema } from '../../../src/mcp/schemas.js';
import {
  handleResearchPassthrough,
  type ResearchHandlerOptions,
} from '../../../src/mcp/tools/research-passthrough.js';
import type { OcrResult } from '../../../src/research/pii-image.js';

const BUILTIN = resolve('plugin/research-sources');
const tmpDirs: string[] = [];

function tmpHome(): string {
  const dir = resolve('.gestalt-test', `research-mcp-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function run(params: Record<string, unknown>, gestaltHome: string, env = {}) {
  const input = researchInputSchema.parse(params);
  return (await handleResearchPassthrough(input, process.cwd(), {
    builtinDir: BUILTIN,
    gestaltHome,
    env,
  })) as Record<string, any>;
}

describe('ges_research action=sources', () => {
  it('연결 정보를 받아 상태와 근거 한계를 돌려준다', async () => {
    const r = await run(
      { action: 'sources', available: { browserLogins: ['uibowl.io'] } },
      tmpHome(),
    );
    expect(r.ok).toBe(true);
    const uibowl = r.sources.find((s: { name: string }) => s.name === 'uibowl');
    expect(uibowl.status).toBe('fallback');
    expect(r.evidenceLimits.some((l: string) => l.includes('MCP(uibowl) 미연결'))).toBe(true);
  });

  it('개인 디렉토리의 출처를 읽고 같은 이름은 덮어쓴다', async () => {
    const home = tmpHome();
    mkdirSync(join(home, 'research-sources', 'web-search'), { recursive: true });
    writeFileSync(
      join(home, 'research-sources', 'web-search', 'SOURCE.md'),
      `---\nname: web-search\ndescription: 내 검색\nstage: [evidence]\naccess:\n  - http: { host: example.com }\n---\n\n## 찾는 법\n1. 본다\n\n## 멈추는 곳\n결제 화면\n`,
    );
    const r = await run({ action: 'sources' }, home);
    const row = r.sources.find((s: { name: string }) => s.name === 'web-search');
    expect(row.origin).toBe('personal');
    expect(row.overridden).toBe(true);
  });

  it('name을 주면 본문을 함께 돌려주고 없는 이름은 실패한다', async () => {
    const home = tmpHome();
    const ok = await run({ action: 'sources', name: 'app-store-search' }, home);
    expect(ok.detail.body).toContain('## 찾는 법');
    const missing = await run({ action: 'sources', name: 'nope' }, home);
    expect(missing.ok).toBe(false);
    expect(missing.errors[0].code).toBe('SOURCE_NOT_FOUND');
  });
});

async function runWith(
  params: Record<string, unknown>,
  gestaltHome: string,
  extra: Partial<ResearchHandlerOptions>,
) {
  const input = researchInputSchema.parse(params);
  return (await handleResearchPassthrough(input, process.cwd(), {
    builtinDir: BUILTIN,
    gestaltHome,
    env: {},
    ...extra,
  })) as Record<string, any>;
}

const PHONE_OCR: OcrResult = {
  width: 300,
  height: 200,
  languages: ['ko-KR'],
  lines: [
    {
      text: '연락처 010-1234-5678',
      box: { x: 10, y: 10, w: 200, h: 20 },
      confidence: 1,
      tokens: [
        { start: 0, end: 3, box: { x: 10, y: 10, w: 40, h: 20 } },
        { start: 4, end: 17, box: { x: 55, y: 10, w: 155, h: 20 } },
      ],
    },
  ],
  faces: [],
  barcodes: [],
};

describe('ges_research action=redact_image', () => {
  function fixture() {
    const repo = tmpHome();
    const img = join(repo, 'raw.png');
    writeFileSync(img, 'raw-bytes');
    return { repo, img };
  }

  it('치환한 캡처를 captures에 저장하고 상대 경로와 pii 상태를 돌려준다', async () => {
    const { repo, img } = fixture();
    const r = await runWith(
      { action: 'redact_image', repoRoot: repo, slug: 'demo', captureId: 'cap-1', imagePath: img },
      repo,
      {
        visionRunner: async (args) => {
          if (args[0] === 'ocr') return JSON.stringify(PHONE_OCR);
          writeFileSync(args[3]!, 'painted');
          return '';
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(r.pii).toBe('replaced');
    expect(r.path).toBe('captures/cap-1.png');
    expect(readFileSync(join(repo, '.gestalt/research/demo', r.path), 'utf-8')).toBe('painted');
    expect(r.warnings.some((w: string) => w.includes('원본'))).toBe(true);
    expect(existsSync(img)).toBe(true);
  });

  it('deleteSource면 치환한 뒤 원본을 지운다', async () => {
    const { repo, img } = fixture();
    await runWith(
      {
        action: 'redact_image',
        repoRoot: repo,
        slug: 'demo',
        captureId: 'cap-1',
        imagePath: img,
        deleteSource: true,
      },
      repo,
      {
        visionRunner: async (args) => {
          if (args[0] === 'ocr') return JSON.stringify(PHONE_OCR);
          writeFileSync(args[3]!, 'painted');
          return '';
        },
      },
    );
    expect(existsSync(img)).toBe(false);
  });

  it('Vision을 못 쓰면 unchecked로 저장하고 원본은 지우지 않는다', async () => {
    const { repo, img } = fixture();
    const r = await runWith(
      {
        action: 'redact_image',
        repoRoot: repo,
        slug: 'demo',
        captureId: 'cap-1',
        imagePath: img,
        deleteSource: true,
      },
      repo,
      { visionRunner: null },
    );
    expect(r.pii).toBe('unchecked');
    expect(existsSync(img)).toBe(true);
  });

  it('slug, captureId, 확장자, 없는 파일을 거절한다', async () => {
    const { repo, img } = fixture();
    const base = { action: 'redact_image', repoRoot: repo, imagePath: img };
    const bad = [
      { ...base, slug: '../x', captureId: 'a' },
      { ...base, slug: 'demo', captureId: 'A/b' },
      { ...base, slug: 'demo', captureId: 'a', imagePath: join(repo, 'x.txt') },
      { ...base, slug: 'demo', captureId: 'a', imagePath: join(repo, 'none.png') },
    ];
    const codes: string[] = [];
    for (const p of bad) {
      const r = await runWith(p, repo, { visionRunner: null });
      expect(r.ok).toBe(false);
      codes.push(r.errors[0].code);
    }
    expect(codes).toEqual([
      'INVALID_SLUG',
      'INVALID_CAPTURE_ID',
      'UNSUPPORTED_IMAGE',
      'IMAGE_NOT_FOUND',
    ]);
  });
});

describe('ges_research action=redact_script', () => {
  it('파일 경로를 주고 inline이면 본문도 함께 준다', async () => {
    const home = tmpHome();
    const r = await runWith({ action: 'redact_script', slug: 'demo' }, home, { tmpDir: home });
    expect(r.ok).toBe(true);
    expect(r.script).toBeUndefined();
    expect(readFileSync(r.scriptPath, 'utf-8').startsWith('() => ')).toBe(true);
    const inline = await runWith(
      { action: 'redact_script', slug: 'demo', inline: true, observe: true },
      home,
      {
        tmpDir: home,
      },
    );
    expect(inline.script).toContain('var OBSERVE = true');
  });

  it('같은 slug는 같은 seed를 쓰고 slug가 다르면 달라진다', async () => {
    const home = tmpHome();
    const a1 = await runWith({ action: 'redact_script', slug: 'seed-a', inline: true }, home, {
      tmpDir: home,
    });
    const a2 = await runWith({ action: 'redact_script', slug: 'seed-a', inline: true }, home, {
      tmpDir: home,
    });
    const b = await runWith({ action: 'redact_script', slug: 'seed-b', inline: true }, home, {
      tmpDir: home,
    });
    expect(a1.script).toBe(a2.script);
    expect(a1.script).not.toBe(b.script);
  });

  it('slug가 없으면 거절한다', async () => {
    const r = await runWith({ action: 'redact_script' }, tmpHome(), {});
    expect(r.errors[0].code).toBe('INVALID_SLUG');
  });
});
