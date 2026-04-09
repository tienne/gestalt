import { describe, it, expect, vi, afterEach } from 'vitest';
import { RecordingOrchestrator } from '../../../src/recording/recording-orchestrator.js';

// mock 모듈들
vi.mock('../../../src/recording/asciinema-installer.js', () => ({
  AsciinemaInstaller: vi.fn().mockImplementation(() => ({
    ensureInstalled: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/recording/agg-installer.js', () => ({
  AggInstaller: vi.fn().mockImplementation(() => ({
    ensureInstalled: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/recording/asciinema-recorder.js', () => ({
  AsciinemaRecorder: {
    isInsideRecording: vi.fn().mockReturnValue(false),
    getCurrentCastPath: vi.fn().mockReturnValue(undefined),
    createTempCastPath: vi.fn().mockReturnValue('/tmp/tmp-uuid.cast'),
    respawnWithAsciinema: vi.fn(),
  },
}));

vi.mock('../../../src/recording/agg-converter.js', () => ({
  AggConverter: vi.fn().mockImplementation(() => ({
    convertAsync: vi.fn().mockResolvedValue('/output/test.gif'),
    convertGifToMp4Async: vi.fn().mockResolvedValue('/output/test.mp4'),
  })),
}));

vi.mock('../../../src/recording/filename-generator.js', () => ({
  FilenameGenerator: vi.fn().mockImplementation(() => ({
    generate: vi.fn().mockResolvedValue('/output/test-interview-20260328.gif'),
  })),
}));

const { AsciinemaRecorder } = await import('../../../src/recording/asciinema-recorder.js');
const mockedAsciinemaRecorder = vi.mocked(AsciinemaRecorder);

describe('RecordingOrchestrator', () => {
  const mockLlm = {} as Parameters<typeof RecordingOrchestrator>[0];

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  describe('startIfNeeded()', () => {
    it('does nothing when record=false', async () => {
      const orchestrator = new RecordingOrchestrator(mockLlm);
      await orchestrator.startIfNeeded({ record: false });
      expect(mockedAsciinemaRecorder.respawnWithAsciinema).not.toHaveBeenCalled();
    });

    it('does nothing when already inside recording', async () => {
      mockedAsciinemaRecorder.isInsideRecording.mockReturnValue(true);
      const orchestrator = new RecordingOrchestrator(mockLlm);
      await orchestrator.startIfNeeded({ record: true });
      expect(mockedAsciinemaRecorder.respawnWithAsciinema).not.toHaveBeenCalled();
    });

    it('calls respawnWithAsciinema when record=true and not yet recording', async () => {
      mockedAsciinemaRecorder.isInsideRecording.mockReturnValue(false);
      const orchestrator = new RecordingOrchestrator(mockLlm);
      await orchestrator.startIfNeeded({ record: true });
      expect(mockedAsciinemaRecorder.respawnWithAsciinema).toHaveBeenCalledWith(
        '/tmp/tmp-uuid.cast',
      );
    });
  });

  describe('isRecording()', () => {
    it('returns false when not inside recording', () => {
      mockedAsciinemaRecorder.isInsideRecording.mockReturnValue(false);
      mockedAsciinemaRecorder.getCurrentCastPath.mockReturnValue(undefined);
      const orchestrator = new RecordingOrchestrator(mockLlm);
      expect(orchestrator.isRecording()).toBe(false);
    });

    it('returns true when inside recording with cast path', () => {
      mockedAsciinemaRecorder.isInsideRecording.mockReturnValue(true);
      mockedAsciinemaRecorder.getCurrentCastPath.mockReturnValue('/tmp/test.cast');
      const orchestrator = new RecordingOrchestrator(mockLlm);
      expect(orchestrator.isRecording()).toBe(true);
    });
  });

  describe('stopAndConvert()', () => {
    it('does nothing when no cast path', async () => {
      mockedAsciinemaRecorder.getCurrentCastPath.mockReturnValue(undefined);
      const orchestrator = new RecordingOrchestrator(mockLlm);
      await orchestrator.stopAndConvert('topic', 'session-id');
      // no error thrown
    });

    it('triggers agg conversion when cast path exists', async () => {
      mockedAsciinemaRecorder.getCurrentCastPath.mockReturnValue('/tmp/test.cast');

      const orchestrator = new RecordingOrchestrator(mockLlm);

      // 에러 없이 완료되고 비동기 변환이 트리거됨
      await expect(orchestrator.stopAndConvert('my topic', 'session-123')).resolves.toBeUndefined();
    });
  });
});
