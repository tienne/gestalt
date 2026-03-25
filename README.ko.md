<p align="center">
  <img src="assets/logo.svg" alt="Gestalt" width="600" />
</p>

<p align="center">
  <strong>Gestalt — AI 개발 하네스</strong><br/>
  모호한 요구사항을 구조화된 실행 계획으로 — Claude Code 안에서 바로.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tienne/gestalt"><img src="https://img.shields.io/npm/v/@tienne/gestalt" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://github.com/tienne/gestalt/actions/workflows/ci.yml"><img src="https://github.com/tienne/gestalt/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

---

## Gestalt는 무엇인가요?

Gestalt는 Claude Code 안에서 실행되는 MCP 서버예요. 구조화된 요구사항 인터뷰를 진행하고, 검증된 **Spec**(목표·제약조건·완료 기준을 담은 JSON 문서)을 생성한 뒤, 그 Spec을 의존성 기반 실행 계획으로 변환해요 — 별도 API 키 없이요.

> **시작 전 확인** — Node.js >= 20.0.0이 필요해요. `nvm install 22 && nvm use 22`로 설치할 수 있어요.

---

## 실제로 어떻게 작동하나요?

> **30초 만에 구조화된 실행 계획** — API 키 없이도 됩니다.

```bash
# Gestalt 기반 요구사항 인터뷰 시작
/interview "사용자 인증 시스템"

# 인터뷰 완료 후 구조화된 Spec 생성
/spec

# Spec을 검증된 실행 계획으로 변환하고 실행
/execute
```

![Gestalt 데모](./docs/demo.gif)
_(데모 영상 준비 중)_

---

## Gestalt가 해결하는 문제

AI에게 무엇을 만들지 설명하는 건 생각보다 어려워요. 방향은 맞는데 세부 구현이 기대와 달라 다시 처음부터 시작하게 되는 일이 생기죠.

Gestalt는 AI가 코드를 작성하기 전에 만들고자 하는 바를 함께 구체화해줘요. 게슈탈트 심리학 원리를 토대로 인터뷰를 진행하면서 "빠진 요구사항은 없는지", "어떤 기능이 핵심인지", "모순되는 조건은 없는지"를 체계적으로 짚어줘요.

인터뷰가 끝나면 그 결과가 **Spec**으로 만들어져요. 목표, 제약조건, 완료 기준을 담은 검증된 문서로, 실행 계획부터 코드 리뷰까지 이후 모든 단계가 이 Spec을 기준으로 동작해요.

### 다섯 가지 게슈탈트 원리

```
Closure      → 빠진 것을 찾아 채웁니다 (암묵적 요구사항)
Proximity    → 관련 기능과 태스크를 도메인별로 그룹화합니다
Similarity   → 요구사항 전반의 반복 패턴을 식별합니다
Figure-Ground → MVP(전경)와 선택사항(배경)을 분리합니다
Continuity   → 의존성 체인을 검증하고 모순을 감지합니다
```

> "전체는 부분의 합보다 크다." — 아리스토텔레스

### Passthrough 모드 — API 키가 필요 없어요

Gestalt는 **MCP 서버**로 실행돼요. Claude Code를 통해 사용할 경우 Claude Code가 LLM 역할을 담당해요 — Gestalt는 프롬프트와 컨텍스트를 반환하고, 실제 추론은 Claude Code가 수행해요. 서버 자체는 별도 API 호출을 하지 않아요.

```
사용자 (Claude Code)
       │
       ▼ /interview "주제"
  Gestalt MCP 서버
  (컨텍스트 + 프롬프트 반환)
       │
       ▼
  Claude Code가 프롬프트 실행
  (질문 생성, 점수 산출, 계획 수립)
       │
       ▼
  Gestalt MCP 서버
  (검증, 상태 저장, 단계 진행)
       │
       ▼ 모호성 ≤ 0.2 될 때까지 반복
  최종 Spec → 실행 계획
```

`ANTHROPIC_API_KEY`는 필요하지 않아요. 모든 LLM 작업은 Claude Code가 처리해요.

> **참고해 주세요** — CLI 직접 실행 모드에서는 `ANTHROPIC_API_KEY`가 필요해요. Claude Code 없이 터미널에서 바로 사용할 경우에만 해당돼요.

---

## 설치

### 옵션 1: Claude Code 플러그인 (권장)

MCP 서버, 슬래시 커맨드 스킬, Gestalt 에이전트, 프로젝트 컨텍스트를 단일 설치로 묶어서 제공합니다.

