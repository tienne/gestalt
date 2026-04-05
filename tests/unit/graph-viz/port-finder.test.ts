import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import { findAvailablePort } from '../../../src/graph-viz/port-finder.js';

describe('findAvailablePort()', () => {
  it('기본 시작 포트(7891)를 사용 가능하면 그대로 반환한다', async () => {
    const port = await findAvailablePort(7891);
    expect(port).toBeGreaterThanOrEqual(7891);
  });

  it('지정한 포트가 사용 중이면 다음 포트를 반환한다', async () => {
    // 임의 포트를 점유한 뒤 findAvailablePort가 그 다음 포트를 찾는지 검증
    const occupiedServer = createServer();
    await new Promise<void>((resolve, reject) => {
      occupiedServer.once('error', reject);
      occupiedServer.listen(0, '127.0.0.1', () => resolve());
    });

    const occupiedPort = (occupiedServer.address() as { port: number }).port;

    try {
      const found = await findAvailablePort(occupiedPort);
      // 점유된 포트는 반환되지 않아야 함
      expect(found).not.toBe(occupiedPort);
      expect(found).toBeGreaterThan(occupiedPort);
    } finally {
      await new Promise<void>((res) => occupiedServer.close(() => res()));
    }
  });

  it('maxAttempts 초과 시 에러를 던진다', async () => {
    // 연속된 포트를 점유해 후보를 모두 막기
    const servers: ReturnType<typeof createServer>[] = [];
    const startPort = 19900;
    const count = 3;

    try {
      for (let i = 0; i < count; i++) {
        const s = createServer();
        await new Promise<void>((resolve, reject) => {
          s.once('error', reject);
          s.listen(startPort + i, '127.0.0.1', () => resolve());
        });
        servers.push(s);
      }

      await expect(findAvailablePort(startPort, count)).rejects.toThrow(
        /No available port found/,
      );
    } finally {
      await Promise.all(servers.map(s => new Promise<void>((res) => s.close(() => res()))));
    }
  });
});
