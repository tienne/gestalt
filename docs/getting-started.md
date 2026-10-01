# Gestalt 시작하기

이 가이드를 마치면 막연한 아이디어 하나로 인터뷰를 시작하고, 구조화된 스펙과 실행 계획까지 뽑아낼 수 있어요. 처음 설치부터 `/execute`까지 5분이면 충분해요.

---

## 플러그인 설치

Claude Code에서 한 번만 실행하면 돼요.

```bash
/plugin marketplace add tienne/gestalt
/plugin install gestalt@gestalt
```

설치가 끝나면 `/interview`, `/spec`, `/execute` 명령이 모든 세션에서 바로 쓸 수 있어요.

> Node.js 22 이상이 필요해요. 버전이 낮다면 `nvm install 22 && nvm use 22`를 먼저 실행하세요.

> Windows 호스트는 지원하지 않아요. 플러그인이 MCP 서버를 `sh -c`로 띄워서 Windows에서는 서버가 안 떠요. CI도 Ubuntu와 macOS에서만 돌려요. 그래도 써보려면 `npm i -g @tienne/gestalt`로 전역 설치하고 MCP 설정에 `"command": "gestalt"`, `"args": ["serve"]`를 직접 넣으세요.

**설치 후 명령이 보이지 않으면** Claude Code를 재시작한 뒤 Plugins 패널을 확인하세요.

---

## 인터뷰 시작

거칠고 짧은 문장 하나면 충분해요.

```
/interview "팀원들이 슬랙 스레드에서 태스크를 놓치지 않도록 팀 태스크 앱을 만들고 싶어요"
```

Gestalt가 게슈탈트 5원리에 따라 질문을 이어가요. 각 질문은 요구사항의 빈 곳을 하나씩 채워요.

**실제 대화 흐름:**

> **Gestalt** (1라운드 — Closure): "이 앱이 해결하는 핵심 문제가 뭔가요? 누가 뭘 하는지 추적하는 건지, 마감일 가시성 문제인지, 아니면 다른 무언가인지요?"

> **나:** "주로 누가 뭘 하는지 추적하는 거예요. 슬랙 스레드에서 태스크가 사라지거든요."

> **Gestalt** (2라운드 — Proximity): "첫 버전에 묶어야 할 기능이 뭔가요? 태스크 생성 + 담당자 지정인지, 알림 + 상태 업데이트인지요?"

> **나:** "태스크 생성이랑 담당자 지정이 핵심이에요. 알림은 나중에요."

> **Gestalt** (3라운드 — Figure-Ground): "딱 하나만 출시할 수 있다면 뭘 고르겠어요? 그리고 첫 릴리즈에서 선택사항은 뭔가요?"

이런 식으로 5~10라운드 진행돼요. 해상도 점수가 0.8을 넘으면 인터뷰를 끝낼 수 있어요.

> **이미 요구사항이 명확하다면** 인터뷰 없이 바로 스펙을 생성할 수 있어요:
> ```
> ges_generate_spec({ text: "만들고 싶은 것을 여기에 설명하세요" })
> ```
> 결과는 `.gestalt/memory.json`에 저장되고, 이후 스펙에 자동으로 이어져요.

---

## 스펙 생성

인터뷰가 끝나면 실행해요.

```
/spec
```

Gestalt가 구조화된 **Spec** 문서를 만들어줘요. 목표, 제약사항, 측정 가능한 완료 조건이 담겨 있어요. 이 문서가 다음 단계의 실행 계획 입력이 돼요.

---

## 실행 계획 생성

Spec을 행동 가능한 계획으로 변환해요.

```
/execute
```

Gestalt가 요구사항을 태스크로 쪼개고, 의존성을 검증하고, 올바른 순서로 실행 계획을 구성해요.

---

## Passthrough 모드 이해

Gestalt는 Claude Code 안에서 MCP 서버로 동작해요. `/interview`나 `/spec`을 실행하면 Claude Code가 AI 역할을 해요 — Gestalt는 프롬프트와 컨텍스트를 전달하고, 실제 추론은 Claude Code가 담당해요. 서버가 외부 API를 직접 호출하지 않아요.

### CLI 모드 (자동화 / CI)

Claude Code 없이 스크립트나 CI 파이프라인에서 `interview`나 `spec`, `explain-eval`을 돌리려면 API 키를 추가하면 돼요. 이 명령들은 Gestalt가 LLM을 직접 불러요. `explain-check`는 `--judge`를 켤 때만 키를 쓰고 나머지 CLI 명령은 키 없이 돌아요.

프로젝트 루트에 `.env` 파일을 만들거나:

```
ANTHROPIC_API_KEY=your-api-key-here
```

`gestalt.json`에 추가해요:

```json
{
  "llm": { "apiKey": "your-api-key-here" }
}
```

---

## claude.ai 웹에서 사용하기

지금 Gestalt MCP 서버는 stdio 전송만 지원해요. HTTP나 SSE로 띄우는 옵션이 없어서 claude.ai 웹의 Remote MCP 서버로는 바로 연결할 수 없어요. Claude Code나 Codex처럼 서버를 로컬 프로세스로 띄우는 클라이언트에서 쓰세요.

---

## 자주 겪는 문제

**인터뷰가 갑자기 멈췄어요**
→ 같은 주제로 `/interview`를 다시 실행하면 이어서 진행돼요.

**`gestalt requires Node.js` 오류가 떠요**
→ Node.js 22 이상이 필요해요. `nvm install 22 && nvm use 22`를 실행하거나 [nodejs.org](https://nodejs.org)에서 다운로드하세요.

**MCP 서버가 붙었다 안 붙었다 하고 `Connection closed`로 끊겨요**
→ 원인은 대개 Gestalt가 아니라 `npx`예요. `npx`는 버전을 박아도 기동할 때마다 레지스트리를 조회해요. 캐시가 비어 있으면 20초쯤 걸리고 레지스트리에 못 닿으면 70초를 매달리다 실패하는데, Claude Code는 stdio 서버가 `initialize`에 답할 때까지 30초만 기다려요. `npm i -g @tienne/gestalt`로 전역 설치하고 `gestalt serve`를 직접 부르면 이 조회가 아예 없어져요.

**데스크톱 앱에서만 서버가 바로 죽어요**
→ 데스크톱 앱이나 런처처럼 터미널 밖에서 띄운 세션은 PATH에 nvm 같은 버전 매니저가 안 들어 있어요. 그래서 `npx`나 `gestalt`를 못 찾고 바로 죽어요. MCP 설정의 `command`에 절대 경로를 주거나 서버 항목에 `env.PATH`를 넣으세요. 플러그인으로 설치했다면 `scripts/mcp-serve.sh`가 nvm, fnm, Volta, Homebrew에서 Node를 찾아줘서 이 문제를 안 겪어요.

**기동 제한 시간을 늘리고 싶어요**
→ Claude Code는 `startup_timeout_sec`를 안 읽어요. 그건 Codex 설정 키예요. Claude Code에서는 `settings.json`의 `env`에 `MCP_TIMEOUT`(밀리초)을 넣으세요.

```json
{
  "env": { "MCP_TIMEOUT": "180000" }
}
```

---

## 다음 단계

- **[MCP 레퍼런스](./mcp-reference.md)** — 모든 툴, 파라미터, 고급 사용법
- **[인터뷰 엔진 상세](./01-interview.md)** — 내부 동작 원리 깊게 보기
- **[게슈탈트 원리 해설](./gestalt-principles.md)** — 이 접근법의 심리학적 배경
