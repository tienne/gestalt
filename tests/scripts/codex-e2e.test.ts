import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  E2EFailure,
  judgeEvidence,
  optedIn,
  runBounded,
  runE2E,
  timeoutMs,
} from '../../scripts/lib/codex-e2e.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const skill = '/fixture/plugin/skills/interview/SKILL.md';
const source = '# Interview Skill\nactual skill body';
function evidenceFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gestalt-evidence-'));
  dirs.push(dir);
  const path = join(dir, 'events.db');
  const db = new Database(path);
  db.exec(
    'CREATE TABLE events (aggregate_type TEXT, aggregate_id TEXT, event_type TEXT, payload TEXT)',
  );
  const add = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)');
  for (const [type, payload] of [
    ['interview.session.started', { topic: 'notes' }],
    ['interview.question.asked', { question: 'Which fields?' }],
    ['interview.response.recorded', { response: 'Each note has a title and a body.' }],
  ] as const)
    add.run('interview', '11111111-1111-4111-8111-111111111111', type, JSON.stringify(payload));
  db.close();
  const call = (tool: string, args: object, reply: object) => ({
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'gestalt',
      tool,
      arguments: args,
      status: 'completed',
      result: { content: [{ type: 'text', text: JSON.stringify(reply) }], isError: false },
    },
  });
  const events = [
    {
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: `/bin/cat ${skill}`,
        exit_code: 0,
        aggregated_output: source,
      },
    },
    call(
      'ges_interview',
      { action: 'start', topic: 'notes' },
      { status: 'started', sessionId: '11111111-1111-4111-8111-111111111111' },
    ),
    call(
      'ges_interview',
      { action: 'respond', sessionId: '11111111-1111-4111-8111-111111111111' },
      { status: 'in_progress', sessionId: '11111111-1111-4111-8111-111111111111' },
    ),
    call(
      'ges_status',
      { sessionId: '11111111-1111-4111-8111-111111111111' },
      { session: { sessionId: '11111111-1111-4111-8111-111111111111', answeredRounds: 1 } },
    ),
    { type: 'turn.completed', usage: { output_tokens: 35 } },
  ];
  return { path, events, stdout: () => events.map((e) => JSON.stringify(e)).join('\n') };
}

