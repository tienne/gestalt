import { describe, it, expect } from 'vitest';
import { SpecTemplateRegistry } from '../../../src/spec/templates.js';

describe('SpecTemplateRegistry', () => {
  const registry = new SpecTemplateRegistry();

  it('lists 3 built-in templates', () => {
    const templates = registry.list();
    expect(templates).toHaveLength(3);
    const ids = templates.map((t) => t.id);
    expect(ids).toContain('rest-api');
    expect(ids).toContain('react-dashboard');
    expect(ids).toContain('cli-tool');
  });

  it('returns template by id', () => {
    const tmpl = registry.get('rest-api');
    expect(tmpl).toBeDefined();
    expect(tmpl!.id).toBe('rest-api');
    expect(tmpl!.baseConstraints.length).toBeGreaterThan(0);
    expect(tmpl!.baseAcceptanceCriteria.length).toBeGreaterThan(0);
  });

  it('returns undefined for unknown id', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('has() returns true for known ids', () => {
    expect(registry.has('cli-tool')).toBe(true);
    expect(registry.has('unknown')).toBe(false);
  });

  it('buildTemplateContext returns markdown string for valid id', () => {
    const ctx = registry.buildTemplateContext('rest-api');
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('REST API');
    expect(ctx).toContain('Template Base Constraints');
    expect(ctx).toContain('Template Base Acceptance Criteria');
  });

  it('buildTemplateContext returns null for unknown id', () => {
    expect(registry.buildTemplateContext('unknown')).toBeNull();
  });
});
