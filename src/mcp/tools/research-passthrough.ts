import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { gestaltPath } from '../../core/home.js';
import { buildDomRedactionScript } from '../../research/pii-dom.js';
import {
  isVisionAvailable,
  redactImageFile,
  swiftRunner,
  type VisionRunner,
} from '../../research/pii-image.js';
import { redactorFor, seedFor } from '../../research/pii.js';
import { buildFigmaPlan } from '../../research/figma-plan.js';
import {
  buildFigmaScript,
  buildFigmaVerifyScript,
  type FigmaImageData,
} from '../../research/figma-script.js';
import { renderResearchHtml, type LoadedImage } from '../../research/render-html.js';
import { lintResearch, parseResearch, type Research } from '../../research/schema.js';
import { isValidSlug, ResearchStore } from '../../research/store.js';
import { ResearchSourceRegistry } from '../../research/source-registry.js';
import { buildSourceReport } from '../../research/source-status.js';
import type { ResearchInput } from '../schemas.js';

export interface ResearchHandlerOptions {
  /** 내장 출처 디렉토리. 서버가 config.researchSourcesDir을 넘긴다 */
  builtinDir: string;
  /** `~/.gestalt` 디렉토리. 테스트에서 임시 경로를 꽂는다 */
  gestaltHome?: string;
  env?: NodeJS.ProcessEnv;
  /** `pii-vision.swift` 경로. 서버가 `join(config.skillsDir, 'research', 'scripts', 'pii-vision.swift')`를 넘긴다 */
  visionScript?: string;
  /** 테스트용. null이면 Vision을 못 쓰는 환경으로 본다. 비우면 swift를 확인해서 쓴다 */
  visionRunner?: VisionRunner | null;
  /** DOM 치환 스크립트 파일을 둘 디렉토리. 기본은 OS 임시 디렉토리 */
  tmpDir?: string;
}

interface ResearchFailure {
  ok: false;
  errors: Array<{ code: string; message: string }>;
}

function fail(code: string, message: string): ResearchFailure {
  return { ok: false, errors: [{ code, message }] };
}

export function personalSourcesDir(opts: Pick<ResearchHandlerOptions, 'gestaltHome'>): string {
  return opts.gestaltHome
    ? join(opts.gestaltHome, 'research-sources')
    : gestaltPath('research-sources');
}

function loadRegistry(opts: ResearchHandlerOptions): ResearchSourceRegistry {
  const registry = new ResearchSourceRegistry(opts.builtinDir, personalSourcesDir(opts));
  registry.loadAll();
  return registry;
}

