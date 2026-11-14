import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../src/core/config.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupStateDirs();
});

const isolated = { skipDotEnv: true, skipGestaltJson: true };

describe('컨덕터 에이전트 설정', () => {
  it('기본은 claude이며 임의의 공백 없는 ID와 레포 맵을 받는다', () => {
    expect(loadConfig({}, isolated).conductor.defaultAgent).toBe('claude');
    expect(loadConfig({}, isolated).conductor.repoAgents).toEqual({});
    const config = loadConfig(
      { conductor: { defaultAgent: 'custom:v2', repoAgents: { 'acme/app': 'codex' } } },
      isolated,
    );
    expect(config.conductor.defaultAgent).toBe('custom:v2');
    expect(config.conductor.repoAgents).toEqual({ 'acme/app': 'codex' });
  });

  it.each(['', ' ', 'codex agent', 'codex\n', '--keep-open', '-x', 'a'.repeat(65)])(
    '허용 꼴이 아닌 에이전트는 설정 검증에서 거절한다: %j',
    (agent) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(
        loadConfig({ conductor: { defaultAgent: agent } }, isolated).conductor.defaultAgent,
      ).toBe('claude');
      expect(
        loadConfig({ conductor: { repoAgents: { 'acme/app': agent } } }, isolated).conductor
          .repoAgents,
      ).toEqual({});
    },
  );

  it('레포의 에이전트 설정은 버리고 사용자 전역 파일의 값만 받는다', () => {
    const root = resolve(tempStateDir());
    const home = join(root, 'home');
    mkdirSync(join(home, '.gestalt'), { recursive: true });
    vi.stubEnv('GESTALT_HOME', home);
    const cwd = process.cwd();
    try {
      process.chdir(root);
      writeFileSync(
        'gestalt.json',
        JSON.stringify({
          conductor: { defaultAgent: 'untrusted', repoAgents: { 'acme/app': 'untrusted' } },
        }),
      );
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(loadConfig({}, { skipDotEnv: true }).conductor.defaultAgent).toBe('claude');
      expect(loadConfig({}, { skipDotEnv: true }).conductor.repoAgents).toEqual({});
      writeFileSync(
        join(home, '.gestalt', 'conductor.json'),
        JSON.stringify({ defaultAgent: 'cursor', repoAgents: { 'acme/app': 'codex' } }),
      );
      const config = loadConfig({}, { skipDotEnv: true }).conductor;
      expect(config.defaultAgent).toBe('cursor');
      expect(config.repoAgents).toEqual({ 'acme/app': 'codex' });
    } finally {
      process.chdir(cwd);
    }
  });

  it('머지 뒤 오르카 워크트리 삭제는 기본 꺼짐이고 사용자 전역 파일로만 켠다', () => {
    expect(loadConfig({}, isolated).conductor.removeMergedOrcaWorktrees).toBe(false);
    const root = resolve(tempStateDir());
    const home = join(root, 'home');
    mkdirSync(join(home, '.gestalt'), { recursive: true });
    vi.stubEnv('GESTALT_HOME', home);
    const cwd = process.cwd();
    try {
      process.chdir(root);
      writeFileSync(
        'gestalt.json',
        JSON.stringify({ conductor: { removeMergedOrcaWorktrees: true } }),
      );
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(loadConfig({}, { skipDotEnv: true }).conductor.removeMergedOrcaWorktrees).toBe(false);
      writeFileSync(
        join(home, '.gestalt', 'conductor.json'),
        JSON.stringify({ removeMergedOrcaWorktrees: true }),
      );
      expect(loadConfig({}, { skipDotEnv: true }).conductor.removeMergedOrcaWorktrees).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
  it('인계 effort는 기본 high이고 모델과 함께 사용자 전역 파일로만 바꾼다', () => {
    expect(loadConfig({}, isolated).conductor).toMatchObject({ handoffEffort: 'high' });
    expect(loadConfig({}, isolated).conductor.handoffModel).toBeUndefined();
    const root = resolve(tempStateDir());
    const home = join(root, 'home');
    mkdirSync(join(home, '.gestalt'), { recursive: true });
    vi.stubEnv('GESTALT_HOME', home);
    const cwd = process.cwd();
    try {
      process.chdir(root);
      writeFileSync(
        'gestalt.json',
        JSON.stringify({ conductor: { handoffEffort: 'low', handoffModel: 'haiku' } }),
      );
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(loadConfig({}, { skipDotEnv: true }).conductor).toMatchObject({
        handoffEffort: 'high',
      });
      expect(loadConfig({}, { skipDotEnv: true }).conductor.handoffModel).toBeUndefined();
      writeFileSync(
        join(home, '.gestalt', 'conductor.json'),
        JSON.stringify({ handoffEffort: 'xhigh', handoffModel: 'opus[1m]' }),
      );
      expect(loadConfig({}, { skipDotEnv: true }).conductor).toMatchObject({
        handoffEffort: 'xhigh',
        handoffModel: 'opus[1m]',
      });
    } finally {
      process.chdir(cwd);
    }
  });
});
