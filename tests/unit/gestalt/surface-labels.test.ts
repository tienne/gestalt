import { describe, it, expect } from 'vitest';
import { GestaltPrinciple } from '../../../src/core/types.js';
import {
  getStageLabel,
  getAgentDisplayName,
  toDisplayAgentNames,
  getConsistencyHint,
  sanitizeSurfaceContext,
  BANNED_SURFACE_TERMS,
} from '../../../src/gestalt/surface-labels.js';

describe('surface-labels', () => {
  describe('getStageLabel', () => {
    it('원리마다 원리 이름 없는 한국어 단계 문구를 돌려준다', () => {
      const labels = getAllPrinciples().map((p) => getStageLabel(p, 'ko'));
      for (const label of labels) {
        expect(label.length).toBeGreaterThan(0);
        assertNoBannedTerm(label);
      }
    });

    it('영어 단계 문구도 원리 이름을 담지 않는다', () => {
      for (const p of getAllPrinciples()) {
        assertNoBannedTerm(getStageLabel(p, 'en'));
      }
    });

    it('알 수 없는 값은 중립적 기본 문구로 대체한다', () => {
      expect(getStageLabel('next', 'ko')).toBe('다음 단계');
      expect(getStageLabel('unknown', 'en')).toBe('Next step');
    });
  });

  describe('getAgentDisplayName / toDisplayAgentNames', () => {
    it('내부 에이전트 식별자를 원리 없는 중립 이름으로 바꾼다', () => {
      const raw = ['closure-completer', 'ground-mapper', 'similarity-crystallizer'];
      const display = toDisplayAgentNames(raw, 'ko');
      expect(display).not.toContain('closure-completer');
      for (const name of display) assertNoBannedTerm(name);
    });

    it('매핑에 없는 이름은 그대로 돌려준다', () => {
      expect(getAgentDisplayName('unknown-agent')).toBe('unknown-agent');
    });
  });

  describe('getConsistencyHint', () => {
    it('Similarity 용어 없이 일관성 힌트를 준다', () => {
      assertNoBannedTerm(getConsistencyHint('ko'));
      assertNoBannedTerm(getConsistencyHint('en'));
    });
  });

  describe('sanitizeSurfaceContext', () => {
    it('currentPrinciple를 currentStage로 치환하고 원본 필드를 지운다', () => {
      const out = sanitizeSurfaceContext({
        currentPrinciple: 'closure',
        principleStrategy: 'Identify missing requirements (Closure)',
        phase: 'early',
      });
      expect(out.currentPrinciple).toBeUndefined();
      expect(out.principleStrategy).toBeUndefined();
      expect(typeof out.currentStage).toBe('string');
      assertNoBannedTerm(String(out.currentStage));
    });

    it('activeAgents를 중립 이름으로 매핑한다', () => {
      const out = sanitizeSurfaceContext({
        activeAgents: ['closure-completer', 'ground-mapper'],
      });
      for (const name of out.activeAgents as string[]) assertNoBannedTerm(name);
    });

    it('allRounds[].gestaltFocus를 stage로 치환한다', () => {
      const out = sanitizeSurfaceContext({
        allRounds: [{ roundNumber: 1, question: 'q', response: 'a', gestaltFocus: 'proximity' }],
      });
      const round = (out.allRounds as Array<Record<string, unknown>>)[0]!;
      expect(round.gestaltFocus).toBeUndefined();
      expect(typeof round.stage).toBe('string');
      assertNoBannedTerm(String(round.stage));
    });

    it('null/undefined는 그대로 통과시킨다', () => {
      expect(sanitizeSurfaceContext(null)).toBeNull();
      expect(sanitizeSurfaceContext(undefined)).toBeUndefined();
    });
  });

  describe('BANNED_SURFACE_TERMS', () => {
    it('원리 이름 6종을 담는다', () => {
      expect(BANNED_SURFACE_TERMS).toContain('closure');
      expect(BANNED_SURFACE_TERMS).toContain('gestalt');
      expect(BANNED_SURFACE_TERMS).toContain('figure_ground');
    });
  });
});

// ─── helpers ────────────────────────────────────────────────────

function getAllPrinciples(): GestaltPrinciple[] {
  return [
    GestaltPrinciple.CLOSURE,
    GestaltPrinciple.PROXIMITY,
    GestaltPrinciple.SIMILARITY,
    GestaltPrinciple.FIGURE_GROUND,
    GestaltPrinciple.CONTINUITY,
  ];
}

function assertNoBannedTerm(text: string): void {
  const lower = text.toLowerCase();
  for (const term of BANNED_SURFACE_TERMS) {
    expect(lower).not.toContain(term);
  }
}
