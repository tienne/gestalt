import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AggInstaller } from '../../../src/recording/agg-installer.js';
import * as childProcess from 'node:child_process';

vi.mock('node:child_process');

const mockedExecSync = vi.mocked(childProcess.execSync);
const mockedSpawnSync = vi.mocked(childProcess.spawnSync);

describe('AggInstaller', () => {
  let installer: AggInstaller;

  beforeEach(() => {
    installer = new AggInstaller();
    vi.clearAllMocks();
  });

  describe('isInstalled()', () => {
    it('returns true when agg is found', () => {
      mockedExecSync.mockReturnValueOnce(Buffer.from('/usr/bin/agg'));
      expect(installer.isInstalled()).toBe(true);
    });

    it('returns false when agg is not found', () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });
      expect(installer.isInstalled()).toBe(false);
    });
  });

  describe('ensureInstalled()', () => {
    it('does nothing if already installed', async () => {
      mockedExecSync.mockReturnValueOnce(Buffer.from('/usr/bin/agg'));
      await installer.ensureInstalled();
      expect(mockedSpawnSync).not.toHaveBeenCalled();
    });

    it('installs via cargo when cargo is available', async () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); }); // agg not found
      mockedExecSync.mockReturnValueOnce(Buffer.from('/usr/bin/cargo')); // cargo available
      mockedSpawnSync.mockReturnValueOnce({ status: 0 } as ReturnType<typeof childProcess.spawnSync>);
      mockedExecSync.mockReturnValueOnce(Buffer.from('/usr/bin/agg')); // post-install check

      await installer.ensureInstalled();

      expect(mockedSpawnSync).toHaveBeenCalledWith('cargo', ['install', 'agg'], { stdio: 'inherit' });
    });

    it('installs via npm when cargo is not available', async () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); }); // agg not found
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); }); // cargo not found
      mockedExecSync.mockReturnValueOnce(Buffer.from('/usr/bin/npm')); // npm available
      mockedSpawnSync.mockReturnValueOnce({ status: 0 } as ReturnType<typeof childProcess.spawnSync>);
      mockedExecSync.mockReturnValueOnce(Buffer.from('/usr/bin/agg')); // post-install check

      await installer.ensureInstalled();

      expect(mockedSpawnSync).toHaveBeenCalledWith('npm', ['install', '-g', '@asciinema/agg'], { stdio: 'inherit' });
    });

    it('throws when neither cargo nor npm is available', async () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); }); // agg not found
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); }); // cargo not found
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); }); // npm not found

      await expect(installer.ensureInstalled()).rejects.toThrow('Neither cargo nor npm');
    });

    it('throws if installation via cargo fails', async () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); }); // agg not found
      mockedExecSync.mockReturnValueOnce(Buffer.from('/usr/bin/cargo')); // cargo available
      mockedSpawnSync.mockReturnValueOnce({ status: 1 } as ReturnType<typeof childProcess.spawnSync>);

      await expect(installer.ensureInstalled()).rejects.toThrow('Failed to install agg via cargo');
    });
  });
});
