import { describe, it, expect } from 'vitest';
import {
  REFERENCE_CANDIDATE_KINDS,
  IDENTIFIER_KINDS,
  CHANGE_TYPES,
  EXTRACTED_BY_TYPES,
  RESOLUTION_STATUSES,
  DISCOVERED_BY_TYPES,
  SEARCH_BACKEND_KINDS,
  PR_STATES,
  FOUND_BY_TYPES,
  CONFIRMATION_TYPES,
  SINGLE_STATE_VALUES,
  VERDICT_TYPES,
  USER_CHOICE_TYPES,
  POSTED_EVENT_TYPES,
  EXPLICIT_INSTRUCTION_SCOPES,
  GATE_DECISIONS,
  FAKE_REPO_SCENARIOS,
  PR_SET_TYPES,
  USER_LABEL_TYPES,
} from '../../../src/harness-review/types.js';

describe('harness-review types', () => {
  describe('REFERENCE_CANDIDATE_KINDS', () => {
    it('should have 5 kinds', () => {
      expect(REFERENCE_CANDIDATE_KINDS.length).toBe(5);
    });

    it('should include selfContamination', () => {
      expect(REFERENCE_CANDIDATE_KINDS).toContain('selfContamination');
    });

    it('should include knowledgeDoc', () => {
      expect(REFERENCE_CANDIDATE_KINDS).toContain('knowledgeDoc');
    });
  });

  describe('IDENTIFIER_KINDS', () => {
    it('should have 10 kinds', () => {
      expect(IDENTIFIER_KINDS.length).toBe(10);
    });

    it('should include path', () => {
      expect(IDENTIFIER_KINDS).toContain('path');
    });

    it('should include mcpToolName', () => {
      expect(IDENTIFIER_KINDS).toContain('mcpToolName');
    });
  });

  describe('CHANGE_TYPES', () => {
    it('should have 3 types', () => {
      expect(CHANGE_TYPES.length).toBe(3);
    });

    it('should include removed', () => {
      expect(CHANGE_TYPES).toContain('removed');
    });

    it('should include modified', () => {
      expect(CHANGE_TYPES).toContain('modified');
    });
  });

  describe('EXTRACTED_BY_TYPES', () => {
    it('should have 2 types', () => {
      expect(EXTRACTED_BY_TYPES.length).toBe(2);
    });

    it('should include pattern', () => {
      expect(EXTRACTED_BY_TYPES).toContain('pattern');
    });

    it('should include llm', () => {
      expect(EXTRACTED_BY_TYPES).toContain('llm');
    });
  });

  describe('RESOLUTION_STATUSES', () => {
    it('should have 3 statuses', () => {
      expect(RESOLUTION_STATUSES.length).toBe(3);
    });

    it('should include single', () => {
      expect(RESOLUTION_STATUSES).toContain('single');
    });

    it('should include none', () => {
      expect(RESOLUTION_STATUSES).toContain('none');
    });
  });

  describe('DISCOVERED_BY_TYPES', () => {
    it('should have 3 types', () => {
      expect(DISCOVERED_BY_TYPES.length).toBe(3);
    });

    it('should include forwardMention', () => {
      expect(DISCOVERED_BY_TYPES).toContain('forwardMention');
    });

    it('should include config', () => {
      expect(DISCOVERED_BY_TYPES).toContain('config');
    });
  });

  describe('SEARCH_BACKEND_KINDS', () => {
    it('should have 2 kinds', () => {
      expect(SEARCH_BACKEND_KINDS.length).toBe(2);
    });

    it('should include githubSearch', () => {
      expect(SEARCH_BACKEND_KINDS).toContain('githubSearch');
    });

    it('should include localClone', () => {
      expect(SEARCH_BACKEND_KINDS).toContain('localClone');
    });
  });

  describe('PR_STATES', () => {
    it('should have 3 states', () => {
      expect(PR_STATES.length).toBe(3);
    });

    it('should include open', () => {
      expect(PR_STATES).toContain('open');
    });

    it('should include merged', () => {
      expect(PR_STATES).toContain('merged');
    });
  });

  describe('FOUND_BY_TYPES', () => {
    it('should have 4 types', () => {
      expect(FOUND_BY_TYPES.length).toBe(4);
    });

    it('should include bodyLink', () => {
      expect(FOUND_BY_TYPES).toContain('bodyLink');
    });

    it('should include sameAuthorNearby', () => {
      expect(FOUND_BY_TYPES).toContain('sameAuthorNearby');
    });
  });

  describe('CONFIRMATION_TYPES', () => {
    it('should have 3 types', () => {
      expect(CONFIRMATION_TYPES.length).toBe(3);
    });

    it('should include confirmed', () => {
      expect(CONFIRMATION_TYPES).toContain('confirmed');
    });

    it('should include needsAuthorAnswer', () => {
      expect(CONFIRMATION_TYPES).toContain('needsAuthorAnswer');
    });
  });

  describe('SINGLE_STATE_VALUES', () => {
    it('should have 2 values', () => {
      expect(SINGLE_STATE_VALUES.length).toBe(2);
    });

    it('should include ok', () => {
      expect(SINGLE_STATE_VALUES).toContain('ok');
    });

    it('should include broken', () => {
      expect(SINGLE_STATE_VALUES).toContain('broken');
    });
  });

  describe('VERDICT_TYPES', () => {
    it('should have 3 types', () => {
      expect(VERDICT_TYPES.length).toBe(3);
    });

    it('should include defect', () => {
      expect(VERDICT_TYPES).toContain('defect');
    });

    it('should include relatedRemovesUsed', () => {
      expect(VERDICT_TYPES).toContain('relatedRemovesUsed');
    });
  });

  describe('USER_CHOICE_TYPES', () => {
    it('should have 2 types', () => {
      expect(USER_CHOICE_TYPES.length).toBe(2);
    });

    it('should include proceedWithoutRefs', () => {
      expect(USER_CHOICE_TYPES).toContain('proceedWithoutRefs');
    });

    it('should include wait', () => {
      expect(USER_CHOICE_TYPES).toContain('wait');
    });
  });

  describe('POSTED_EVENT_TYPES', () => {
    it('should have 3 types', () => {
      expect(POSTED_EVENT_TYPES.length).toBe(3);
    });

    it('should include APPROVE', () => {
      expect(POSTED_EVENT_TYPES).toContain('APPROVE');
    });

    it('should include REQUEST_CHANGES', () => {
      expect(POSTED_EVENT_TYPES).toContain('REQUEST_CHANGES');
    });
  });

  describe('EXPLICIT_INSTRUCTION_SCOPES', () => {
    it('should have 3 scopes', () => {
      expect(EXPLICIT_INSTRUCTION_SCOPES.length).toBe(3);
    });

    it('should include precondition', () => {
      expect(EXPLICIT_INSTRUCTION_SCOPES).toContain('precondition');
    });

    it('should include thisRound', () => {
      expect(EXPLICIT_INSTRUCTION_SCOPES).toContain('thisRound');
    });
  });

  describe('GATE_DECISIONS', () => {
    it('should have 2 decisions', () => {
      expect(GATE_DECISIONS.length).toBe(2);
    });

    it('should include allow', () => {
      expect(GATE_DECISIONS).toContain('allow');
    });

    it('should include block', () => {
      expect(GATE_DECISIONS).toContain('block');
    });
  });

  describe('FAKE_REPO_SCENARIOS', () => {
    it('should have 6 scenarios', () => {
      expect(FAKE_REPO_SCENARIOS.length).toBe(6);
    });

    it('should include placeholderPerFile', () => {
      expect(FAKE_REPO_SCENARIOS).toContain('placeholderPerFile');
    });

    it('should include noRemote', () => {
      expect(FAKE_REPO_SCENARIOS).toContain('noRemote');
    });
  });

  describe('PR_SET_TYPES', () => {
    it('should have 2 types', () => {
      expect(PR_SET_TYPES.length).toBe(2);
    });

    it('should include fixFollowed', () => {
      expect(PR_SET_TYPES).toContain('fixFollowed');
    });

    it('should include noFixFollowed', () => {
      expect(PR_SET_TYPES).toContain('noFixFollowed');
    });
  });

  describe('USER_LABEL_TYPES', () => {
    it('should have 2 types', () => {
      expect(USER_LABEL_TYPES.length).toBe(2);
    });

    it('should include correct', () => {
      expect(USER_LABEL_TYPES).toContain('correct');
    });

    it('should include incorrect', () => {
      expect(USER_LABEL_TYPES).toContain('incorrect');
    });
  });
});
