#!/usr/bin/env node

// Claude Code 플러그인 훅 엔트리. 매 프롬프트마다 뜨는 프로세스라 CLI(bin/gestalt.ts)를
// 거치지 않는다. commander와 MCP 서버까지 딸려오면 기동만 수백 ms가 든다.
// 어떤 경로든 exit 0으로 끝낸다. 훅이 실패해도 사용자 턴은 막지 않는다.

process.env['GESTALT_LOG_LEVEL'] ??= 'warn';

const [, entry, command, arg] = process.argv;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main(): Promise<void> {
  if (command === 'refresh' || command === 'reindex') {
    // 백그라운드 갱신. 여기서만 엔진을 불러온다. refresh는 훅이 띄운 것이라 훅이 켜져 있어야 돈다.
    // reindex는 MCP 질의가 다시 파싱할 게 많아 넘긴 것이라 훅 설정과 무관하다
    if (!arg) return;
    if (command === 'refresh') {
      const { isHooksEnabled } = await import('../src/code-graph/hooks/settings.js');
      if (!isHooksEnabled(arg)) return;
    }
    const { codeGraphEngine } = await import('../src/code-graph/engine.js');
    await codeGraphEngine.refresh(arg);
    codeGraphEngine.close();
    return;
  }

  const { parseEventArg, runHook, DEADLINE_MS } = await import('../src/code-graph/hooks/run.js');
  const event = parseEventArg(command);
  if (!event) return;

  // stdin이 안 닫히거나 비동기 대기가 길어지면 데드라인에서 끊는다.
  // 동기 구간은 이 타이머가 못 끊으므로 runHook이 단계마다 데드라인을 따로 본다
  setTimeout(() => process.exit(0), DEADLINE_MS[event] + 300).unref();

  const { detachedRefreshSpawner } = await import('../src/code-graph/hooks/background.js');
  const out = await runHook(event, await readStdin(), {
    spawnRefresh: entry ? detachedRefreshSpawner(entry) : undefined,
  });
  if (out) process.stdout.write(out);
}

main()
  .catch((e: unknown) => {
    process.stderr.write(`[gestalt] hook failed: ${e instanceof Error ? e.message : String(e)}\n`);
  })
  .finally(() => {
    process.exitCode = 0;
  });
