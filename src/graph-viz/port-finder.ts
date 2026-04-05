import { createServer } from 'node:net';

const DEFAULT_START_PORT = 7891;
const DEFAULT_MAX_ATTEMPTS = 20;

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export async function findAvailablePort(
  startPort: number = DEFAULT_START_PORT,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
  }
  throw new Error(
    `No available port found in range ${startPort}–${startPort + maxAttempts - 1} after ${maxAttempts} attempts`,
  );
}