```bash
# 1단계: 마켓플레이스 등록 (최초 1회)
/plugin marketplace add tienne/gestalt

# 2단계: 플러그인 설치
/plugin install gestalt@gestalt
```

기본 제공 항목:

| 항목 | 내용 |
|------|------|
| **MCP 도구** | `ges_interview`, `ges_generate_spec`, `ges_execute`, `ges_create_agent`, `ges_agent`, `ges_status` |
| **슬래시 커맨드** | `/interview`, `/spec`, `/execute`, `/agent` |
| **에이전트** | Gestalt 파이프라인 에이전트 5개 + Role 에이전트 9개 + Review 에이전트 3개 |
| **CLAUDE.md** | 프로젝트 컨텍스트 및 MCP 사용 가이드 자동 주입 |

> **Node.js >= 20.0.0** 필요 — [nvm](https://github.com/nvm-sh/nvm) 사용 시: `nvm install 22 && nvm use 22`

---

### 옵션 2: Claude Code Desktop

Claude Code Desktop 설정에서 `settings.json` (또는 `claude_desktop_config.json`)에 추가:

```json
{
  "mcpServers": {
    "gestalt": {
      "command": "npx",
      "args": ["-y", "@tienne/gestalt"]
    }
  }
}
```

Claude Code Desktop을 재시작합니다. MCP 도구가 즉시 사용 가능해집니다. 슬래시 커맨드는 플러그인 설치 또는 별도 스킬 설정이 필요합니다.

---

### 옵션 3: Claude Code CLI

```bash
# claude CLI로 추가
claude mcp add gestalt -- npx -y @tienne/gestalt
```

또는 `~/.claude/settings.json`을 직접 편집:

```json
{
  "mcpServers": {
    "gestalt": {
      "command": "npx",
      "args": ["-y", "@tienne/gestalt"]
    }
  }
}
```

---

## 사용법: 전체 파이프라인

### 1단계 — 인터뷰

주제를 입력해 인터뷰를 시작합니다. 한 줄짜리 문장도 충분합니다.

```bash
/interview "Stripe로 결제 플로우를 만들고 싶어"
```

각 라운드는 특정 모호성 차원을 타겟으로 진행됩니다:

- **Closure** — 빠진 게 뭔가요? 말하지 않고 가정한 건요?
- **Proximity** — 어떤 기능들이 함께 속하나요?
- **Similarity** — 요구사항에 반복되는 패턴이 있나요?
- **Figure-Ground** — 핵심 MVP와 선택 사항은 무엇인가요?
- **Continuity** — 모순이나 충돌이 있나요?

**모호성 점수가 ≤ 0.2에 도달할 때까지** 인터뷰가 계속됩니다:

```
1라운드 → 모호성: 0.72  (모르는 것이 많음)
4라운드 → 모호성: 0.45  (점점 명확해짐)
8라운드 → 모호성: 0.19  ✓ Spec 생성 준비 완료
```

---

### 2단계 — Spec 생성

모호성 점수가 ≤ 0.2에 도달하면 실행합니다:

```bash
/spec
```

파이프라인 전체를 구동하는 구조화된 **Spec**을 생성합니다:

```
goal                → 명확하고 모호성 없는 프로젝트 목표
constraints         → 기술적·비즈니스적 제약 조건
acceptanceCriteria  → 측정 가능한 완료 기준
ontologySchema      → 엔티티-관계 모델 (entities + relations)
gestaltAnalysis     → 게슈탈트 원리별 핵심 발견 사항
```

---

### 3단계 — Execute (계획 + 실행)

Spec을 의존성 기반 실행 계획으로 변환하고 실행합니다:

```bash
/execute
```

**Planning 단계**에서 4가지 게슈탈트 원리를 고정 순서로 적용합니다:

| 단계 | 원리 | 역할 |
|:---:|-----------|-------------|
| 1 | **Figure-Ground** | 완료 조건(AC)을 핵심(전경) vs. 보조(배경)로 분류 |
| 2 | **Closure** | AC를 원자적 태스크로 분해 (암묵적 태스크 포함) |
| 3 | **Proximity** | 관련 태스크를 도메인별 그룹으로 묶음 |
| 4 | **Continuity** | 의존성 DAG 검증 — 순환 없음, 위상 정렬 순서 확인 |

**Execution 단계**에서 위상 정렬 순서대로 태스크를 실행합니다. 각 태스크 후 **Drift Detection**이 Spec과의 정렬 상태를 확인합니다:

- 3차원 점수: Goal (50%) + Constraint (30%) + Ontology (20%)
- Jaccard 유사도 기반 측정
- Threshold 초과 시 자동으로 소급 검토 트리거

---

### 4단계 — Evaluate (평가)

실행 후 2단계 평가가 자동으로 실행됩니다:

| 단계 | 방식 | 실패 시 |
|:---:|-------|-----------|
| 1 | **Structural** — lint → build → test 실행 | 단락(short-circuit); 2단계 스킵 |
| 2 | **Contextual** — LLM이 각 AC + goal alignment 검증 | Evolution Loop 진입 |

**성공 조건:** `score ≥ 0.85` AND `goalAlignment ≥ 0.80`

---

### 5단계 — Evolve (진화)

평가가 실패하면 Evolution Loop가 동작합니다. 세 가지 복구 흐름을 제공합니다:

**Flow A — Structural Fix** (lint/build/test 실패 시)
```
evolve_fix → 수정 태스크 제출 → 재평가
```

**Flow B — Contextual Evolution** (AC 점수 미달 시)
```
evolve → Spec 패치 (AC/constraints) → 영향받은 태스크 재실행 → 재평가
```

Spec 패치 범위: AC와 constraints는 자유 수정; ontology는 추가/변경만; **goal은 변경 불가**.

**Flow C — Lateral Thinking** (스태그네이션 감지 시)

종료하는 대신 Lateral Thinking Persona를 순환하며 다른 접근을 시도합니다:

| 스태그네이션 패턴 | Persona | 전략 |
|--------------------|---------|---------|
| Hard cap 도달 | **Multistability** | 다른 각도로 보기 |
| 진동하는 점수 | **Simplicity** | 단순하게 줄이고 수렴 |
| 진전 없음 (no drift) | **Reification** | 빠진 것 채우기 |
| 수익 체감 | **Invariance** | 성공한 패턴 복제 |

4개 Persona를 모두 소진하면 세션이 **Human Escalation**으로 종료됩니다 — 수동 해결을 위한 구체적인 제안 목록과 함께.

**종료 조건:**

| 조건 | 트리거 |
|-----------|---------|
| `success` | score ≥ 0.85 AND goalAlignment ≥ 0.80 |
| `stagnation` | 2회 연속 delta < 0.05 |
| `oscillation` | 2회 연속 점수 역전 |
| `hard_cap` | structural 3회 + contextual 3회 실패 |
| `caller` | 수동 종료 |
| `human_escalation` | 4개 lateral persona 모두 소진 |

---

### 6단계 — Code Review (코드 리뷰)

Evolution 완료 후 코드 리뷰 파이프라인이 자동으로 실행됩니다:

```
review_start → 에이전트 관점 제출 → 합의 → 자동 수정
```

9개의 내장 **Role 에이전트**가 다중 관점 리뷰를 제공합니다:

| 에이전트 | 도메인 |
|-------|--------|
| `architect` | 시스템 설계, 확장성 |
| `frontend-developer` | UI, React, 접근성 |
| `backend-developer` | API, 데이터베이스, 서버 |
| `devops-engineer` | CI/CD, 인프라, 모니터링 |
| `qa-engineer` | 테스팅, 품질, 자동화 |
| `designer` | UX/UI, 디자인 시스템 |
| `product-planner` | 로드맵, 사용자 스토리, 지표 |
| `researcher` | 분석, 데이터, 벤치마크 |
| `technical-writer` | 문서화, API 문서, 가이드, README |

3개의 내장 **Review 에이전트**가 집중 코드 분석을 수행합니다:

| 에이전트 | 집중 영역 |
|-------|-------|
| `security-reviewer` | 인젝션, XSS, 인증 취약점, 시크릿 |
| `performance-reviewer` | 메모리 누수, N+1 쿼리, 번들 크기, 비동기 |
| `quality-reviewer` | 가독성, SOLID, 에러 핸들링, DRY |

파이프라인 밖에서도 `/agent`로 언제든 에이전트를 사용할 수 있습니다:

```bash
# 사용 가능한 에이전트 목록 조회
/agent

# 특정 에이전트로 임의 태스크 실행
/agent architect "이 코드베이스의 모듈 경계를 리뷰해줘"
/agent security-reviewer "이 인증 코드의 취약점을 확인해줘"
/agent technical-writer "이 모듈의 README를 작성해줘"
```

인터뷰 결과에서 커스텀 Role 에이전트를 생성할 수 있어요:

```
# 인터뷰 완료 후 커스텀 에이전트 생성

# 1단계: 에이전트 생성 컨텍스트 요청
ges_create_agent  →  action: "start", sessionId: "<id>"
                  →  agentContext 반환 (systemPrompt, creationPrompt, schema)

# 2단계: 생성한 AGENT.md 내용 제출
ges_create_agent  →  action: "submit", sessionId: "<id>", agentContent: "..."
                  →  agents/{name}/AGENT.md 생성
```

---

### 대안: CLI 직접 실행 모드

`ANTHROPIC_API_KEY` 필요. Claude Code 없이 터미널에서 직접 실행합니다:

```bash
# 인터랙티브 인터뷰 시작
npx @tienne/gestalt interview "주제"

# 완료된 세션에서 Spec 생성
npx @tienne/gestalt spec <session-id>

# 전체 세션 목록 확인
npx @tienne/gestalt status

# gestalt.json 설정 파일 생성
npx @tienne/gestalt setup

# MCP 서버 수동 시작
npx @tienne/gestalt serve
```

---

## 설정

IDE 자동완성 지원과 함께 `gestalt.json`을 생성합니다:

```bash
npx @tienne/gestalt setup
```

```json
{
  "$schema": "./node_modules/@tienne/gestalt/schemas/gestalt.schema.json",
  "llm": {
    "model": "claude-sonnet-4-20250514"
  },
  "interview": {
    "ambiguityThreshold": 0.2,
    "maxRounds": 10
  },
  "execute": {
    "driftThreshold": 0.3,
    "successThreshold": 0.85,
    "goalAlignmentThreshold": 0.80
  }
}
```

**설정 우선순위** (높음 → 낮음): 코드 override → 쉘 환경변수 → `.env` → `gestalt.json` → 기본값

잘못된 값은 경고를 출력하고 기본값으로 fallback합니다.

### 환경변수

| 변수 | Config 경로 | 기본값 | 설명 |
|----------|-------------|---------|-------------|
| `ANTHROPIC_API_KEY` | `llm.apiKey` | `""` | CLI 직접 모드에서만 필요 |
| `GESTALT_MODEL` | `llm.model` | `claude-sonnet-4-20250514` | LLM 모델 (provider 모드) |
| `GESTALT_AMBIGUITY_THRESHOLD` | `interview.ambiguityThreshold` | `0.2` | 인터뷰 완료 임계값 |
| `GESTALT_MAX_ROUNDS` | `interview.maxRounds` | `10` | 최대 인터뷰 라운드 수 |
| `GESTALT_DRIFT_THRESHOLD` | `execute.driftThreshold` | `0.3` | 태스크 drift 감지 임계값 |
| `GESTALT_EVOLVE_SUCCESS_THRESHOLD` | `execute.successThreshold` | `0.85` | Evolution 성공 점수 |
| `GESTALT_EVOLVE_GOAL_ALIGNMENT_THRESHOLD` | `execute.goalAlignmentThreshold` | `0.80` | Goal alignment 임계값 |
| `GESTALT_DB_PATH` | `dbPath` | `~/.gestalt/events.db` | SQLite 이벤트 스토어 경로 |
| `GESTALT_SKILLS_DIR` | `skillsDir` | `skills` | 커스텀 스킬 디렉토리 |
| `GESTALT_AGENTS_DIR` | `agentsDir` | `agents` | 커스텀 에이전트 디렉토리 |
| `GESTALT_LOG_LEVEL` | `logLevel` | `info` | 로그 레벨 (`debug`/`info`/`warn`/`error`) |

---

## 아키텍처

![Gestalt 아키텍처](./docs/architecture.png)
_(다이어그램 준비 중)_

```
Claude Code (여러분)
     │
     ▼  MCP / stdio transport
┌──────────────────────────────────┐
│        Gestalt MCP 서버           │
│                                  │
│  Interview Engine                │
│  ├─ GestaltPrincipleSelector     │
│  ├─ AmbiguityScorer              │
│  └─ SessionManager               │
│                                  │
│  Spec Generator                  │
│  └─ PassthroughSpecGenerator     │
│                                  │
│  Execute Engine                  │
│  ├─ DAG Validator                │
│  ├─ DriftDetector                │
│  ├─ EvaluationEngine             │
│  └─ ExecuteSessionManager        │
│                                  │
│  Resilience Engine               │
│  ├─ StagnationDetector           │
│  ├─ LateralThinkingPersonas      │
│  └─ HumanEscalation              │
│                                  │
│  Agent System                    │
│  ├─ RoleAgentRegistry            │
│  ├─ RoleMatchEngine              │
│  └─ RoleConsensusEngine          │
│                                  │
│  EventStore (SQLite WAL)         │
└──────────────────────────────────┘
```

---

## 라이선스

MIT © [tienne](https://github.com/tienne)
