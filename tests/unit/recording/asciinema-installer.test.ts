import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsciinemaInstaller } from '../../../src/recording/asciinema-installer.js';
import * as childProcess from 'node:child_process';
import * as os from 'node:os';

vi.mock('node:child_process');
vi.mock('node:os');

const mockedExecSync = vi.mocked(childProcess.execSync);
const mockedSpawnSync = vi.mocked(childProcess.spawnSync);
const mockedPlatform = vi.mocked(os.platform);

describe('AsciinemaInstaller', () => {
  let installer: AsciinemaInstaller;

  beforeEach(() => {
    installer = new AsciinemaInstaller();
    vi.clearAllMocks();
  });

  describe('isInstalled()', () => {
    it('returns true when asciinema is found', () => {
      mockedExecSync.mockReturnValueOnce(Buffer.from('/usr/bin/asciinema'));
      expect(installer.isInstalled()).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith('which asciinema', { stdio: 'pipe' });
    });

    it('returns false when asciinema is not found', () => {
      mockedExecSync.mockImplementationOnce(() => {
        throw new Error('not found');
      });
      expect(installer.isInstalled()).toBe(false);
    });
  });

  describe('ensureInstalled()', () => {
    it('does nothing if already installed', async () => {
      mockedExecSync.mockReturnValueOnce(Buffer.from('/usr/bin/asciinema'));
      await installer.ensureInstalled();
      expect(mockedSpawnSync).not.toHaveBeenCalled();
    });

    it('installs via brew on macOS', async () => {
      // not installed
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });
      mockedPlatform.mockReturnValue('darwin');
      // brew is available
      mockedExecSync.mockReturnValueOnce(Buffer.from('/usr/local/bin/brew'));
      mockedSpawnSync.mockReturnValueOnce({ status: 0 } as ReturnType<typeof childProcess.spawnSync>);
      // post-install check: installed
      mockedExecSync.mockReturnValueOnce(Buffer.from('/usr/local/bin/asciinema'));

      await installer.ensureInstalled();

      expect(mockedSpawnSync).toHaveBeenCalledWith('brew', ['install', 'asciinema'], { stdio: 'inherit' });
    });

    it('installs via pip3 on Linux', async () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });
      mockedPlatform.mockReturnValue('linux');
      mockedSpawnSync.mockReturnValueOnce({ status: 0 } as ReturnType<typeof childProcess.spawnSync>);
      mockedExecSync.mockReturnValueOnce(Buffer.from('/usr/bin/asciinema'));

      await installer.ensureInstalled();

      expect(mockedSpawnSync).toHaveBeenCalledWith('pip3', ['install', 'asciinema'], { stdio: 'inherit' });
    });

    it('throws on unsupported platform', async () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });
      mockedPlatform.mockReturnValue('win32');

      await expect(installer.ensureInstalled()).rejects.toThrow('Unsupported platform');
    });

    it('throws when brew is not available on macOS', async () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); }); // asciinema not found
      mockedPlatform.mockReturnValue('darwin');
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); }); // brew not found

      await expect(installer.ensureInstalled()).rejects.toThrow('Homebrew is not installed');
    });

    it('throws if installation fails', async () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });
      mockedPlatform.mockReturnValue('linux');
      mockedSpawnSync.mockReturnValueOnce({ status: 1 } as ReturnType<typeof childProcess.spawnSync>);

      await expect(installer.ensureInstalled()).rejects.toThrow('Failed to install asciinema via pip3');
    });
  });
});
