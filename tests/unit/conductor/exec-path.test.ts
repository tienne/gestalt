import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execPathOf } from '../../../src/cli/commands/conductor.js';
import { getVersion } from '../../../src/core/version.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function entry(): { real: string; link: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'exec-path-')));
  dirs.push(dir);
  const real = join(dir, 'gestalt.js');
  writeFileSync(real, '');
  const link = join(dir, 'gestalt');
  symlinkSync(real, link);
  return { real, link };
}

describe('conductor exec-path', () => {
  it('node 경로와 node 옵션, 심링크를 푼 진입 파일을 순서대로 돌려준다', () => {
    const { real, link } = entry();
    expect(
      execPathOf({
        execPath: '/usr/bin/node',
        execArgv: ['--import', 'file:///tsx/loader.mjs'],
        argv: ['/usr/bin/node', link, 'conductor', 'exec-path'],
        env: {},
      }),
    ).toEqual({
      node: '/usr/bin/node',
      args: ['--import', 'file:///tsx/loader.mjs', real],
      env: {},
      version: getVersion(),
    });
  });

  it('런처가 건 tsx tsconfig 경로는 env로 넘긴다', () => {
    const { real } = entry();
    const out = execPathOf({
      execPath: '/usr/bin/node',
      execArgv: [],
      argv: ['/usr/bin/node', real],
      env: { TSX_TSCONFIG_PATH: '/repo/tsconfig.json', HOME: '/home/x' },
    });
    expect(out.env).toEqual({ TSX_TSCONFIG_PATH: '/repo/tsconfig.json' });
  });

  it('진입 파일을 모르면 실패한다', () => {
    expect(() =>
      execPathOf({ execPath: '/usr/bin/node', execArgv: [], argv: ['/usr/bin/node'], env: {} }),
    ).toThrow('실행 중인 CLI 경로를 못 찾았어요');
  });
});
