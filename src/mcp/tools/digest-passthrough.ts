import { resolve } from 'node:path';
import { lintDigest, lintErrors } from '../../digest/lint.js';
import { applyProse, extractProse } from '../../digest/prose.js';
import { DigestLintError, DigestLoadError, renderToFiles } from '../../digest/render.js';
import { parseDigest, type Digest, type Transcript } from '../../digest/schema.js';
import { DigestStore, isValidSlug } from '../../digest/store.js';
import type { DigestInput } from '../schemas.js';

interface DigestFailure {
  ok: false;
  errors: Array<{ code: string; message: string }>;
}

function fail(code: string, message: string): DigestFailure {
  return { ok: false, errors: [{ code, message }] };
}

interface Loaded {
  store: DigestStore;
  transcript: Transcript;
  digest: Digest;
}

function load(input: DigestInput, cwd: string): Loaded | DigestFailure {
  if (!isValidSlug(input.slug)) return fail('INVALID_SLUG', `slug가 올바르지 않다: ${input.slug}`);
  const store = new DigestStore(resolve(cwd, input.repoRoot ?? '.'));
  const t = store.readTranscript(input.slug);
  if (!t.ok) return fail(t.code, t.message);
  const raw = store.readDigestFile(input.slug);
  if (raw.kind === 'missing') return fail('DIGEST_NOT_FOUND', `digest.json이 없다: ${input.slug}`);
  if (raw.kind === 'invalid-json') return fail('DIGEST_NOT_JSON', raw.message);
  const parsed = parseDigest(raw.value);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: parsed.error.issues.map((m) => ({ code: 'INVALID_DIGEST', message: m })),
    };
  }
  if (parsed.value.slug !== input.slug) {
    return fail(
      'SLUG_MISMATCH',
      `slug(${input.slug})와 digest.slug(${parsed.value.slug})가 다르다`,
    );
  }
  return { store, transcript: t.transcript, digest: parsed.value };
}

function handleValidate(input: DigestInput, cwd: string): object {
  const loaded = load(input, cwd);
  if ('ok' in loaded) return loaded;
  const issues = lintDigest(loaded.digest, loaded.transcript);
  const errors = lintErrors(issues);
  return {
    ok: errors.length === 0,
    action: 'validate',
    slug: input.slug,
    errors,
    warnings: issues.filter((i) => i.severity === 'warning'),
  };
}

// renderToFiles가 읽기와 lint 차단까지 하니 여기서 미리 읽지 않고 결과와 오류만 옮긴다
function handleRender(input: DigestInput, cwd: string): object {
  if (!isValidSlug(input.slug)) return fail('INVALID_SLUG', `slug가 올바르지 않다: ${input.slug}`);
  try {
    const r = renderToFiles(input.slug, {
      repoRoot: resolve(cwd, input.repoRoot ?? '.'),
      inlineFrames: input.inlineFrames,
    });
    return { ok: true, action: 'render', ...r };
  } catch (e) {
    if (e instanceof DigestLintError) {
      return {
        ...fail('RENDER_BLOCKED', `validate 오류 ${e.issues.length}개가 남아 있어 렌더하지 않았다`),
        lintErrors: e.issues,
      };
    }
    if (e instanceof DigestLoadError) return fail(e.code, e.message);
    // lint와 무관한 실패라 validate를 다시 돌려도 안 풀린다
    return fail('RENDER_FAILED', e instanceof Error ? e.message : String(e));
  }
}

function handleProseExtract(input: DigestInput, cwd: string): object {
  const loaded = load(input, cwd);
  if ('ok' in loaded) return loaded;
  const items = extractProse(loaded.digest);
  return { ok: true, action: 'prose_extract', slug: input.slug, items, count: items.length };
}

function handleProseApply(input: DigestInput, cwd: string): object {
  const loaded = load(input, cwd);
  if ('ok' in loaded) return loaded;
  if (!input.items) {
    return fail(
      'ITEMS_REQUIRED',
      'prose_apply에는 prose_extract가 준 path와 hash를 담은 items가 필요하다',
    );
  }
  const { digest, applied, unchanged, warnings } = applyProse(loaded.digest, input.items);
  const reparsed = parseDigest(digest);
  if (!reparsed.ok) {
    return {
      ok: false,
      errors: reparsed.error.issues.map((m) => ({ code: 'APPLY_BROKE_SCHEMA', message: m })),
    };
  }
  const dryRun = input.dryRun === true;
  // 바뀐 게 없으면 다시 쓰지 않는다. 손으로 쓴 원본 꼴이 그대로 남는다
  const saved = !dryRun && applied > 0;
  if (saved) loaded.store.saveDigest(reparsed.value);
  return {
    ok: true,
    action: 'prose_apply',
    slug: input.slug,
    digestPath: loaded.store.digestPath(input.slug),
    dryRun,
    saved,
    applied,
    unchanged,
    warnings,
    lint: lintDigest(reparsed.value, loaded.transcript),
  };
}

export function handleDigestPassthrough(input: DigestInput, cwd: string = process.cwd()): object {
  switch (input.action) {
    case 'validate':
      return handleValidate(input, cwd);
    case 'render':
      return handleRender(input, cwd);
    case 'prose_extract':
      return handleProseExtract(input, cwd);
    case 'prose_apply':
      return handleProseApply(input, cwd);
  }
}
