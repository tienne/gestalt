import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAgentMd } from '../../../src/agent/parser.js';

const FIXTURE_PATH = resolve('tests/fixtures/agents/mock-agent/AGENT.md');

describe('parseAgentMd', () => {
  it('parses valid AGENT.md', () => {
    const content = readFileSync(FIXTURE_PATH, 'utf-8');
    const agent = parseAgentMd(content, FIXTURE_PATH);

    expect(agent.frontmatter.name).toBe('mock-agent');
    expect(agent.frontmatter.tier).toBe('standard');
    expect(agent.frontmatter.pipeline).toBe('interview');
    expect(agent.frontmatter.description).toBe('A mock agent for testing');
    expect(agent.frontmatter.model).toBeUndefined();
    expect(agent.frontmatter.escalateTo).toBeUndefined();
    expect(agent.systemPrompt).toContain('mock agent for testing');
    expect(agent.filePath).toBe(FIXTURE_PATH);
  });

  it('parses AGENT.md with optional fields', () => {
    const content = `---
name: custom-agent
tier: frontier
pipeline: evaluate
model: claude-opus-4-20250514
escalateTo: similarity-crystallizer
description: "Custom agent"
---

Custom system prompt.`;
    const agent = parseAgentMd(content, 'test.md');

    expect(agent.frontmatter.model).toBe('claude-opus-4-20250514');
    expect(agent.frontmatter.escalateTo).toBe('similarity-crystallizer');
    expect(agent.frontmatter.tier).toBe('frontier');
    expect(agent.frontmatter.pipeline).toBe('evaluate');
  });

  it('throws on missing required fields', () => {
    const content = `---
name: incomplete
---
No tier or pipeline`;
    expect(() => parseAgentMd(content, 'test.md')).toThrow();
  });

  it('throws on invalid tier value', () => {
    const content = `---
name: bad-tier
tier: ultra
pipeline: interview
description: "Bad tier"
---
Prompt`;
    expect(() => parseAgentMd(content, 'test.md')).toThrow();
  });

  it('throws on invalid pipeline value', () => {
    const content = `---
name: bad-pipeline
tier: standard
pipeline: deploy
description: "Bad pipeline"
---
Prompt`;
    expect(() => parseAgentMd(content, 'test.md')).toThrow();
  });
});