describe('Codex E2E policy (no inference)', () => {
  it('requires exact explicit opt-in and skips without probing unavailable prerequisites', async () => {
    for (const flag of [undefined, '', 'true', '0'])
      expect(optedIn({ GESTALT_CODEX_E2E: flag })).toBe(false);
    expect(optedIn({ GESTALT_CODEX_E2E: '1' })).toBe(true);
    expect(await runE2E('/missing', { GESTALT_CODEX_E2E_BIN: '/missing' })).toMatchObject({
      status: 'skipped',
    });
  });
  it('fails rather than skips when opted-in prerequisites are absent', async () => {
    await expect(
      runE2E(process.cwd(), { GESTALT_CODEX_E2E: '1', GESTALT_CODEX_E2E_BIN: '/missing-codex' }),
    ).rejects.toMatchObject({ reason: 'prerequisite' });
  });
  it('classifies authentication and inference failures after opt-in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gestalt-cli-policy-'));
    dirs.push(dir);
    const cli = join(dir, 'codex');
    const script = (authExit: number) => `#!/bin/sh
case "$1" in
  --version) echo 'codex-cli 0.test';;
  --help) echo '--no-daemon';;
  exec) echo '--ignore-user-config --ephemeral --json --sandbox';;
  login) exit ${authExit};;
  *) exit 7;;
esac
`;
    writeFileSync(cli, script(1));
    chmodSync(cli, 0o700);
    const env = { GESTALT_CODEX_E2E: '1', GESTALT_CODEX_E2E_BIN: cli };
    await expect(runE2E(process.cwd(), env)).rejects.toMatchObject({ reason: 'auth' });
    writeFileSync(cli, script(0));
    await expect(runE2E(process.cwd(), env)).rejects.toMatchObject({ reason: 'inference' });
  });
  it('bounds timeouts and rejects invalid values', () => {
    expect(timeoutMs()).toBe(180000);
    for (const value of ['NaN', '0', '999', '600001', '1500.5'])
      expect(() => timeoutMs(value)).toThrow(E2EFailure);
    expect(timeoutMs('1000')).toBe(1000);
    expect(timeoutMs('600000')).toBe(600000);
  });
  it('preserves nonzero child exits without leaking stderr', async () => {
    const result = await runBounded(
      process.execPath,
      ['-e', 'process.stderr.write("private");process.exit(7)'],
      {
        cwd: process.cwd(),
        env: {},
        timeout: 5000,
      },
    );
    expect(result).toEqual({ code: 7, stdout: '' });
  });
  it('cleans up a stdio descendant when the leader exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gestalt-child-cleanup-'));
    dirs.push(dir);
    const pidPath = join(dir, 'child.pid');
    const code = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
      writeFileSync(process.argv[1],String(child.pid));child.unref();`;
    const result = await runBounded(process.execPath, ['-e', code, pidPath], {
      cwd: dir,
      env: {},
      timeout: 5000,
    });
    expect(result.code).toBe(0);
    const pid = Number(readFileSync(pidPath, 'utf8'));
    // The kernel can briefly retain the terminated child before reaping it.
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        },
        { timeout: 2000 },
      )
      .toBe(true);
  });
  it('terminates children at timeout and caps combined output', async () => {
    await expect(
      runBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        cwd: process.cwd(),
        env: {},
        timeout: 50,
      }),
    ).rejects.toMatchObject({ reason: 'timeout' });
    await expect(
      runBounded(process.execPath, ['-e', 'process.stderr.write("x".repeat(1000))'], {
        cwd: process.cwd(),
        env: {},
        timeout: 5000,
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ reason: 'output-limit' });
  });
});

describe('Codex evidence adjudication (synthetic event unit fixtures, not LLM E2E)', () => {
  it('accepts matching skill read, completed tool calls and persisted session', () => {
    const fixture = evidenceFixture();
    expect(judgeEvidence(fixture.stdout(), skill, source, fixture.path)).toEqual({
      skillRead: true,
      turnCompleted: true,
      sessionId: '11111111-1111-4111-8111-111111111111',
      calls: 3,
      persistedEvents: 3,
    });
  });
  it('rejects prose claims, malformed JSON, absent state, failed turns and missing skill body', () => {
    const fixture = evidenceFixture();
    for (const output of [
      'I used the skill and saved the session.',
      '{invalid',
      fixture.stdout().replace(source.replace(/\n/g, '\\n'), 'skill claimed'),
      fixture.stdout() + '\n' + JSON.stringify({ type: 'turn.failed' }),
    ]) {
      expect(() => judgeEvidence(output, skill, source, fixture.path)).toThrow(E2EFailure);
    }
    expect(() => judgeEvidence(fixture.stdout(), skill, source, '/missing.db')).toThrow(E2EFailure);
  });
  it('rejects scoring arguments even when the respond action succeeds', () => {
    for (const scoring of [
      { resolutionScore: { overall: 0.5 } },
      { rescore: true },
      { rescoreMode: 'same-context' },
    ]) {
      const fixture = evidenceFixture();
      const event = fixture.events[2] as { item: { arguments: Record<string, unknown> } };
      Object.assign(event.item.arguments, scoring);
      expect(() => judgeEvidence(fixture.stdout(), skill, source, fixture.path)).toThrowError(
        expect.objectContaining({ reason: 'evidence', checkpoint: 'unexpected-action' }),
      );
    }
  });
  it('rejects persisted scoring independently of CLI arguments', () => {
    for (const type of [
      'interview.resolution.scored',
      'interview.resolution.rescored',
      'interview.resolution.rescore_failed',
    ]) {
      const fixture = evidenceFixture();
      const db = new Database(fixture.path);
      db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)').run(
        'interview',
        '11111111-1111-4111-8111-111111111111',
        type,
        '{}',
      );
      db.close();
      expect(() => judgeEvidence(fixture.stdout(), skill, source, fixture.path)).toThrowError(
        expect.objectContaining({ reason: 'evidence' }),
      );
    }
  });
  it('rejects started-only calls, MCP error replies, and status for a different session', () => {
    for (const kind of ['started', 'error', 'wrong-session']) {
      const fixture = evidenceFixture();
      const event = fixture.events[3] as { item: Record<string, unknown> };
      if (kind === 'started') event.item.status = 'in_progress';
      if (kind === 'error') event.item.result = { isError: true, content: [] };
      if (kind === 'wrong-session') event.item.arguments = { sessionId: 'session-other' };
      expect(() => judgeEvidence(fixture.stdout(), skill, source, fixture.path)).toThrow(
        E2EFailure,
      );
    }
  });
  it('rejects unrelated DB sessions, invented answers, and premature completion', () => {
    for (const sql of [
      "UPDATE events SET aggregate_id = 'other'",
      "UPDATE events SET payload = '{}' WHERE event_type = 'interview.response.recorded'",
      "INSERT INTO events VALUES ('interview', '11111111-1111-4111-8111-111111111111', 'interview.session.completed', '{}')",
    ]) {
      const fixture = evidenceFixture();
      const db = new Database(fixture.path);
      db.exec(sql);
      db.close();
      expect(() => judgeEvidence(fixture.stdout(), skill, source, fixture.path)).toThrow(
        E2EFailure,
      );
    }
  });
});
