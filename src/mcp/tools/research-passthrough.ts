import { join } from 'node:path';
import { gestaltPath } from '../../core/home.js';
import { ResearchSourceRegistry } from '../../research/source-registry.js';
import { buildSourceReport } from '../../research/source-status.js';
import type { ResearchInput } from '../schemas.js';

export interface ResearchHandlerOptions {
  /** 내장 출처 디렉토리. 서버가 config.researchSourcesDir을 넘긴다 */
  builtinDir: string;
  /** `~/.gestalt` 디렉토리. 테스트에서 임시 경로를 꽂는다 */
  gestaltHome?: string;
  env?: NodeJS.ProcessEnv;
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

export async function handleResearchPassthrough(
  input: ResearchInput,
  _cwd: string = process.cwd(),
  opts: ResearchHandlerOptions,
): Promise<object> {
  switch (input.action) {
    case 'sources':
      return handleSources(input, opts);
  }
}
