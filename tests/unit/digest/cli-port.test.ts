import { describe, expect, it } from 'vitest';
import { parsePort } from '../../../src/cli/commands/digest.js';

describe('digest serve --port', () => {
  it('1~65535 정수만 받는다', () => {
    expect(parsePort('8080')).toBe(8080);
    for (const bad of ['abc', '8080.5', '0', '99999', '-1', '']) {
      expect(() => parsePort(bad)).toThrow(/1~65535 정수/);
    }
  });
});
