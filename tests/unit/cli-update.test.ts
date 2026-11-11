import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const execSync = vi.fn();

vi.mock('node:child_process', () => ({ execSync: (...args: unknown[]) => execSync(...args) }));
vi.mock('../../src/core/version.js', () => ({
  checkForUpdates: vi.fn(async () => ({
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    updateAvailable: true,
  })),
}));

const { updateCommand, CODEX_ADD_COMMAND } = await import('../../src/cli/commands/update.js');

interface Scenario {
  codexGet?: string;
  codexGetJson?: string;
  addFails?: boolean;
}

function route({ codexGet, codexGetJson, addFails }: Scenario) {
  execSync.mockImplementation((cmd: string) => {
    if (cmd === 'which claude') throw new Error('not found');
    if (cmd === 'which codex') return '';
    if (cmd.startsWith('codex mcp get gestalt --json')) {
      if (codexGetJson === undefined) throw new Error('no json');
      return codexGetJson;
    }
    if (cmd.startsWith('codex mcp get gestalt')) {
      if (codexGet === undefined) throw new Error('missing');
      return codexGet;
    }
    if (cmd === 'codex mcp remove gestalt') return '';
    if (cmd === CODEX_ADD_COMMAND) {
      if (addFails) throw new Error('add failed');
      return '';
    }
    throw new Error(`예상 못 한 명령: ${cmd}`);
  });
}

describe('updateCommand의 Codex 처리', () => {
  let out: string[];

  beforeEach(() => {
    execSync.mockReset();
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => void out.push(a.join(' ')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('등록 명령은 따라가기를 끄고 serve로 띄운다', () => {
    expect(CODEX_ADD_COMMAND).toBe(
      'codex mcp add gestalt --env GESTALT_FOLLOW_PLUGIN=0 -- npx -y @tienne/gestalt serve',
    );
  });

  it('npx가 아닌 등록은 같은 명령으로 다시 등록한다', async () => {
    route({ codexGet: 'command: gestalt serve' });
    await updateCommand();
    const cmds = execSync.mock.calls.map((c) => c[0]);
    expect(cmds).toContain('codex mcp remove gestalt');
    expect(cmds).toContain(CODEX_ADD_COMMAND);
  });

  it('다시 등록이 실패하면 같은 명령을 안내한다', async () => {
    route({ codexGet: 'command: gestalt serve', addFails: true });
    await updateCommand();
    expect(out).toContain(`  ${CODEX_ADD_COMMAND}`);
  });

  it('npx 등록에 따라가기 끄기가 있으면 다시 등록하지 않고 안내도 없다', async () => {
    route({
      codexGet: 'command: npx -y @tienne/gestalt',
      codexGetJson: JSON.stringify({ transport: { env: { GESTALT_FOLLOW_PLUGIN: '0' } } }),
    });
    await updateCommand();
    const cmds = execSync.mock.calls.map((c) => c[0]);
    expect(cmds).not.toContain('codex mcp remove gestalt');
    expect(out.join('\n')).not.toContain('GESTALT_FOLLOW_PLUGIN = "0"');
  });

  it.each([
    ['env가 없을 때', JSON.stringify({ transport: { env: {} } })],
    ['JSON을 못 읽을 때', 'not json'],
    ['--json 조회가 실패할 때', undefined],
  ])('npx 등록에서 %s config.toml 안내를 출력하고 다시 등록하지 않는다', async (_l, json) => {
    route({ codexGet: 'command: npx -y @tienne/gestalt', codexGetJson: json });
    await updateCommand();
    const cmds = execSync.mock.calls.map((c) => c[0]);
    expect(cmds).not.toContain('codex mcp remove gestalt');
    expect(out).toContain('  [mcp_servers.gestalt.env]');
    expect(out).toContain('  GESTALT_FOLLOW_PLUGIN = "0"');
  });
});
