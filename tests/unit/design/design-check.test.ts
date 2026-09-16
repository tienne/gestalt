import { describe, it, expect } from 'vitest';
import { detectBypasses, styleBypasses, cssBypasses } from '../../../src/design/detectors.js';
import { zoneOf } from '../../../src/design/scope.js';
import { findDuplicates } from '../../../src/design/duplicates.js';
import { judge, exitCodeOf } from '../../../src/design/check.js';
import { componentNameOf, normalizeName } from '../../../src/design/tokens.js';

describe('detectors — 타입이 막는 건 안 잡는다', () => {
  it('디자인 시스템 props는 걸지 않는다', () => {
    // padding="md"는 Sprinkles 타입이 이미 강제한다. 여기서 또 잡으면 중복이다
    expect(styleBypasses('<Box padding="md" borderRadius="lg" />')).toEqual([]);
  });

  it('style prop에 샌 길이값을 잡는다', () => {
    const hits = styleBypasses(`<Box padding="md" style={{ marginLeft: '4px' }} />`);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rule).toBe('style-length');
  });

  it('단위 없는 숫자도 잡는다 — React가 px로 넣는다', () => {
    expect(styleBypasses('<div style={{ gap: 2 }} />')[0]?.rule).toBe('style-length');
  });

  it('style prop에 샌 색상을 잡는다', () => {
    expect(styleBypasses(`<div style={{ color: '#626262' }} />`)[0]?.rule).toBe('style-color');
  });
});

describe('detectors — 고칠 수 없는 값은 세지 않는다', () => {
  it('0과 100%는 어느 토큰도 대신하지 못한다', () => {
    expect(styleBypasses('<div style={{ padding: 0, width: "100%" }} />')).toEqual([]);
  });

  it('calc와 translate 안의 값은 토큰으로 못 바꾼다', () => {
    expect(styleBypasses('<div style={{ width: "calc(100% - 16px)" }} />')).toEqual([]);
    expect(styleBypasses('<div style={{ top: "translateY(-50%)" }} />')).toEqual([]);
  });

  // 실제 레포에서 나온 오탐이다. 블록을 통째로 보면 길이값이 한 줄만 있어도
  // 무관한 줄이 리포트에 인용된다
  it('길이와 무관한 프로퍼티는 같은 블록에서도 안 걸린다', () => {
    const src = `<div style={{ justifyContent: w < s ? 'center' : 'flex-start', padding: '4px' }} />`;
    const hits = styleBypasses(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sample).toContain('padding');
    expect(hits[0]!.sample).not.toContain('justifyContent');
  });

  it('CSS에서 z-index와 line-height는 길이 자리가 아니다', () => {
    expect(cssBypasses('  z-index: 100;\n  line-height: 20px;')).toEqual([]);
  });
});

describe('scope — 고칠 수 있는 것만 본다', () => {
  const uses = `import { Box } from '@catchtable/plate-recipe';`;

  it('디자인 시스템을 쓰면 inside다', () => {
    expect(zoneOf('src/Card.tsx', uses)).toBe('inside');
  });

  it('안 쓰면 outside — 미채택이지 누수가 아니다', () => {
    expect(zoneOf('src/Card.tsx', 'export const Card = () => null;')).toBe('outside');
  });

  it('스토리와 테스트는 일부러 하드코딩한다', () => {
    expect(zoneOf('src/Card.stories.tsx', uses)).toBe('excluded');
    expect(zoneOf('src/Card.test.tsx', uses)).toBe('excluded');
    expect(zoneOf('packages/ui/.storybook/preview.tsx', uses)).toBe('excluded');
  });

  it('패키지 이름은 주입받는다 — 게슈탈트가 특정 조직 이름을 갖고 있으면 안 된다', () => {
    const src = `import { Stack } from '@acme/design';`;
    expect(zoneOf('src/A.tsx', src)).toBe('outside');
    expect(zoneOf('src/A.tsx', src, { dsImport: /@acme\/design/ })).toBe('inside');
  });
});

describe('duplicates — 이름만으로 판정하지 않는다', () => {
  it('시스템에 있는 이름을 새로 만들면 잡는다', () => {
    const hits = findDuplicates(
      ['tooltip', 'button'],
      [{ filePath: 'src/ui/Tooltip.tsx', usesDesignSystem: false }],
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.provided).toBe('tooltip');
  });

  it('시스템을 쓰는 같은 이름은 래퍼라 중복이 아니다', () => {
    const hits = findDuplicates(
      ['tooltip'],
      [{ filePath: 'src/ui/Tooltip.tsx', usesDesignSystem: true }],
    );
    expect(hits).toEqual([]);
  });

  it('케밥과 파스칼이 같은 것을 가리킨다', () => {
    expect(normalizeName('bottom-sheet')).toBe(normalizeName('BottomSheet'));
  });

  it('같은 이름이 여러 곳이면 몇 곳인지 센다', () => {
    const hits = findDuplicates(
      ['tooltip'],
      [
        { filePath: 'a/Tooltip.tsx', usesDesignSystem: false },
        { filePath: 'b/Tooltip.tsx', usesDesignSystem: false },
        { filePath: 'c/Tooltip.tsx', usesDesignSystem: false },
      ],
    );
    expect(hits).toHaveLength(3);
    expect(hits[0]!.siblings).toBe(3);
  });

  it('index와 훅 파일은 컴포넌트 이름이 아니다', () => {
    expect(componentNameOf('src/ui/index.tsx')).toBeNull();
    expect(componentNameOf('src/useToggle.ts')).toBeNull();
    expect(componentNameOf('src/ui/Tooltip.tsx')).toBe('Tooltip');
  });
});

describe('judge — 막는 것과 알리는 것을 가른다', () => {
  const leak = {
    filePath: 'src/A.tsx',
    zone: 'inside' as const,
    bypasses: [{ rule: 'style-length' as const, line: 3, sample: 'padding: 13px' }],
  };

  it('누수가 있으면 막는다', () => {
    const r = judge({ files: [leak], duplicates: [], basis: ['plate'] });
    expect(r.verdict).toBe('abort');
    expect(exitCodeOf(r)).toBe(2);
  });

  it('중복만 있으면 막지 않는다 — 이 변경에서 끝낼 수 없는 일이다', () => {
    const r = judge({
      files: [],
      duplicates: [
        { filePath: 'a/Tooltip.tsx', name: 'Tooltip', provided: 'tooltip', siblings: 1 },
      ],
      basis: ['plate'],
    });
    expect(r.verdict).toBe('pass');
    expect(r.counts.duplicateFindings).toBe(1);
  });

  it('바깥 구역 값은 누수로 세지 않는다', () => {
    const outside = { ...leak, zone: 'outside' as const };
    const r = judge({ files: [outside], duplicates: [], basis: ['plate'] });
    expect(r.verdict).toBe('pass');
    expect(r.counts.leakFindings).toBe(0);
  });

  // 못 잰 것과 재서 깨끗한 것이 겉보기에 같으면 검사가 조용히 사라진다
  it('기준을 못 읽었으면 통과로 보고하지 않는다', () => {
    const r = judge({ files: [], duplicates: [], basis: [], notMeasured: ['plate MCP 못 붙음'] });
    expect(r.verdict).toBe('abort');
  });
});

describe('detectBypasses — 파일 종류를 가린다', () => {
  it('스타일시트는 CSS 규칙만 본다', () => {
    const hits = detectBypasses('.a { padding: 13px; }', 'a.css');
    expect(hits.every((h) => h.rule.startsWith('raw-css'))).toBe(true);
  });
});
