/**
 * scripts/code-graph-hook.sh — Node를 띄우기 전에 끝내는 경로와 실행 파일을 고르는 규칙.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const SCRIPT = resolve('scripts/code-graph-hook.sh');
const VERSION = (JSON.parse(readFileSync('package.json', 'utf-8')) as { version: string }).version;

let project: string;
let data: string;

function run(env: Record<string, string>, stdin = '{}') {
  return spawnSync(SCRIPT, ['user-prompt-submit'], {
    input: stdin,
    encoding: 'utf-8',
    timeout: 10_000,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: data,
      CLAUDE_PROJECT_DIR: project,
      CLAUDE_PLUGIN_DATA: data,
      ...env,
    },
  });
}

/** 받은 인자와 stdin을 그대로 찍는 가짜 실행 파일 */
function fakeBin(name: string): string {
  const path = join(data, name);
  writeFileSync(path, '#!/bin/sh\necho "RAN $0 $*"\ncat\n', { mode: 0o755 });
  return path;
}

beforeEach(() => {
  const root = resolve('.gestalt-test', `hook-launcher-${randomUUID()}`);
  project = join(root, 'project');
  data = join(root, 'data');
  mkdirSync(project, { recursive: true });
  mkdirSync(data, { recursive: true });
});

afterEach(() => {
  rmSync(resolve(project, '..'), { recursive: true, force: true });
});

function withGraph(): void {
  mkdirSync(join(project, '.gestalt'), { recursive: true });
  writeFileSync(join(project, '.gestalt', 'code-graph.db'), '');
}

describe('code-graph-hook.sh', () => {
  it('그래프 DB가 없으면 아무것도 안 하고 exit 0', () => {
    const bin = fakeBin('hook');
    const r = run({ GESTALT_CODE_GRAPH_HOOKS: '1', GESTALT_HOOK_BIN: bin });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('켜지 않은 레포는 Node 경로 해석까지 가지 않는다', () => {
    withGraph();
    const r = run({ GESTALT_HOOK_BIN: fakeBin('hook') });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(existsSync(join(data, 'hook-launcher-unpinned'))).toBe(false);
  });

  it('GESTALT_CODE_GRAPH_HOOKS=0은 gestalt.json보다 우선한다', () => {
    withGraph();
    writeFileSync(join(project, 'gestalt.json'), '{"codeGraph":{"hooks":{"enabled":true}}}');
    const r = run({ GESTALT_CODE_GRAPH_HOOKS: '0', GESTALT_HOOK_BIN: fakeBin('hook') });
    expect(r.stdout).toBe('');
  });

  it('절대 경로 GESTALT_HOOK_BIN은 이벤트 인자와 stdin을 넘겨 실행한다', () => {
    withGraph();
    const bin = fakeBin('hook');
    const r = run({ GESTALT_CODE_GRAPH_HOOKS: '1', GESTALT_HOOK_BIN: bin }, '{"x":1}');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`RAN ${bin} user-prompt-submit\n{"x":1}`);
  });

  it('상대 경로 GESTALT_HOOK_BIN은 거부한다', () => {
    withGraph();
    fakeBin('hook');
    // override를 버린 뒤 백그라운드 해석으로 넘어가지 않게 실패 기록을 먼저 둔다
    writeFileSync(join(data, `hook-launcher-${VERSION}.miss`), '');
    const r = spawnSync(SCRIPT, ['user-prompt-submit'], {
      cwd: data,
      input: '{}',
      encoding: 'utf-8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: data,
        CLAUDE_PROJECT_DIR: project,
        CLAUDE_PLUGIN_DATA: data,
        GESTALT_CODE_GRAPH_HOOKS: '1',
        GESTALT_HOOK_BIN: './hook',
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('RAN');
    expect(r.stderr).toContain('GESTALT_HOOK_BIN must be an absolute path');
  });

  it('캐시된 Node와 엔트리로 바로 실행한다', () => {
    withGraph();
    const node = fakeBin('node');
    const entry = join(data, 'entry.js');
    writeFileSync(entry, '');
    writeFileSync(join(data, `hook-launcher-${VERSION}`), `${node}\n${entry}\n`);
    const r = run({ GESTALT_CODE_GRAPH_HOOKS: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`RAN ${node} ${entry} user-prompt-submit\n{}`);
  });

  it('캐시에 상대 경로가 적혀 있으면 쓰지 않는다', () => {
    withGraph();
    const cache = join(data, `hook-launcher-${VERSION}`);
    writeFileSync(cache, 'node\nentry.js\n');
    // 실패 기록이 있으면 백그라운드 해석도 건너뛴다
    writeFileSync(`${cache}.miss`, '');
    const r = run({ GESTALT_CODE_GRAPH_HOOKS: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