function handleSources(input: ResearchInput, opts: ResearchHandlerOptions): object {
  const registry = loadRegistry(opts);
  const report = buildSourceReport(
    registry.getAll(),
    input.available ?? {},
    opts.env ?? process.env,
    input.stage,
  );
  const base = { ok: true, action: 'sources', ...report, diagnostics: registry.getDiagnostics() };
  if (!input.name) return base;

  const source = registry.getByName(input.name);
  if (!source) return fail('SOURCE_NOT_FOUND', `없는 출처: ${input.name}`);
  return {
    ...base,
    detail: {
      name: source.frontmatter.name,
      origin: source.origin,
      access: source.frontmatter.access,
      body: source.body,
    },
  };
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

async function resolveRunner(opts: ResearchHandlerOptions): Promise<VisionRunner | undefined> {
  if (opts.visionRunner !== undefined) return opts.visionRunner ?? undefined;
  if (!opts.visionScript || !existsSync(opts.visionScript)) return undefined;
  return (await isVisionAvailable()) ? swiftRunner(opts.visionScript) : undefined;
}

async function handleRedactImage(
  input: ResearchInput,
  cwd: string,
  opts: ResearchHandlerOptions,
): Promise<object> {
  if (!input.slug || !isValidSlug(input.slug)) {
    return fail('INVALID_SLUG', 'slug는 소문자, 숫자, -만 쓴다(최대 64자)');
  }
  if (!input.captureId || !ID_PATTERN.test(input.captureId)) {
    return fail('INVALID_CAPTURE_ID', 'captureId는 소문자, 숫자, -만 쓴다(최대 64자)');
  }
  if (!input.imagePath) return fail('IMAGE_PATH_REQUIRED', 'imagePath가 필요하다');

  const repoRoot = resolve(cwd, input.repoRoot ?? '.');
  const source = isAbsolute(input.imagePath) ? input.imagePath : resolve(repoRoot, input.imagePath);
  if (!IMAGE_EXTS.has(extname(source).toLowerCase())) {
    return fail('UNSUPPORTED_IMAGE', 'png, jpg, webp 파일만 받는다');
  }
  if (!existsSync(source) || !statSync(source).isFile()) {
    return fail('IMAGE_NOT_FOUND', `이미지가 없다: ${input.imagePath}`);
  }
  if (statSync(source).size > MAX_IMAGE_BYTES) {
    return fail('IMAGE_TOO_LARGE', '30MB를 넘는 이미지는 받지 않는다');
  }

  const store = new ResearchStore(repoRoot);
  const capturesDir = store.capturesDir(input.slug);
  mkdirSync(capturesDir, { recursive: true });

  const result = await redactImageFile({
    inputPath: source,
    outputBase: join(capturesDir, input.captureId),
    pii: redactorFor(input.slug),
    run: await resolveRunner(opts),
  });

  const warnings = [...result.warnings];
  if (result.pii === 'none') {
    warnings.push(
      'none은 탐지기가 돌았고 0건이라는 뜻이다. 라벨 없는 이름처럼 못 잡는 것이 있어서 개인정보가 없다는 보증은 아니다.',
    );
  }
  const sourceIsOutput = resolve(result.outputPath) === resolve(source);
  if (input.deleteSource && result.pii !== 'unchecked' && !sourceIsOutput) {
    rmSync(source, { force: true });
  } else if (result.pii === 'replaced' && !sourceIsOutput) {
    warnings.push(`원본(${basename(source)})에 개인정보가 그대로 남아 있다. 필요 없으면 지운다.`);
  }

  return {
    ok: true,
    action: 'redact_image',
    captureId: input.captureId,
    path: `captures/${basename(result.outputPath)}`,
    pii: result.pii,
    counts: result.counts,
    warnings,
  };
}

function handleRedactScript(input: ResearchInput, opts: ResearchHandlerOptions): object {
  if (!input.slug || !isValidSlug(input.slug)) {
    return fail('INVALID_SLUG', 'slug는 소문자, 숫자, -만 쓴다(최대 64자)');
  }
  const script = buildDomRedactionScript(seedFor(input.slug), { observe: input.observe });
  const dir = opts.tmpDir ?? tmpdir();
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, `ges-research-${input.slug}-dom-redact.js`);
  writeFileSync(scriptPath, `() => ${script}`, { mode: 0o600 });

  return {
    ok: true,
    action: 'redact_script',
    scriptPath,
    bytes: Buffer.byteLength(script),
    usage: [
      'chrome-devtools: evaluate_script에 sourcePath로 이 파일을 주고 format은 function으로 둔다. 캡처 직전에 실행한다.',
      'aside: inline을 true로 다시 불러 본문을 받고 page.addInitScript로 한 번 심는다. observe를 켜면 이동한 뒤에도 자동으로 돈다.',
      '반환값은 바꾼 개수뿐이다. 실행 뒤 개수가 모두 0이어도 pii를 none으로 적지 말고 화면을 눈으로 확인한 뒤 정한다.',
      '닫힌 shadow root, 다른 출처의 iframe, canvas 속 글자는 못 바꾼다. 화면에 있으면 unchecked로 남긴다.',
    ],
    ...(input.inline ? { script } : {}),
  };
}

const MAX_IR_BYTES = 5 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

interface LoadedIr {
  research: Research;
  fromFile: boolean;
}

