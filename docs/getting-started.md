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

> Node.js 20 이상이 필요해요. 버전이 낮다면 `nvm install 22 && nvm use 22`를 먼저 실행하세요.

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

이런 식으로 5~10라운드 진행돼요. 해상도 점수가 0.8을 넘으면 자동으로 완료돼요.

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

Claude Code 없이 스크립트나 CI 파이프라인에서 Gestalt를 돌리고 싶다면, API 키를 추가하면 돼요. Gestalt가 자체적으로 LLM 호출을 처리해요.

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

[claude.ai](https://claude.ai)에서도 Remote MCP 서버로 연결해 쓸 수 있어요.

### 옵션 A: 직접 호스팅

```bash
# 전역 설치
npm install -g @tienne/gestalt

# HTTP 서버로 시작 (기본 포트 3000)
gestalt serve --port 3000
```

[claude.ai](https://claude.ai) → **Settings → Integrations → Add MCP Server**에서:
- **Name:** Gestalt
- **URL:** `http://localhost:3000/sse` (또는 서버 공개 URL)

### 옵션 B: 클라우드 배포

Railway, Render, Fly.io 같은 플랫폼에 배포하고 공개 URL을 MCP 엔드포인트로 사용해요.

```bash
railway up
# → https://your-app.railway.app
# MCP URL: https://your-app.railway.app/sse
```

연결 후 채팅에서 MCP 툴을 직접 호출할 수 있어요:

```
ges_interview({ action: "start", topic: "프로젝트 아이디어" })
```

> `/interview`, `/spec`, `/execute` 슬래시 명령은 Claude Code 플러그인 전용이에요. claude.ai 웹에서는 MCP 툴 형태로 써야 해요.

> 대부분의 경우 Claude Code + 플러그인이 가장 편해요. 웹 옵션은 팀 전체가 하나의 Gestalt 인스턴스를 공유하고 싶을 때 유용해요.

---

## 자주 겪는 문제

**인터뷰가 갑자기 멈췄어요**
→ 같은 주제로 `/interview`를 다시 실행하면 이어서 진행돼요.

**"Node.js >= 20.0.0 required" 오류가 떠요**
→ `nvm install 22 && nvm use 22`를 실행하거나 [nodejs.org](https://nodejs.org)에서 다운로드하세요.

---

## 다음 단계

- **[MCP 레퍼런스](./mcp-reference.md)** — 모든 툴, 파라미터, 고급 사용법
- **[인터뷰 엔진 상세](./01-interview.md)** — 내부 동작 원리 깊게 보기
- **[게슈탈트 원리 해설](./gestalt-principles.md)** — 이 접근법의 심리학적 배경
