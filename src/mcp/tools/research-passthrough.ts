import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { gestaltPath } from '../../core/home.js';
import { buildDomRedactionScript } from '../../research/pii-dom.js';
import {
  isVisionAvailable,
  redactImageFile,
  swiftRunner,
  type VisionRunner,
} from '../../research/pii-image.js';
import { redactorFor, seedFor } from '../../research/pii.js';
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
  }
}
