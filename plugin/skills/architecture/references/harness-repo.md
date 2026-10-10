1. **클라이언트와 플러그인**: 플러그인을 읽는 AI 클라이언트(Claude Code, Codex, Grok 등)를 `client`로 두고 근거는 그 클라이언트가 읽는 매니페스트 줄로 단다. 플러그인은 `service`다. `client → service`를 `loads`로 잇는다.
2. **스킬**: SKILL.md 하나에 `skill` 하나다. 근거는 그 SKILL.md의 `name` 줄이다. `parent`는 스킬을 묶는 `feature`나 플러그인 `service`다. 스킬 묶음을 `feature`로 세웠으면 그 묶음이 적힌 README나 docs 줄을 `doc` 근거로 단다.
3. **에이전트**: AGENT.md나 `agents/*.md` 하나에 `agent` 하나다. parent는 달지 않는다. 스킬이나 에이전트가 에이전트를 띄우면 `spawns`, 스킬이 다른 스킬을 부르면 `invokes`다. 근거는 지시문에서 그 이름을 부르는 줄이다.
4. **MCP 도구**: 도구 하나에 `endpoint` 하나다. action마다 나누지 않는다. label은 도구 이름이고 `protocol: "mcp"`, `mcpServer`에 서버 이름, `actions`에 그 도구가 받는 action enum 값을 단다. 근거는 도구 등록 줄이다. 그림에는 API 대신 **MCP 도구** 칩으로 나오고 레인도 따로 선다.
   - `parent`에는 그 도구를 내놓는 서비스 id를 단다. 서버 패키지가 따로 있으면 그 서비스이고 플러그인이 서버를 함께 담으면 플러그인 `service`다. 스킬 없이 클라이언트가 도구를 바로 부르는 순수 MCP 서버 레포는 이 parent가 있어야 전체 그림에 서비스 → 핸들러 묶음 선이 생긴다. HTTP 엔드포인트에는 parent를 달지 않는다.

   ```json
   { "id": "tool:plan", "kind": "endpoint", "label": "ges_plan", "protocol": "mcp",
     "mcpServer": "gestalt", "parent": "svc-gestalt", "actions": ["start", "submit"],
     "description": "실행 계획을 세우고 단계별로 제출받는 도구예요.", "evidence": [ ... ] }
   ```

5. **도구 호출 매칭**: SKILL.md와 AGENT.md에서 도구 이름과 `action=`, `action: '...'` 줄을 찾아 `skillToolCalls`로, 서버 코드의 도구 등록을 `serverTools`로 적어 `match_endpoints`에 넘긴다. HTTP 쪽 `feCalls`와 함께 넘겨도 된다.

   ```json
   { "action": "match_endpoints",
     "skillToolCalls": [{ "id": "c-1", "tool": "mcp__plugin_acme_gestalt__ges_plan", "action": "start" }],
     "serverTools": [{ "id": "tool:plan", "server": "gestalt", "tool": "ges_plan", "actions": ["start", "submit"] }] }
   ```

   - 결과는 `tools.matches`와 `tools.unmatched`로 온다. `matches`에 든 호출만 `skill → endpoint`나 `agent → endpoint` 실선(`calls`)으로 잇고 그 스킬이 쓰는 action을 엣지 `actions`에 단다. 도구의 `actions`에 없는 값을 달면 validate가 `UNKNOWN_MCP_ACTION`으로 거부한다.
   - 도구 이름은 정확히 같아야 맞는다. 클라이언트가 붙이는 `mcp__<서버>__<도구>` 접두는 걷어내고 비교한다. 플러그인으로 깔린 서버 이름 `plugin_<플러그인>_<서버>`는 `<서버>`와 맞는다.
   - `unmatched`(`no_tool`, `multiple_tools`, `unknown_action`)는 실선을 긋지 않고 `candidates`를 담아 미해결 질문으로 남긴다.

6. **핸들러와 엔진**: 도구를 받는 핸들러 모듈을 `app_module`로 두고 `endpoint → app_module`을 `handles`로 잇는다. 핸들러가 같은 프로세스 안에서 부르는 엔진 모듈도 `app_module`이고 `uses`로 잇는다. 엔진은 렌더할 때 핸들러 오른쪽 열에 따로 선다. 엔진이 쓰는 저장소는 `datastore`이고 `reads_writes`다. 에이전트 디렉토리를 훑어 AGENT.md를 읽어 들이는 레지스트리 모듈이 있으면 `app_module → agent`를 `loads`로 잇는다. 근거는 그 디렉토리를 훑는 `code` 줄(`readdirSync` 같은 줄)이다. 스킬이 띄우는 에이전트든 아니든 모든 에이전트에 단다. 이 선이 없으면 스킬이 안 띄우는 에이전트는 그림 어디에도 안 선다.
7. **md 줄 근거**: SKILL.md와 AGENT.md 줄은 `code` 근거라 실선이 된다. 다만 `skill`, `agent` 노드와 그 둘에서 나가는 엣지에서만이다. 하네스 IR(`client`, `skill`, `agent`가 하나라도 있는 IR)에서 그 밖의 노드나 엣지에 md 줄을 `code`로 달면 `MD_CODE_EVIDENCE`다. README나 docs의 언급은 `doc` 근거로 단다.
8. **그림 제목**: 화면이 하나도 없는 screen-chain은 제목이 "화면별 호출 흐름" 대신 바뀐다. 스킬이 있으면 "스킬별 호출 흐름", 스킬 없이 MCP 도구만 있으면 "MCP 도구 호출 흐름"이다.
9. **배포 쪽은 이 그림에 넣지 않는다**: 스킬 디렉토리 심링크와 마켓플레이스 매니페스트는 배포 경로다. 릴리즈 워크플로에서 빌드, npm 패키지, 플러그인 매니페스트로 이어지는 사슬은 Step 4대로 deploy-path에 그린다.
10. **흐름은 순서도로**: 무엇이 무엇을 어떤 순서로 부르는지는 진입 경로마다 `sequence` 질문별 그림 하나로 그린다. 쓰는 법은 [Step 3.5](../SKILL.md#step-35--도메인-흐름)의 하네스 흐름 항목에 있다.