/** irPath가 있으면 그 파일을, 없으면 slug의 저장본을 읽어 검증한다 */
function loadIr(input: ResearchInput, repoRoot: string): LoadedIr | ResearchFailure {
  let raw: unknown;
  let fromFile = false;
  if (input.irPath) {
    const path = isAbsolute(input.irPath) ? input.irPath : resolve(repoRoot, input.irPath);
    if (!existsSync(path) || !statSync(path).isFile()) {
      return fail('IR_NOT_FOUND', `research.json이 없다: ${input.irPath}`);
    }
    if (statSync(path).size > MAX_IR_BYTES)
      return fail('IR_TOO_LARGE', 'research.json이 5MB를 넘는다');
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
      return fail(
        'IR_NOT_JSON',
        `JSON을 읽지 못했다: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    fromFile = true;
  } else {
    if (!input.slug || !isValidSlug(input.slug)) {
      return fail('INVALID_SLUG', 'irPath나 올바른 slug가 필요하다');
    }
    const path = new ResearchStore(repoRoot).jsonPath(input.slug);
    if (!existsSync(path)) return fail('IR_NOT_FOUND', `저장된 리서치가 없다: ${input.slug}`);
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
      return fail(
        'IR_NOT_JSON',
        `JSON을 읽지 못했다: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const parsed = parseResearch(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: parsed.error.issues.map((m) => ({ code: 'INVALID_RESEARCH', message: m })),
    };
  }
  if (input.slug && input.slug !== parsed.value.meta.slug) {
    return fail(
      'SLUG_MISMATCH',
      `slug(${input.slug})와 meta.slug(${parsed.value.meta.slug})가 다르다`,
    );
  }
  return { research: parsed.value, fromFile };
}

function handleValidate(input: ResearchInput, cwd: string): object {
  const repoRoot = resolve(cwd, input.repoRoot ?? '.');
  const loaded = loadIr(input, repoRoot);
  if ('ok' in loaded) return loaded;
  return {
    ok: true,
    action: 'validate',
    slug: loaded.research.meta.slug,
    warnings: lintResearch(loaded.research),
  };
}

/** 저장 폴더 밖으로 나가는 심볼릭 링크는 따라가지 않는다 */
function imageLoader(researchDir: string): (rel: string) => LoadedImage | null {
  return (rel) => {
    const mime = MIME_BY_EXT[extname(rel).toLowerCase()];
    const full = join(researchDir, rel);
    if (!mime || !existsSync(full)) return null;
    const real = realpathSync(full);
    if (!real.startsWith(realpathSync(researchDir) + sep)) return null;
    return { mime, data: readFileSync(real) };
  };
}

function handleRender(input: ResearchInput, cwd: string): object {
  const repoRoot = resolve(cwd, input.repoRoot ?? '.');
  const loaded = loadIr(input, repoRoot);
  if ('ok' in loaded) return loaded;
  const { research } = loaded;
  const slug = research.meta.slug;
  const store = new ResearchStore(repoRoot);
  const jsonPath = store.save(research);
  const loadImage = imageLoader(store.dir(slug));

  const warnings = lintResearch(research).map((w) => `${w.path}: ${w.message}`);
  const priv = renderResearchHtml(research, { audience: 'private', loadImage });
  if (!priv.ok) return fail(priv.code, priv.message);
  warnings.push(...priv.warnings);
  const htmlPath = store.saveHtml(slug, 'private', priv.html);

  const shared = renderResearchHtml(research, { audience: 'shared', loadImage });
  let sharedHtmlPath: string | null = null;
  let sharedBlocked: { message: string; captureIds: string[] } | undefined;
  if (shared.ok) {
    sharedHtmlPath = store.saveHtml(slug, 'shared', shared.html);
  } else {
    sharedBlocked = { message: shared.message, captureIds: shared.captureIds };
  }

  const audience = input.audience ?? 'private';
  if (audience === 'shared' && !sharedHtmlPath) {
    return {
      ok: false,
      errors: [{ code: 'SHARE_BLOCKED', message: sharedBlocked?.message ?? '' }],
      captureIds: sharedBlocked?.captureIds,
      htmlPath,
    };
  }
  return {
    ok: true,
    action: 'render',
    slug,
    jsonPath,
    htmlPath,
    sharedHtmlPath,
    openPath: audience === 'shared' ? sharedHtmlPath : htmlPath,
    ...(sharedBlocked ? { sharedBlocked } : {}),
    warnings,
  };
}

const FIGMA_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif']);
const MAX_FIGMA_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_SCRIPT_BYTES = 200 * 1024;

function handleFigmaPlan(input: ResearchInput, cwd: string): object {
  const repoRoot = resolve(cwd, input.repoRoot ?? '.');
  const loaded = loadIr(input, repoRoot);
  if ('ok' in loaded) return loaded;
  const { research } = loaded;
  const slug = research.meta.slug;
  const audience = input.audience ?? 'private';
  const built = buildFigmaPlan(research, { audience });
  if (!built.ok) {
    return {
      ok: false,
      errors: [{ code: built.code, message: built.message }],
      captureIds: built.captureIds,
    };
  }
  const store = new ResearchStore(repoRoot);
  store.save(research);
  const warnings: string[] = [];

  let images: Record<string, FigmaImageData> | undefined;
  if (input.withImages) {
    images = {};
    const loadImage = imageLoader(store.dir(slug));
    let total = 0;
    for (const img of built.plan.images) {
      const data = loadImage(img.path);
      if (!data) {
        warnings.push(`${img.id}: 이미지를 읽지 못해 회색 칸으로 둔다`);
      } else if (!FIGMA_IMAGE_MIMES.has(data.mime)) {
        warnings.push(`${img.id}: Figma가 받는 형식(PNG, JPEG, GIF)이 아니라 회색 칸으로 둔다`);
      } else if (total + data.data.length > MAX_FIGMA_IMAGE_BYTES) {
        warnings.push(`${img.id}: 이미지 합계 8MB를 넘어 회색 칸으로 둔다`);
      } else {
        total += data.data.length;
        images[img.id] = { base64: data.data.toString('base64') };
      }
    }
  }

  const script = buildFigmaScript(built.plan, images);
  const verifyScript = buildFigmaVerifyScript(
    '__PAGE_ID__',
    built.plan.images.map((i) => i.id),
  );
  const planPath = store.saveFile(slug, 'figma-plan.json', JSON.stringify(built.plan, null, 2));
  const scriptPath = store.saveFile(slug, 'figma-render.js', script);
  const verifyPath = store.saveFile(slug, 'figma-verify.js', verifyScript);

  const inline = input.inline === true;
  if (inline && Buffer.byteLength(script) > MAX_INLINE_SCRIPT_BYTES) {
    warnings.push(
      '스크립트가 200KB를 넘어 본문을 싣지 않는다. withImages를 끄거나 파일로 읽는 실행기를 쓴다',
    );
  }
  const attach = inline && Buffer.byteLength(script) <= MAX_INLINE_SCRIPT_BYTES;
  return {
    ok: true,
    action: 'figma_plan',
    slug,
    audience,
    planPath,
    scriptPath,
    verifyScriptPath: verifyPath,
    imageCount: built.plan.images.length,
    embeddedImages: images ? Object.keys(images).length : 0,
    ...(attach ? { script, verifyScript } : {}),
    warnings,
    usage:
      '편집 권한이 있는 Figma 파일에서 scriptPath의 함수를 실행한다. 반환한 pageId를 verify 스크립트의 __PAGE_ID__ 자리에 넣어 이미지가 남았는지 확인한다. 이미지 업로드가 끝나기 전에 탭을 닫지 않는다',
  };
}

export async function handleResearchPassthrough(
  input: ResearchInput,
  cwd: string = process.cwd(),
  opts: ResearchHandlerOptions,
): Promise<object> {
  switch (input.action) {
    case 'sources':
      return handleSources(input, opts);
    case 'redact_image':
      return handleRedactImage(input, cwd, opts);
    case 'redact_script':
      return handleRedactScript(input, opts);
    case 'validate':
      return handleValidate(input, cwd);
    case 'render':
      return handleRender(input, cwd);
    case 'figma_plan':
      return handleFigmaPlan(input, cwd);
  }
}
