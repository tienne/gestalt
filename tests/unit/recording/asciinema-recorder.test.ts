import { describe, it, expect, vi, afterEach } from 'vitest';
import { AsciinemaRecorder } from '../../../src/recording/asciinema-recorder.js';
import * as childProcess from 'node:child_process';
import * as fsModule from 'node:fs';

vi.mock('node:child_process');
vi.mock('node:fs');

const mockedSpawnSync = vi.mocked(childProcess.spawnSync);
const mockedMkdirSync = vi.mocked(fsModule.mkdirSync);

describe('AsciinemaRecorder', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  describe('isInsideRecording()', () => {
    it('returns false by default', () => {
      vi.stubEnv('GESTALT_RECORDING', '');
      expect(AsciinemaRecorder.isInsideRecording()).toBe(false);
    });

    it('returns true when GESTALT_RECORDING=1', () => {
      vi.stubEnv('GESTALT_RECORDING', '1');
      expect(AsciinemaRecorder.isInsideRecording()).toBe(true);
    });
  });

  describe('getCurrentCastPath()', () => {
    it('returns undefined when not set', () => {
      vi.stubEnv('GESTALT_CAST_PATH', '');
      expect(AsciinemaRecorder.getCurrentCastPath()).toBeFalsy();
    });

    it('returns the path when set', () => {
      vi.stubEnv('GESTALT_CAST_PATH', '/tmp/test.cast');
      expect(AsciinemaRecorder.getCurrentCastPath()).toBe('/tmp/test.cast');
    });
  });

  describe('createTempCastPath()', () => {
    it('creates directory and returns a .cast path', () => {
      mockedMkdirSync.mockReturnValueOnce(undefined);
      const path = AsciinemaRecorder.createTempCastPath('.gestalt/recordings');
      expect(path).toMatch(/^\.gestalt\/recordings\/tmp-.+\.cast$/);
      expect(mockedMkdirSync).toHaveBeenCalledWith('.gestalt/recordings', { recursive: true });
    });
  });

  describe('respawnWithAsciinema()', () => {
    it('calls spawnSync with asciinema rec and exits', () => {
      mockedMkdirSync.mockReturnValue(undefined);
      mockedSpawnSync.mockReturnValueOnce({ status: 0 } as ReturnType<typeof childProcess.spawnSync>);

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      expect(() => AsciinemaRecorder.respawnWithAsciinema('/tmp/test.cast')).toThrow('process.exit called');

      expect(mockedSpawnSync).toHaveBeenCalledWith(
        'asciinema',
        expect.arrayContaining(['rec', '--overwrite', '/tmp/test.cast']),
        expect.objectContaining({
          stdio: 'inherit',
          env: expect.objectContaining({
            GESTALT_RECORDING: '1',
            GESTALT_CAST_PATH: '/tmp/test.cast',
          }),
        }),
      );

      exitSpy.mockRestore();
    });

    it('filters --record and -r from args', () => {
      const originalArgv = process.argv;
      process.argv = ['node', 'gestalt', 'interview', 'topic', '--record'];
      mockedMkdirSync.mockReturnValue(undefined);
      mockedSpawnSync.mockReturnValueOnce({ status: 0 } as ReturnType<typeof childProcess.spawnSync>);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });

      expect(() => AsciinemaRecorder.respawnWithAsciinema('/tmp/x.cast')).toThrow('exit');

      const call = mockedSpawnSync.mock.calls[0]!;
      const args = call[1] as string[];
      expect(args).not.toContain('--record');

      process.argv = originalArgv;
      exitSpy.mockRestore();
    });
  });
});
