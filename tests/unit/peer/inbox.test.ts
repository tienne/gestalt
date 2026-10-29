import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeInbox } from '../../../src/peer/inbox.js';

describe('writeInbox', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'peer-inbox-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('소켓에 붙기 전에 실패하면 줄이 들어갔을 수 있다는 표시를 안 단다', async () => {
    const r = await writeInbox(join(dir, 'missing.sock'), 'x');
    expect(r).toEqual({ ok: false, reason: '인박스 소켓에 못 썼어요 (ENOENT)' });
  });
});
