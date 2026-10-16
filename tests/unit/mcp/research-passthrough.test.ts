import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

describe('ges_research action=validate, render', () => {
  async function setup() {
    const repo = tmpHome();
    const { sampleResearch } = await import('../research/fixture.js');
    const ir = sampleResearch();
    const irPath = join(repo, 'ir.json');
    writeFileSync(irPath, JSON.stringify(ir));
    const slug = ir.meta.slug;
    const capDir = join(repo, '.gestalt/research', slug, 'captures');
    mkdirSync(capDir, { recursive: true });
    writeFileSync(join(capDir, 'a-home.png'), 'png-bytes');
    return { repo, ir, irPath, slug };
  }

  it('validate는 경고를 돌려주고 저장하지 않는다', async () => {
    const { repo, irPath, slug } = await setup();
    const r = await runWith({ action: 'validate', repoRoot: repo, irPath }, repo, {});
    expect(r.ok).toBe(true);
    expect(r.slug).toBe(slug);
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(existsSync(join(repo, '.gestalt/research', slug, 'research.json'))).toBe(false);
  });

  it('스키마에 안 맞으면 항목별 오류를 돌려준다', async () => {
    const { repo } = await setup();
    const bad = join(repo, 'bad.json');
    writeFileSync(bad, JSON.stringify({ meta: { slug: 'x' } }));
    const r = await runWith({ action: 'validate', repoRoot: repo, irPath: bad }, repo, {});
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe('INVALID_RESEARCH');
  });

  it('render는 IR을 저장하고 개인용과 공유용 HTML을 만든다', async () => {
    const { repo, irPath, slug } = await setup();
    const r = await runWith({ action: 'render', repoRoot: repo, irPath }, repo, {});
    expect(r.ok).toBe(true);
    expect(existsSync(r.jsonPath)).toBe(true);
    expect(readFileSync(r.htmlPath, 'utf-8')).toContain('data:image/png;base64');
    expect(r.sharedHtmlPath).toBeTruthy();
    expect(r.openPath).toBe(r.htmlPath);
    expect(r.slug).toBe(slug);
  });

  it('공유용을 요청했는데 unchecked 캡처가 있으면 막는다', async () => {
    const { repo, ir, irPath } = await setup();
    const bad = { ...ir, captures: ir.captures!.map((c) => ({ ...c, pii: 'unchecked' })) };
    writeFileSync(irPath, JSON.stringify(bad));
    const blocked = await runWith(
      { action: 'render', repoRoot: repo, irPath, audience: 'shared' },
      repo,
      {},
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.errors[0].code).toBe('SHARE_BLOCKED');
    const priv = await runWith({ action: 'render', repoRoot: repo, irPath }, repo, {});
    expect(priv.ok).toBe(true);
    expect(priv.sharedHtmlPath).toBeNull();
    expect(priv.sharedBlocked.captureIds.length).toBeGreaterThan(0);
  });

  it('저장 폴더 밖을 가리키는 심볼릭 링크 이미지는 싣지 않는다', async () => {
    const { repo, irPath, slug } = await setup();
    const outside = join(repo, 'secret.png');
    writeFileSync(outside, 'secret-bytes');
    const link = join(repo, '.gestalt/research', slug, 'captures', 'a-home.png');
    rmSync(link);
    symlinkSync(outside, link);
    const r = await runWith({ action: 'render', repoRoot: repo, irPath }, repo, {});
    expect(r.ok).toBe(true);
    expect(readFileSync(r.htmlPath, 'utf-8')).not.toContain(
      Buffer.from('secret-bytes').toString('base64'),
    );
    expect(r.warnings.some((w: string) => w.includes('읽지 못했다'))).toBe(true);
  });

  it('slug가 meta.slug와 다르면 거절한다', async () => {
    const { repo, irPath } = await setup();
    const r = await runWith({ action: 'render', repoRoot: repo, irPath, slug: 'other' }, repo, {});
    expect(r.errors[0].code).toBe('SLUG_MISMATCH');
  });
});

describe('ges_research action=figma_plan', () => {
  async function setup() {
    const repo = tmpHome();
    const { sampleResearch } = await import('../research/fixture.js');
    const ir = sampleResearch();
    const irPath = join(repo, 'ir.json');
    writeFileSync(irPath, JSON.stringify(ir));
    const capDir = join(repo, '.gestalt/research', ir.meta.slug, 'captures');
    mkdirSync(capDir, { recursive: true });
    writeFileSync(join(capDir, 'a-home.png'), 'png-bytes');
    return { repo, ir, irPath };
  }

  it('계획과 스크립트를 research 폴더에 쓰고 경로를 돌려준다', async () => {
    const { repo, irPath } = await setup();
    const r = await runWith({ action: 'figma_plan', repoRoot: repo, irPath }, repo, {});
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(r.planPath, 'utf-8')).version).toBe(1);
    const script = readFileSync(r.scriptPath, 'utf-8');
    expect(script.startsWith('async () =>')).toBe(true);
    expect(script).not.toContain(Buffer.from('png-bytes').toString('base64'));
    expect(r.embeddedImages).toBe(0);
    expect(r.script).toBeUndefined();
    expect(existsSync(r.verifyScriptPath)).toBe(true);
  });

  it('withImages면 이미지를 스크립트에 넣고 inline이면 본문도 싣는다', async () => {
    const { repo, irPath } = await setup();
    const r = await runWith(
      { action: 'figma_plan', repoRoot: repo, irPath, withImages: true, inline: true },
      repo,
      {},
    );
    expect(r.ok).toBe(true);
    expect(r.embeddedImages).toBe(1);
    expect(readFileSync(r.scriptPath, 'utf-8')).toContain(
      Buffer.from('png-bytes').toString('base64'),
    );
    expect(r.script).toContain('figma.createPage');
  });

  it('공유용은 unchecked 캡처가 있으면 막는다', async () => {
    const { repo, ir, irPath } = await setup();
    const bad = { ...ir, captures: ir.captures!.map((c) => ({ ...c, pii: 'unchecked' })) };
    writeFileSync(irPath, JSON.stringify(bad));
    const r = await runWith(
      { action: 'figma_plan', repoRoot: repo, irPath, audience: 'shared' },
      repo,
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe('SHARE_BLOCKED');
    expect(r.captureIds.length).toBeGreaterThan(0);
  });
});
