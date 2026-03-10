import { describe, it, expect } from 'vitest';
import { SkillRegistry } from '../../../src/skills/registry.js';
import { resolve } from 'node:path';

const FIXTURE_SKILLS_DIR = resolve('tests/fixtures/skills');

describe('SkillRegistry', () => {
  it('loads skills from directory', () => {
    const registry = new SkillRegistry(FIXTURE_SKILLS_DIR);
    registry.loadAll();

    expect(registry.has('mock-skill')).toBe(true);
    expect(registry.getAll()).toHaveLength(1);
  });

  it('retrieves a skill by name', () => {
    const registry = new SkillRegistry(FIXTURE_SKILLS_DIR);
    registry.loadAll();

    const skill = registry.get('mock-skill');
    expect(skill).toBeDefined();
    expect(skill!.frontmatter.name).toBe('mock-skill');
  });

  it('returns undefined for unknown skill', () => {
    const registry = new SkillRegistry(FIXTURE_SKILLS_DIR);
    registry.loadAll();

    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('handles non-existent directory gracefully', () => {
    const registry = new SkillRegistry('/nonexistent/path');
    registry.loadAll();
    expect(registry.getAll()).toHaveLength(0);
  });
});
