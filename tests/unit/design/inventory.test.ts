import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolveInventory } from '../../../src/design/inventory.js';
import { runDesignCheck } from '../../../src/design/run.js';
import type { RuleSource } from '../../../src/core/config.js';

function source(over: Partial<RuleSource> = {}): RuleSource {
  return {
    id: 'ds',
    kind: 'file',
    ref: 'components',
    scope: [],
    trust: 'convention',
    onMissing: 'warn',
    importPattern: 'from [\'"]@acme/design',
    ...over,
  };
}

describe('resolveInventory', () => {
  let dir: string;

  beforeEach(() => {
    dir = join('.gestalt-test', `design-${randomUUID()}`);
    mkdirSync(join(dir, 'components', 'bottom-sheet'), { recursive: true });
    mkdirSync(join(dir, 'components', 'tooltip'), { recursive: true });
    // 밑줄로 시작하는 건 내부용이라 제공 목록이 아니다
    mkdirSync(join(dir, 'components', '_private'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('디렉토리 이름을 컴포넌트 목록으로 읽는다', () => {
    const r = resolveInventory([source()], { cwd: dir });
    expect(r.components.sort()).toEqual(['bottom-sheet', 'tooltip']);
    expect(r.notMeasured).toEqual([]);
    expect(r.basis[0]).toContain('ds');
  });

  it('목록 파일도 읽는다', () => {
    writeFileSync(join(dir, 'list.txt'), '# 주석\nbutton\nchip\n\n');
    const r = resolveInventory([source({ ref: 'list.txt' })], { cwd: dir });
    expect(r.components).toEqual(['button', 'chip']);
  });

  // MCP 도구는 클라이언트가 부르는 것이라 CLI 프로세스에는 그 경로가 없다.
  // 못 읽는 걸 읽은 척하면 기준 없이 만든 결과가 통과로 보고된다
  it('MCP 소스는 CLI에서 못 읽고 그 사실을 남긴다', () => {
    const r = resolveInventory([source({ kind: 'mcp', ref: 'mcp__plate__x' })], { cwd: dir });
    expect(r.components).toEqual([]);
    expect(r.notMeasured[0]).toContain('CLI에서 못 읽는다');
  });

  it('onMissing이 skip이면 못 읽어도 남기지 않는다', () => {
    const r = resolveInventory([source({ kind: 'mcp', ref: 'x', onMissing: 'skip' })], {
      cwd: dir,
    });
    expect(r.notMeasured).toEqual([]);
  });

  it('delegate 소스는 목록을 주는 자리가 아니다', () => {
    const r = resolveInventory([source({ trust: 'delegate' })], { cwd: dir });
    expect(r.components).toEqual([]);
    expect(r.notMeasured).toEqual([]);
  });

  it('scope가 이번 작업과 안 맞으면 읽지 않는다', () => {
    const s = source({ scope: ['ui'] });
    expect(resolveInventory([s], { cwd: dir, tags: ['backend'] }).components).toEqual([]);
    expect(resolveInventory([s], { cwd: dir, tags: ['ui'] }).components).toHaveLength(2);
  });

  it('경로가 없으면 이유를 남긴다', () => {
    const r = resolveInventory([source({ ref: 'nope' })], { cwd: dir });
    expect(r.notMeasured[0]).toContain('경로 없음');
  });
});

describe('runDesignCheck', () => {
  let dir: string;

  beforeEach(() => {
    dir = join('.gestalt-test', `run-${randomUUID()}`);
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'components', 'tooltip'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('시스템을 쓰는 파일에서 샌 값을 막는다', () => {
    writeFileSync(
      join(dir, 'src', 'Card.tsx'),
      `import { Box } from '@acme/design';\nexport const C = () => <Box style={{ padding: '13px' }} />;\n`,
    );
    const r = runDesignCheck({ repoRoot: dir, ruleSources: [source()] });
    expect(r.verdict).toBe('abort');
    expect(r.counts.leakFindings).toBe(1);
  });

  it('시스템을 안 쓰는 파일의 값은 누수로 세지 않는다', () => {
    writeFileSync(
      join(dir, 'src', 'Plain.tsx'),
      `export const P = () => <div style={{ padding: '13px' }} />;\n`,
    );
    const r = runDesignCheck({ repoRoot: dir, ruleSources: [source()] });
    expect(r.counts.leakFindings).toBe(0);
    expect(r.verdict).toBe('pass');
  });

  // 목록이 비면 중복이 0건으로 나와 깨끗한 것처럼 보인다
  it('제공 목록을 못 읽으면 통과로 보고하지 않는다', () => {
    const r = runDesignCheck({ repoRoot: dir, ruleSources: [source({ ref: 'nope' })] });
    expect(r.verdict).toBe('abort');
    expect(r.notMeasured.join()).toContain('중복 컴포넌트');
  });

  // 기본값을 두면 다른 조직 레포에서 누수가 0건으로 나와 조용히 통과한다
  it('import 패턴 선언이 없으면 누수를 재지 못했다고 남긴다', () => {
    writeFileSync(
      join(dir, 'src', 'Card.tsx'),
      `import { Box } from '@acme/design';\nexport const C = () => <Box style={{ padding: '13px' }} />;\n`,
    );
    const noPattern = { ...source(), importPattern: undefined };
    const r = runDesignCheck({ repoRoot: dir, ruleSources: [noPattern] });
    expect(r.counts.unknown).toBeGreaterThan(0);
    expect(r.counts.leakFindings).toBe(0);
    expect(r.notMeasured.join()).toContain('import 패턴');
    expect(r.verdict).toBe('abort');
  });

  it('세션이 넘긴 목록이 있으면 MCP 소스를 못 읽었다고 세지 않는다', () => {
    const r = runDesignCheck({
      repoRoot: dir,
      ruleSources: [source({ id: 'ds-mcp', kind: 'mcp', ref: 'mcp__ds__list' })],
      providedComponents: [{ id: 'ds-mcp', components: ['tooltip'] }],
    });
    expect(r.notMeasured).toEqual([]);
    expect(r.basis.join()).toContain('세션이 읽어 넘김');
  });
});
