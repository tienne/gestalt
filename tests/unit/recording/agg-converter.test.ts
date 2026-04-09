import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AggConverter } from '../../../src/recording/agg-converter.js';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process');
vi.mock('node:fs');
vi.mock('node:fs/promises');

const mockedSpawn = vi.mocked(childProcess.spawn);
const mockedMkdirSync = vi.mocked(fs.mkdirSync);
const mockedUnlink = vi.mocked(fsPromises.unlink);

function makeChildMock(exitCode: number) {
  const emitter = new EventEmitter() as ReturnType<typeof childProcess.spawn>;
  (emitter as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  setTimeout(() => emitter.emit('close', exitCode), 0);
  return emitter;
}

describe('AggConverter', () => {
  let converter: AggConverter;

  beforeEach(() => {
    converter = new AggConverter();
    vi.clearAllMocks();
    mockedMkdirSync.mockReturnValue(undefined);
  });

  describe('convertAsync()', () => {
    it('resolves with outputPath on success', async () => {
      mockedSpawn.mockReturnValueOnce(makeChildMock(0));
      mockedUnlink.mockResolvedValueOnce(undefined);

      const result = await converter.convertAsync('/tmp/test.cast', '/tmp/test.gif');
      expect(result).toBe('/tmp/test.gif');
    });

    it('deletes .cast file after successful conversion', async () => {
      mockedSpawn.mockReturnValueOnce(makeChildMock(0));
      mockedUnlink.mockResolvedValueOnce(undefined);

      await converter.convertAsync('/tmp/test.cast', '/tmp/test.gif', { deleteCastAfter: true });
      expect(mockedUnlink).toHaveBeenCalledWith('/tmp/test.cast');
    });

    it('does not delete .cast when deleteCastAfter=false', async () => {
      mockedSpawn.mockReturnValueOnce(makeChildMock(0));

      await converter.convertAsync('/tmp/test.cast', '/tmp/test.gif', { deleteCastAfter: false });
      expect(mockedUnlink).not.toHaveBeenCalled();
    });

    it('calls onComplete callback with outputPath', async () => {
      mockedSpawn.mockReturnValueOnce(makeChildMock(0));
      mockedUnlink.mockResolvedValueOnce(undefined);
      const onComplete = vi.fn();

      await converter.convertAsync('/tmp/test.cast', '/tmp/test.gif', { onComplete });
      expect(onComplete).toHaveBeenCalledWith('/tmp/test.gif');
    });

    it('rejects and calls onError when agg fails', async () => {
      mockedSpawn.mockReturnValueOnce(makeChildMock(1));
      const onError = vi.fn();

      await expect(
        converter.convertAsync('/tmp/test.cast', '/tmp/test.gif', { onError }),
      ).rejects.toThrow('agg exited with code 1');
      expect(onError).toHaveBeenCalled();
    });

    it('silently ignores .cast deletion failure', async () => {
      mockedSpawn.mockReturnValueOnce(makeChildMock(0));
      mockedUnlink.mockRejectedValueOnce(new Error('ENOENT'));

      await expect(converter.convertAsync('/tmp/test.cast', '/tmp/test.gif')).resolves.toBe(
        '/tmp/test.gif',
      );
    });
  });

  describe('convertGifToMp4Async()', () => {
    it('resolves with mp4Path on success', async () => {
      mockedSpawn.mockReturnValueOnce(makeChildMock(0));

      const result = await converter.convertGifToMp4Async('/tmp/test.gif', '/tmp/test.mp4');
      expect(result).toBe('/tmp/test.mp4');
    });

    it('rejects when ffmpeg fails', async () => {
      mockedSpawn.mockReturnValueOnce(makeChildMock(2));

      await expect(
        converter.convertGifToMp4Async('/tmp/test.gif', '/tmp/test.mp4'),
      ).rejects.toThrow('ffmpeg exited with code 2');
    });
  });
});
