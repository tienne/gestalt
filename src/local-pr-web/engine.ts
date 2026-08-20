import { findAvailablePort } from '../graph-viz/port-finder.js';
import { LocalPrEngine } from '../local-pr/engine.js';
import { PrWebServer } from './server.js';
import type { PrWebServerOptions, PrWebServerResult } from './types.js';

/**
 * 로컬 PR 웹 UI 파이프라인을 조립한다: LocalPrEngine 생성 → 빈 포트 탐색 →
 * PrWebServer 기동 → (선택) 브라우저 열기.
 *
 * graph-viz/engine.ts와 같은 자리다. graph-viz는 정적 그래프 스냅샷을 한 번 굳혀
 * 넘기지만 여기는 PrWebServer가 매 요청마다 LocalPrEngine을 다시 읽으므로
 * 서버가 떠 있는 동안 달린 코멘트나 판정도 새로고침하면 바로 보인다.
 */
export class PrWebEngine {
  private server: PrWebServer | null = null;
  private prEngine: LocalPrEngine | null = null;

  async start(opts: PrWebServerOptions): Promise<PrWebServerResult> {
    const { repoRoot, port: preferredPort, openBrowser = true } = opts;

    this.prEngine = new LocalPrEngine(repoRoot);
    const count = this.prEngine.list().length;

    const port = await findAvailablePort(preferredPort ?? 7892);

    this.server = new PrWebServer(this.prEngine);
    await this.server.start(port);

    const url = `http://127.0.0.1:${port}`;
    process.stderr.write(`[local-pr-web] server running at ${url}\n`);

    if (openBrowser) {
      await openUrl(url);
    }

    return {
      url,
      port,
      message: `로컬 PR 웹 UI가 ${url}에서 돈다 (PR ${count}개)`,
    };
  }

  /** Stop the server and release resources. Safe to call even if never started. */
  async stop(): Promise<void> {
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
    if (this.prEngine) {
      this.prEngine.dispose();
      this.prEngine = null;
    }
  }
}

// ─── Singleton for shared CLI / MCP use ──────────────────────────
let _instance: PrWebEngine | null = null;

export function getPrWebEngine(): PrWebEngine {
  if (!_instance) _instance = new PrWebEngine();
  return _instance;
}

async function openUrl(url: string): Promise<void> {
  try {
    const { default: open } = await import('open');
    await open(url);
  } catch (err) {
    process.stderr.write(
      `[local-pr-web] could not open browser automatically: ${(err as Error).message}\n`,
    );
  }
}
