import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';

const FIXTURE_PATH = resolve('tests/fixtures/skills/mock-skill/SKILL.md');

describe('parseSkillMd', () => {
  it('parses valid SKILL.md', () => {
    const content = readFileSync(FIXTURE_PATH, 'utf-8');
    const skill = parseSkillMd(content, FIXTURE_PATH);

    expect(skill.frontmatter.name).toBe('mock-skill');
    expect(skill.frontmatter.version).toBe('1.0.0');
    expect(skill.frontmatter.description).toBe('A mock skill for testing');
    expect(skill.frontmatter.triggers).toEqual(['test']);
    expect(skill.frontmatter.inputs['param1']).toEqual({
      type: 'string',
      required: true,
      description: 'A required parameter',
    });
    expect(skill.frontmatter.outputs).toEqual(['result']);
    expect(skill.body).toContain('Mock Skill');
    expect(skill.filePath).toBe(FIXTURE_PATH);
  });

  it('throws on missing name', () => {
    const content = `---
version: "1.0.0"
---
No name`;
    expect(() => parseSkillMd(content, 'test.md')).toThrow();
  });

  it('applies defaults for optional fields', () => {
    const content = `---
name: minimal
---
Minimal skill`;
    const skill = parseSkillMd(content, 'test.md');
    expect(skill.frontmatter.version).toBe('1.0.0');
    expect(skill.frontmatter.triggers).toEqual([]);
    expect(skill.frontmatter.inputs).toEqual({});
    expect(skill.frontmatter.outputs).toEqual([]);
  });
});
