import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

async function run(
  params: Record<string, unknown>,
  gestaltHome: string,
  env = {},
  extra: Partial<ResearchHandlerOptions> = {},
) {
  const input = researchInputSchema.parse(params);
  return (await handleResearchPassthrough(input, process.cwd(), {
    builtinDir: BUILTIN,
    gestaltHome,
    env,
    ...extra,
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

  it('runner가 body면 함수 껍데기 없는 본문을 쓰고 업로드할 파일과 fit 스크립트를 준다', async () => {
    const { repo, irPath } = await setup();
    const r = await runWith(
      { action: 'figma_plan', repoRoot: repo, irPath, runner: 'body' },
      repo,
      {},
    );
    expect(r.ok).toBe(true);
    expect(r.runner).toBe('body');
    expect(readFileSync(r.scriptPath, 'utf-8').startsWith('async () =>')).toBe(false);
    expect(readFileSync(r.fitScriptPath, 'utf-8')).toContain('getImageByHash');
    expect(r.imageFiles).toEqual([
      expect.objectContaining({ id: 'cap1', contentType: 'image/png' }),
    ]);
    expect(r.imageFiles[0].path.endsWith('captures/a-home.png')).toBe(true);
  });

  it('저장 폴더 밖을 가리키는 심볼릭 링크 이미지는 업로드 목록에 넣지 않는다', async () => {
    const { repo, ir, irPath } = await setup();
    const outside = join(repo, 'outside.png');
    writeFileSync(outside, 'x');
    const link = join(repo, '.gestalt/research', ir.meta.slug, 'captures', 'a-home.png');
    rmSync(link);
    symlinkSync(outside, link);
    const r = await runWith({ action: 'figma_plan', repoRoot: repo, irPath }, repo, {});
    expect(r.ok).toBe(true);
    expect(r.imageFiles).toEqual([]);
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

describe('ges_research action=split_video, merge_video', () => {
  async function setup() {
    const repo = tmpHome();
    const { sampleResearch, sampleVideo, videoFrameCapture } =
      await import('../research/fixture.js');
    const base = sampleResearch();
    const ir = {
      ...base,
      captures: [...(base.captures ?? []), videoFrameCapture()],
      video: sampleVideo(),
    };
    const irPath = join(repo, 'ir.json');
    writeFileSync(irPath, JSON.stringify(ir));
    const slug = ir.meta.slug;
    const capDir = join(repo, '.gestalt/research', slug, 'captures');
    mkdirSync(capDir, { recursive: true });
    writeFileSync(join(capDir, 'a-01.jpg'), 'jpg-bytes');
    writeFileSync(join(capDir, 'a-home.png'), 'png-bytes');
    await runWith({ action: 'render', repoRoot: repo, irPath }, repo, {});
    return { repo, slug };
  }
  const dirOf = (repo: string, slug: string): string => join(repo, '.gestalt/research', slug);

  it('떼어내면 영상 문서와 프레임 이미지를 만들고 본문은 그대로 둔다', async () => {
    const { repo, slug } = await setup();
    const r = await runWith({ action: 'split_video', repoRoot: repo, slug }, repo, {});
    expect(r.ok).toBe(true);
    expect(r.videoSlug).toBe(`${slug}-video`);
    expect(r.copiedImages).toEqual(['captures/a-01.jpg']);
    expect(existsSync(join(dirOf(repo, r.videoSlug), 'captures/a-01.jpg'))).toBe(true);
    expect(existsSync(join(dirOf(repo, r.videoSlug), 'captures/a-home.png'))).toBe(false);
    const video = JSON.parse(readFileSync(r.videoJsonPath, 'utf-8'));
    expect(video.meta.kind).toBe('video-analysis');
    const main = JSON.parse(readFileSync(join(dirOf(repo, slug), 'research.json'), 'utf-8'));
    expect(main.video.clips).toHaveLength(2);
  });

  it('영상 문서가 이미 있으면 거절하고 overwrite를 켜면 덮어쓴다', async () => {
    const { repo, slug } = await setup();
    await runWith({ action: 'split_video', repoRoot: repo, slug }, repo, {});
    const again = await runWith({ action: 'split_video', repoRoot: repo, slug }, repo, {});
    expect(again.ok).toBe(false);
    expect(again.errors[0].code).toBe('TARGET_EXISTS');
    const forced = await runWith(
      { action: 'split_video', repoRoot: repo, slug, overwrite: true },
      repo,
      {},
    );
    expect(forced.ok).toBe(true);
  });

  it('원본 이미지가 없으면 missingImages로 알린다', async () => {
    const { repo, slug } = await setup();
    rmSync(join(dirOf(repo, slug), 'captures/a-01.jpg'));
    const r = await runWith({ action: 'split_video', repoRoot: repo, slug }, repo, {});
    expect(r.ok).toBe(true);
    expect(r.missingImages).toEqual(['captures/a-01.jpg']);
  });

  it('removeFromMain으로 뗀 영상을 merge_video로 되돌린다', async () => {
    const { repo, slug } = await setup();
    const split = await runWith(
      { action: 'split_video', repoRoot: repo, slug, removeFromMain: true },
      repo,
      {},
    );
    expect(split.removedFromMain).toBe(true);
    const mainAfter = JSON.parse(readFileSync(join(dirOf(repo, slug), 'research.json'), 'utf-8'));
    expect(mainAfter.video).toBeUndefined();

    rmSync(join(dirOf(repo, slug), 'captures/a-01.jpg'));
    const merged = await runWith({ action: 'merge_video', repoRoot: repo, slug }, repo, {});
    expect(merged.ok).toBe(true);
    expect(merged.clips).toBe(2);
    expect(merged.copiedImages).toEqual(['captures/a-01.jpg']);
    expect(existsSync(join(dirOf(repo, slug), 'captures/a-01.jpg'))).toBe(true);
  });

  it('없는 slug와 올바르지 않은 videoSlug는 실패한다', async () => {
    const repo = tmpHome();
    const none = await runWith({ action: 'split_video', repoRoot: repo, slug: 'nope' }, repo, {});
    expect(none.ok).toBe(false);
    const noSlug = await runWith({ action: 'merge_video', repoRoot: repo }, repo, {});
    expect(noSlug.errors[0].code).toBe('INVALID_SLUG');
    const bad = await runWith(
      { action: 'merge_video', repoRoot: repo, slug: 'x', videoSlug: '../y' },
      repo,
      {},
    );
    expect(bad.errors[0].code).toBe('INVALID_SLUG');
  });
});

describe('ges_research action=create_source', () => {
  const source = (over: Record<string, unknown> = {}) => ({
    name: 'my-review-site',
    description: '리뷰 사이트에서 불만을 찾는다',
    stage: ['evidence'],
    access: [{ http: { host: 'api.example.com', probe: 'https://api.example.com/ping' } }],
    steps: ['검색어로 목록을 연다.', '최근 글을 읽는다.'],
    stops: ['로그인을 요구하면 멈춘다.'],
    ...over,
  });
  const okFetch = vi.fn().mockResolvedValue({ status: 200, body: { cancel: async () => {} } });
  const probe = {
    fetchImpl: okFetch as unknown as typeof fetch,
    lookup: async () => ['93.184.216.34'],
  };

  it('source가 없으면 질문 목록과 예시를 돌려주고 아무것도 쓰지 않는다', async () => {
    const home = tmpHome();
    const r = await run({ action: 'create_source' }, home);
    expect(r.ok).toBe(true);
    expect(r.needsInput).toBe(true);
    expect(r.questions.map((q: { key: string }) => q.key)).toContain('stops');
    expect(existsSync(join(home, 'research-sources'))).toBe(false);
  });

  it('검증을 통과하면 개인 디렉토리에 쓰고 sources에서 바로 읽힌다', async () => {
    const home = tmpHome();
    const r = await run({ action: 'create_source', source: source() }, home, {}, { probe });
    expect(r.ok).toBe(true);
    expect(r.trial.status).toBe('usable');
    expect(r.trial.probes).toEqual([expect.objectContaining({ ok: true, status: 200 })]);
    expect(r.warnings).toEqual([]);
    expect(
      readFileSync(join(home, 'research-sources', 'my-review-site', 'SOURCE.md'), 'utf-8'),
    ).toContain('## 멈추는 곳');
    const list = await run({ action: 'sources', name: 'my-review-site' }, home);
    expect(list.detail.origin).toBe('personal');
  });

  it('JSON 문자열로 온 source도 받는다', async () => {
    const home = tmpHome();
    const r = await run(
      {
        action: 'create_source',
        source: JSON.stringify(source({ access: [{ http: { host: 'api.example.com' } }] })),
      },
      home,
    );
    expect(r.ok).toBe(true);
    expect(r.trial.probes).toEqual([]);
  });

  it('같은 이름은 overwrite 없이는 거절하고 있으면 덮어쓴다', async () => {
    const home = tmpHome();
    await run({ action: 'create_source', source: source() }, home, {}, { probe });
    const again = await run({ action: 'create_source', source: source() }, home, {}, { probe });
    expect(again.ok).toBe(false);
    expect(again.errors[0].code).toBe('SOURCE_EXISTS');
    const over = await run(
      { action: 'create_source', source: source({ description: '바꿨다' }), overwrite: true },
      home,
      {},
      { probe },
    );
    expect(over.ok).toBe(true);
    const list = await run({ action: 'sources', name: 'my-review-site' }, home);
    expect(
      list.sources.find((s: { name: string }) => s.name === 'my-review-site').description,
    ).toBe('바꿨다');
  });

  it('내장 출처와 같은 이름은 overwrite가 있어야 하고 덮어쓰면 표시한다', async () => {
    const home = tmpHome();
    const s = source({ name: 'app-store-search' });
    const denied = await run({ action: 'create_source', source: s }, home, {}, { probe });
    expect(denied.errors[0].code).toBe('SOURCE_EXISTS');
    const r = await run(
      { action: 'create_source', source: s, overwrite: true },
      home,
      {},
      { probe },
    );
    expect(r.ok).toBe(true);
    expect(r.overridesBuiltin).toBe(true);
    expect(r.warnings.some((w: string) => w.includes('내장 출처'))).toBe(true);
  });

  it('쓸 수 없는 상태나 probe 실패는 파일을 남기고 경고로 알린다', async () => {
    const home = tmpHome();
    const failing = {
      fetchImpl: vi.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch,
      lookup: probe.lookup,
    };
    const r = await run(
      {
        action: 'create_source',
        source: source({
          name: 'needs-mcp',
          access: [
            { mcp: { server: 'review-mcp' } },
            { http: { host: 'api.example.com', probe: 'https://api.example.com/ping' } },
          ],
        }),
      },
      home,
      {},
      { probe: failing },
    );
    expect(r.ok).toBe(true);
    expect(r.trial.status).toBe('fallback');
    expect(r.warnings.some((w: string) => w.includes('probe 실패'))).toBe(true);
  });

  it('검증에 실패하면 아무것도 쓰지 않는다', async () => {
    const home = tmpHome();
    for (const bad of [
      source({ name: '../x' }),
      source({ access: [{ http: { host: '10.0.0.1' } }] }),
      source({ limits: 'token: abcdefabcdefabcdefabcd' }),
      source({ stops: [] }),
      { name: 'x' },
    ]) {
      const r = await run({ action: 'create_source', source: bad }, home, {}, { probe });
      expect(r.ok).toBe(false);
    }
    expect(existsSync(join(home, 'research-sources'))).toBe(false);
  });
});

describe('ges_research action=prose_extract, prose_apply', () => {
  const BUSINESS = 'reasons[0].business';

  /** 저장본을 만든다. 윤문 액션은 slug 저장본만 읽는다 */
  async function setup() {
    const repo = tmpHome();
    const { sampleResearch } = await import('../research/fixture.js');
    const { parseResearch } = await import('../../../src/research/index.js');
    const { ResearchStore } = await import('../../../src/research/store.js');
    const parsedIr = parseResearch(sampleResearch());
    if (!parsedIr.ok) throw new Error('픽스처 파싱 실패');
    const store = new ResearchStore(repo);
    store.save(parsedIr.value);
    const slug = parsedIr.value.meta.slug;
    const jsonPath = store.jsonPath(slug);
    return { repo, slug, jsonPath, store };
  }

  async function extract(repo: string, slug: string) {
    return runWith({ action: 'prose_extract', repoRoot: repo, slug }, repo, {});
  }

  function itemOf(r: Record<string, any>, path: string) {
    return r.items.find((i: { path: string }) => i.path === path);
  }

  it('extract 결과를 apply로 되돌려 넣으면 저장본을 다시 읽어도 바뀌어 있다', async () => {
    const { repo, slug, jsonPath } = await setup();
    const ex = await extract(repo, slug);
    expect(ex.ok).toBe(true);
    expect(ex.counts.chat).toBeGreaterThan(0);
    expect(ex.counts.report).toBeGreaterThan(0);
    const item = itemOf(ex, BUSINESS);
    expect(item.register).toBe('report');

    const ap = await runWith(
      {
        action: 'prose_apply',
        repoRoot: repo,
        slug,
        items: [
          { path: BUSINESS, text: '인기 상품을 먼저 두는 게 본업이다 (해석)', hash: item.hash },
        ],
      },
      repo,
      {},
    );
    expect(ap.ok).toBe(true);
    expect(ap.saved).toBe(true);
    expect(ap.applied).toBe(1);
    expect(ap.warnings).toEqual([]);
    expect(Array.isArray(ap.lint)).toBe(true);

    const disk = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(disk.reasons[0].business).toBe('인기 상품을 먼저 두는 게 본업이다 (해석)');

    // 저장본을 다시 뽑으면 새 문장과 새 hash가 나온다
    const again = await extract(repo, slug);
    const next = itemOf(again, BUSINESS);
    expect(next.text).toBe('인기 상품을 먼저 두는 게 본업이다 (해석)');
    expect(next.hash).not.toBe(item.hash);
  });

  it('applyProse 결과는 parseResearch를 통과한다(저장본이 스키마를 유지한다)', async () => {
    const { repo, slug, jsonPath } = await setup();
    const ex = await extract(repo, slug);
    await runWith(
      {
        action: 'prose_apply',
        repoRoot: repo,
        slug,
        items: [{ path: BUSINESS, text: '고친 문장 (해석)', hash: itemOf(ex, BUSINESS).hash }],
      },
      repo,
      {},
    );
    const { parseResearch } = await import('../../../src/research/index.js');
    expect(parseResearch(JSON.parse(readFileSync(jsonPath, 'utf8'))).ok).toBe(true);
  });

  it('dryRun은 반영 수는 알려주되 파일을 쓰지 않는다', async () => {
    const { repo, slug, jsonPath } = await setup();
    const before = readFileSync(jsonPath, 'utf8');
    const ex = await extract(repo, slug);
    const ap = await runWith(
      {
        action: 'prose_apply',
        repoRoot: repo,
        slug,
        dryRun: true,
        items: [{ path: BUSINESS, text: '시험 문장 (해석)', hash: itemOf(ex, BUSINESS).hash }],
      },
      repo,
      {},
    );
    expect(ap.ok).toBe(true);
    expect(ap.dryRun).toBe(true);
    expect(ap.applied).toBe(1);
    expect(ap.saved).toBe(false);
    expect(readFileSync(jsonPath, 'utf8')).toBe(before);
  });

  it('바뀐 게 없으면 saved가 false이고 파일을 다시 쓰지 않는다', async () => {
    const { repo, slug, jsonPath } = await setup();
    const before = readFileSync(jsonPath, 'utf8');
    const ex = await extract(repo, slug);
    const item = itemOf(ex, BUSINESS);
    const ap = await runWith(
      {
        action: 'prose_apply',
        repoRoot: repo,
        slug,
        items: [{ path: BUSINESS, text: item.text, hash: item.hash }],
      },
      repo,
      {},
    );
    expect(ap.ok).toBe(true);
    expect(ap.applied).toBe(0);
    expect(ap.unchanged).toBe(1);
    expect(ap.saved).toBe(false);
    expect(readFileSync(jsonPath, 'utf8')).toBe(before);
  });

  it('경고만 나온 항목은 저장하지 않고 경고를 돌려준다', async () => {
    const { repo, slug, jsonPath } = await setup();
    const before = readFileSync(jsonPath, 'utf8');
    const ex = await extract(repo, slug);
    const ap = await runWith(
      {
        action: 'prose_apply',
        repoRoot: repo,
        slug,
        items: [
          { path: BUSINESS, text: '표식 뺀 문장', hash: itemOf(ex, BUSINESS).hash },
          { path: 'reasons[9].business', text: '없는 칸', hash: 'abcdefabcdef' },
        ],
      },
      repo,
      {},
    );
    expect(ap.saved).toBe(false);
    expect(ap.warnings.map((w: { code: string }) => w.code).sort()).toEqual([
      'MARKER_MISMATCH',
      'UNKNOWN_PATH',
    ]);
    expect(readFileSync(jsonPath, 'utf8')).toBe(before);
  });

  it('hash가 빠진 items는 입력 스키마가 거부한다', () => {
    const r = researchInputSchema.safeParse({
      action: 'prose_apply',
      slug: 'sample-giftcard',
      items: [{ path: BUSINESS, text: '문장' }],
    });
    expect(r.success).toBe(false);
  });

  it('items가 없으면 ITEMS_REQUIRED다', async () => {
    const { repo, slug } = await setup();
    const r = await runWith({ action: 'prose_apply', repoRoot: repo, slug }, repo, {});
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe('ITEMS_REQUIRED');
  });

  it('items를 JSON 문자열로 받아도 푼다', async () => {
    const { repo, slug, jsonPath } = await setup();
    const ex = await extract(repo, slug);
    const items = JSON.stringify([
      { path: BUSINESS, text: '문자열로 온 문장 (해석)', hash: itemOf(ex, BUSINESS).hash },
    ]);
    const ap = await runWith({ action: 'prose_apply', repoRoot: repo, slug, items }, repo, {});
    expect(ap.ok).toBe(true);
    expect(ap.applied).toBe(1);
    expect(JSON.parse(readFileSync(jsonPath, 'utf8')).reasons[0].business).toBe(
      '문자열로 온 문장 (해석)',
    );
  });

  it('slug가 없으면 irPath가 있어도 INVALID_SLUG다', async () => {
    const { repo } = await setup();
    const irPath = join(repo, 'ir.json');
    writeFileSync(irPath, '{}');
    for (const action of ['prose_extract', 'prose_apply']) {
      const r = await runWith(
        { action, repoRoot: repo, irPath, items: [{ path: 'a', text: 'b', hash: 'c' }] },
        repo,
        {},
      );
      expect(r.ok).toBe(false);
      expect(r.errors[0].code).toBe('INVALID_SLUG');
    }
  });

  it('저장본이 없는 slug는 실패한다', async () => {
    const repo = tmpHome();
    const r = await extract(repo, 'no-such-slug');
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe('IR_NOT_FOUND');
  });
});
