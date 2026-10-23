import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractProse } from '../../../src/digest/prose.js';
import { DigestStore } from '../../../src/digest/store.js';
import { handleDigestPassthrough } from '../../../src/mcp/tools/digest-passthrough.js';
import { SLUG, sampleDigest, sampleTranscript } from '../digest/fixture.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seeded(mutate?: (d: ReturnType<typeof sampleDigest>) => void) {
  const repo = resolve('.gestalt-test', `digest-mcp-${randomUUID()}`);
  mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  const store = new DigestStore(repo);
  store.saveTranscript(sampleTranscript());
  const d = sampleDigest();
  mutate?.(d);
  store.saveDigest(d);
  return { repo, store };
}

type Reply = Record<string, unknown> & { ok: boolean; errors?: Array<{ code: string }> };
const call = (input: object, cwd: string) =>
  handleDigestPassthrough(input as Parameters<typeof handleDigestPassthrough>[0], cwd) as Reply;

describe('ges_digest', () => {
  it('validate는 오류와 경고를 나눠 돌려준다', () => {
    const { repo } = seeded((d) => {
      d.report.lead.answer = '**굵게가 안 닫혔다';
    });
    const r = call({ action: 'validate', slug: SLUG }, repo);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      expect.objectContaining({ code: 'UNBALANCED_BOLD', path: 'report.lead.answer' }),
    ]);
  });

  it('validate는 범위 밖 출처를 오류로 잡는다', () => {
    const { repo } = seeded((d) => {
      d.report.sections[0]!.cite = { key: 50, from: 50, to: 50 };
    });
    const r = call({ action: 'validate', slug: SLUG }, repo);
    expect(r.ok).toBe(false);
    expect((r.errors ?? []).map((e) => e.code)).toContain('CITE_OUT_OF_RANGE');
  });

  it('없는 slug와 잘못된 slug는 코드로 알린다', () => {
    const { repo } = seeded();
    expect(call({ action: 'validate', slug: 'nope' }, repo).errors?.[0]?.code).toBe(
      'TRANSCRIPT_NOT_FOUND',
    );
    expect(call({ action: 'validate', slug: '../x' }, repo).errors?.[0]?.code).toBe('INVALID_SLUG');
  });

  it('render는 HTML과 마크다운을 쓰고 lint 오류가 있으면 막는다', () => {
    const { repo, store } = seeded();
    const r = call({ action: 'render', slug: SLUG }, repo);
    expect(r.ok).toBe(true);
    expect(existsSync(store.htmlPath(SLUG))).toBe(true);
    expect(readFileSync(store.mdPath(SLUG), 'utf-8')).toContain('## 1. 코드 레이어 소개');

    const bad = seeded((d) => {
      d.report.sections[0]!.cite = { key: 50, from: 50, to: 50 };
    });
    const blocked = call({ action: 'render', slug: SLUG }, bad.repo);
    expect(blocked.errors?.[0]?.code).toBe('RENDER_BLOCKED');
    expect((blocked.lintErrors as Array<{ code: string }>).map((e) => e.code)).toContain(
      'CITE_OUT_OF_RANGE',
    );
  });

  it('render는 못 읽은 파일과 lint 밖의 실패를 RENDER_BLOCKED와 다른 코드로 알린다', () => {
    const { repo, store } = seeded();
    expect(call({ action: 'render', slug: 'nope' }, repo).errors?.[0]?.code).toBe(
      'TRANSCRIPT_NOT_FOUND',
    );
    expect(call({ action: 'render', slug: '../x' }, repo).errors?.[0]?.code).toBe('INVALID_SLUG');

    // 출력 파일 자리에 폴더가 있으면 쓰기가 실패한다
    mkdirSync(store.htmlPath(SLUG), { recursive: true });
    expect(call({ action: 'render', slug: SLUG }, repo).errors?.[0]?.code).toBe('RENDER_FAILED');
  });

  it('형식이 틀린 transcript.json은 TRANSCRIPT_INVALID로 알리고 옮기지 않는다', () => {
    const { repo, store } = seeded();
    writeFileSync(store.transcriptPath(SLUG), '{');
    expect(call({ action: 'validate', slug: SLUG }, repo).errors?.[0]?.code).toBe(
      'TRANSCRIPT_INVALID',
    );
    expect(existsSync(store.transcriptPath(SLUG))).toBe(true);
  });

  it('prose_extract와 prose_apply로 다듬은 문장을 저장한다. dryRun이면 안 쓴다', () => {
    const { repo, store } = seeded();
    const ex = call({ action: 'prose_extract', slug: SLUG }, repo);
    const items = ex.items as ReturnType<typeof extractProse>;
    const target = items.find((i) => i.path === 'report.lead.answer')!;
    const edit = { ...target, text: '캔버스에서 바로 코드를 다뤄요.' };

    const dry = call({ action: 'prose_apply', slug: SLUG, items: [edit], dryRun: true }, repo);
    expect(dry).toMatchObject({ ok: true, saved: false, applied: 1 });
    expect(store.loadDigest(SLUG)!.report.lead.answer).toBe(target.text);

    const r = call({ action: 'prose_apply', slug: SLUG, items: [edit] }, repo);
    expect(r).toMatchObject({ ok: true, saved: true, applied: 1 });
    expect(store.loadDigest(SLUG)!.report.lead.answer).toBe(edit.text);
  });

  it('prose_apply는 표식이 빠진 항목과 원문이 바뀐 항목을 경고하고 저장하지 않는다', () => {
    const { repo, store } = seeded();
    const items = call({ action: 'prose_extract', slug: SLUG }, repo).items as ReturnType<
      typeof extractProse
    >;
    const bold = items.find((i) => i.path === 'report.lead.takeaway')!;
    const dropped = { ...bold, text: '코드에서 시작한다는 점이 핵심이에요.' };
    const r1 = call({ action: 'prose_apply', slug: SLUG, items: [dropped] }, repo);
    expect(r1).toMatchObject({ ok: true, saved: false, applied: 0 });
    expect(r1.warnings).toEqual([
      expect.objectContaining({ path: bold.path, code: 'MARKER_MISMATCH' }),
    ]);

    const answer = items.find((i) => i.path === 'report.lead.answer')!;
    const stale = { ...answer, text: '다듬은 문장.', hash: 'ffffffffffff' };
    const r2 = call({ action: 'prose_apply', slug: SLUG, items: [stale] }, repo);
    expect(r2).toMatchObject({ ok: true, saved: false, applied: 0 });
    expect(r2.warnings).toEqual([expect.objectContaining({ path: answer.path, code: 'STALE' })]);
    expect(store.loadDigest(SLUG)!.report.lead.answer).toBe(answer.text);
  });

  it('prose_apply에 items가 없으면 거절한다', () => {
    const { repo } = seeded();
    expect(call({ action: 'prose_apply', slug: SLUG }, repo).errors?.[0]?.code).toBe(
      'ITEMS_REQUIRED',
    );
  });

  it('digest.json이 JSON이 아니면 DIGEST_NOT_JSON', () => {
    const { repo, store } = seeded();
    writeFileSync(store.digestPath(SLUG), '{');
    expect(call({ action: 'validate', slug: SLUG }, repo).errors?.[0]?.code).toBe(
      'DIGEST_NOT_JSON',
    );
  });
});
