import { describe, it, expect } from 'vitest';
import {
  AUDIENCES,
  DEFAULT_AUDIENCE,
  PRESETS,
  isAudience,
  parseAudience,
  presetOf,
} from '../../../src/explain/index.js';

describe('대상 프리셋', () => {
  it('기본값은 peer다', () => {
    expect(DEFAULT_AUDIENCE).toBe('peer');
    expect(parseAudience(undefined)).toBe('peer');
  });

  it('모르는 값은 undefined로 돌려준다', () => {
    expect(parseAudience('cto')).toBeUndefined();
    expect(isAudience('cto')).toBe(false);
  });

  it('여섯 값 모두 프리셋이 있다', () => {
    expect(AUDIENCES).toHaveLength(6);
    for (const audience of AUDIENCES) {
      expect(presetOf(audience).audience).toBe(audience);
    }
  });

  it('상한 축은 warn이 abort보다 작다', () => {
    for (const preset of Object.values(PRESETS)) {
      expect(preset.jargon.warn).toBeLessThanOrEqual(preset.jargon.abort);
      expect(preset.sentence.warn).toBeLessThan(preset.sentence.abort);
    }
  });

  it('하한 축인 coverage는 방향이 반대다', () => {
    for (const preset of Object.values(PRESETS)) {
      if (preset.coverage === 'off') continue;
      expect(preset.coverage.warn).toBeGreaterThan(preset.coverage.abort);
    }
  });

  it('용어를 금지한 대상은 핵심어 잔존을 안 잰다', () => {
    const off = AUDIENCES.filter((a) => PRESETS[a].coverage === 'off');
    expect(off).toEqual(['nontech', 'exec', 'outsider']);
  });

  it('용어를 허용한 대상은 전문가일수록 핵심어를 많이 요구한다', () => {
    const warnOf = (audience: (typeof AUDIENCES)[number]): number => {
      const rule = PRESETS[audience].coverage;
      if (rule === 'off') throw new Error(`${audience}는 coverage를 안 잰다`);
      return rule.warn;
    };
    expect(warnOf('peer')).toBeGreaterThan(warnOf('junior'));
    expect(warnOf('junior')).toBeGreaterThan(warnOf('manager'));
  });

  it('비전문가 대상일수록 용어 상한이 낮다', () => {
    expect(PRESETS.peer.jargon.warn).toBeGreaterThan(PRESETS.junior.jargon.warn);
    expect(PRESETS.junior.jargon.warn).toBeGreaterThan(PRESETS.nontech.jargon.warn);
    expect(PRESETS.outsider.jargon.warn).toBe(0);
  });

  it('비유 필수는 nontech와 outsider뿐이다', () => {
    const required = AUDIENCES.filter((a) => PRESETS[a].analogy === 'required');
    expect(required).toEqual(['nontech', 'outsider']);
    expect(PRESETS.junior.analogy).toBe('recommended');
  });

  it('관리자와 경영진은 합니다체다', () => {
    expect(PRESETS.manager.register).toBe('formal');
    expect(PRESETS.exec.register).toBe('formal');
    expect(PRESETS.peer.register).toBe('polite');
  });
});
