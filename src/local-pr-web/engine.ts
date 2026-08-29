import { findAvailablePort } from '../graph-viz/port-finder.js';
import { LocalPrEngine } from '../local-pr/engine.js';
import { listRepos, registerRepo } from '../local-pr/registry.js';
import type { RegisteredRepo } from '../local-pr/registry.js';
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
  private engines = new Map<string, { repo: RegisteredRepo; engine: LocalPrEngine }>();

  async start(opts: PrWebServerOptions): Promise<PrWebServerResult> {
    const { repoRoot, port: preferredPort, openBrowser = true } = opts;

    // 같은 인스턴스로 start를 다시 부를 수 있다. 먼저 걷어내지 않으면 앞서 뜬 서버가
    // 참조에서만 밀려나고 소켓과 포트, SIGINT 리스너는 그대로 남는다
    await this.stop();

    // 지금 자리를 먼저 목록에 넣는다. PR을 한 번도 안 만든 레포에서 serve를 쳐도
    // 자기 레포는 보여야 한다.
    //
    // 여기서 던지는 건 대개 git이다 — .git이 깨졌거나 레포가 아니다. 그 원문을 그대로
    // 올리면 사용자는 rev-parse 실패만 본다. 어느 자리를 못 열었는지로 바꿔 던진다
    let primary: RegisteredRepo;
    try {
      primary = registerRepo(repoRoot);
    } catch (e) {
      throw new Error(`이 레포를 못 열었어요: ${repoRoot}`, { cause: e });
    }

    // 레포 하나가 못 열려도 서버는 떠야 한다. 목록에는 남의 레포가 섞여 있고 그중
    // 하나가 옮겨지거나 .git이 깨졌다고 나머지를 못 보는 건 말이 안 된다.
    // 조용히 빼지는 않는다 — 안 보이는 이유를 알려야 사용자가 고칠 수 있다
    const broken: string[] = [];
    for (const repo of listRepos()) {
      try {
        this.engines.set(repo.key, { repo, engine: new LocalPrEngine(repo.path) });
      } catch {
        broken.push(repo.name);
      }
    }
    if (broken.length > 0) {
      process.stderr.write(`[local-pr-web] 못 연 레포 ${broken.length}개: ${broken.join(', ')}\n`);
    }

    const held = this.engines.get(primary.key);
    if (!held) throw new Error(`이 레포를 못 열었어요: ${repoRoot}`);
    const count = held.engine.list().length;

    // 0은 "아무 빈 포트나"라는 뜻이라 탐색할 게 없다. 탐색을 태우면 isPortAvailable(0)이
    // 늘 통과해 0을 그대로 돌려준다. 그 0이 URL에 박혀 죽은 주소가 나간다
    const requested = preferredPort ?? 7892;

    // 여기서부터는 이미 sqlite 핸들이 레포 수만큼 열려 있다. 포트를 못 잡거나 listen이
    // 거부하면 그것들이 참조만 남고 안 닫힌다 — 같은 인스턴스로 재시도하면 누적된다
    let port: number;
    try {
      port = requested === 0 ? 0 : await findAvailablePort(requested);
      this.server = new PrWebServer(this.engines, primary.key);
      await this.server.start(port);
    } catch (e) {
      await this.stop();
      throw e;
    }

    // listen(0)이면 실제 포트는 OS가 정한다. 요청값이 아니라 뜬 자리를 알려준다
    const actualPort = this.server.port ?? port;
    const url = `http://127.0.0.1:${actualPort}`;
    process.stderr.write(`[local-pr-web] server running at ${url}\n`);

    if (openBrowser) {
      await openUrl(url);
    }

    return {
      url,
      port: actualPort,
      message: `로컬 PR 웹 UI가 ${url}에서 돈다 (PR ${count}개)`,
    };
  }

  /** Stop the server and release resources. Safe to call even if never started. */
  async stop(): Promise<void> {
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
    for (const { engine } of this.engines.values()) engine.dispose();
    this.engines.clear();
  }
}

let _instance: PrWebEngine | null = null;

/**
 * 프로세스 하나가 서버를 하나만 띄우도록 공유하는 인스턴스.
 *
 * 아직 부르는 자리가 없다. `pr serve`는 `new PrWebEngine()`으로 직접 만들고 MCP는
 * 이 모듈을 안 가져간다. CLI와 MCP가 같은 서버 인스턴스를 공유해야 할 때를 위해 남겨 둔 진입점이다.
 */
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
