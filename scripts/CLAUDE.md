# MCP 기동 경로

클라이언트마다 서버를 띄우는 방식이 다르다.

```
.mcp.json                 Claude — sh로 scripts/mcp-serve.sh를 찾아 실행
.claude-plugin/.mcp.json  .mcp.json과 내용 동일 (해석 기준 디렉토리가 모호해 양쪽에 둔다)
plugin/mcp.json           Codex — npx, 버전 핀
plugin/.mcp.json          Grok(배포) — plugin/mcp.json과 동일
.grok/config.toml         Grok(이 레포 개발용) — scripts/grok-mcp-serve.sh
```

- `npx`는 버전을 박아도 기동할 때마다 레지스트리를 조회한다. 캐시가 비면 20초, 레지스트리에 못 닿으면 70초를 매달린다. Claude Code의 기동 제한은 30초라 둘 다 `Connection closed`로 끊긴다.
- `startup_timeout_sec`와 `tool_timeout_sec`는 Codex 키다. Claude Code는 안 읽고 `MCP_TIMEOUT` 환경변수만 본다. Claude 매니페스트에 넣어봐야 무시된다.
- `scripts/mcp-serve.sh`가 그 셋을 처리한다. nvm, fnm, Volta, Homebrew에서 Node >= 22를 찾는다 (GUI 세션은 PATH에 버전 매니저가 없다). 전역 `gestalt`가 있으면 그걸 쓰고 없으면 `npx --offline`으로 캐시에서 해석한다.
- 그 스크립트는 npx로 서버를 띄우지 않고 bin 경로만 받아와 직접 exec한다. npx가 cwd의 로컬 패키지를 먼저 보기 때문에, node_modules 없는 gestalt 체크아웃 안에서는 `gestalt: command not found`로 죽는다. 그래서 해석은 `cd /`에서 한다.
- 전역 `gestalt`가 깔려 있으면 핀보다 그게 이긴다. 누가 `npm i -g`를 했다는 건 이 체크아웃이 번들한 것보다 구체적인 선택이라서다. 대신 어느 쪽을 썼는지 stderr에 적어 버전이 어긋났을 때 로그에서 보이게 한다.
- 매니페스트의 `sh -c`는 `${CLAUDE_PLUGIN_ROOT}`를 먼저 본다. 거기서 스크립트를 찾으면 `GESTALT_LAUNCHER`는 아예 안 본다. 플러그인으로 설치된 상태에서는 그 변수가 안 걸린다는 뜻이다. 플러그인 없이 이 레포만 연 경우에만 차례가 온다. 그때도 **절대 경로만** 받는다 — 상대 경로를 허용하면 남의 레포를 열었을 때 거기 있는 동명 실행 파일이 서버 대신 도는 자리가 된다.
- 그 `sh -c`의 최후 폴백도 버전이 핀되어 있다. 거기까지 왔으면 스크립트를 못 찾은 것이다. 스크립트가 없으면 `package.json`도 없어 런타임에 버전을 못 읽는다. 그래서 그 자리만은 `sync-version.ts`가 문자열에 직접 박는다.
- 네 매니페스트의 버전 핀을 `scripts/sync-version.ts`가 릴리즈마다 함께 갱신한다. `plugin/*`는 인자 하나가 통째로 스펙이고 Claude 쪽은 `sh` 문자열 안에 박혀 있는데, 같은 정규식으로 둘 다 친다.
- `command: "sh"`라서 Windows 호스트에서는 안 뜬다. 그쪽은 전역 설치 후 `command: "gestalt"`로 안내한다.
