import { describe, it, expect } from 'vitest';
import { parseSkillMd } from '../src/skills/parser.js';
import { SkillParseError } from '../src/core/errors.js';

describe('parseSkillMd', () => {
  it('parses valid SKILL.md with full frontmatter', () => {
    const content = `---
name: test-skill
version: "1.0.0"
description: A test skill
triggers:
  - test
  - demo
inputs:
  topic:
    type: string
    required: true
    description: The topic
outputs:
  - result
---
This is the skill body.
`;

    const skill = parseSkillMd(content, 'test.md');
    expect(skill.frontmatter.name).toBe('test-skill');
    expect(skill.frontmatter.version).toBe('1.0.0');
    expect(skill.frontmatter.triggers).toEqual(['test', 'demo']);
    expect(skill.frontmatter.inputs['topic']!.required).toBe(true);
    expect(skill.frontmatter.outputs).toEqual(['result']);
    expect(skill.body).toBe('This is the skill body.');
    expect(skill.filePath).toBe('test.md');
  });

  it('applies defaults for optional frontmatter fields', () => {
    const content = `---
name: minimal
---
Body text.
`;

    const skill = parseSkillMd(content, 'minimal.md');
    expect(skill.frontmatter.name).toBe('minimal');
    expect(skill.frontmatter.version).toBe('1.0.0');
    expect(skill.frontmatter.triggers).toEqual([]);
    expect(skill.frontmatter.outputs).toEqual([]);
  });

  it('throws SkillParseError for missing name', () => {
    const content = `---
version: "1.0.0"
---
No name.
`;

    expect(() => parseSkillMd(content, 'bad.md')).toThrow(SkillParseError);
  });

  it('throws SkillParseError for content without name', () => {
    // gray-matter parses this as body with empty frontmatter, triggering name validation
    expect(() => parseSkillMd('not valid frontmatter at all {{{{', 'broken.md')).toThrow(SkillParseError);
  });
});
