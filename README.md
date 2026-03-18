<p align="center">
  <img src="assets/logo.svg" alt="Gestalt" width="600" />
</p>

<p align="center">
  <strong>Gestalt psychology-driven AI development harness</strong><br/>
  Transforms scattered requirements into structured, validated specifications through interactive interviews.
</p>

<p align="center">
  <a href="https://github.com/tienne/gestalt/actions/workflows/ci.yml"><img src="https://github.com/tienne/gestalt/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@tienne/gestalt"><img src="https://img.shields.io/npm/v/@tienne/gestalt" alt="npm version" /></a>
</p>

---

## Installation

### Claude Plugin (Recommended)

```bash
# 1. 마켓플레이스 등록 (최초 1회)
/plugin marketplace add tienne/gestalt

# 2. 플러그인 설치
/plugin install gestalt@gestalt
```

Skills, agents, MCP tools, and CLAUDE.md are all configured automatically.

### Claude Code MCP

```bash
claude mcp add gestalt -- npx -y @tienne/gestalt
```

### npx (No Install)

```bash
npx -y @tienne/gestalt
```

### Global Install

```bash
npm install -g @tienne/gestalt
gestalt
```

## How It Works

```
Interview → Spec → Execute → Evaluate → Evolve
                                           ↓
                              Lateral Thinking (resilience)
                                           ↓
                              Human Escalation (if exhausted)
```

### 1. Interview

Gestalt 원리가 각 라운드의 질문 방향을 가이드하여 **모호성 점수(ambiguity score)가 0.2 이하**로 떨어질 때까지 요구사항을 명확화한다.

- 프로젝트 유형 자동 감지 (greenfield / brownfield)
- 5가지 Gestalt 원리 기반 동적 질문 선택 알고리즘
- 차원별 가중치 기반 모호성 점수 산출
- 모순 감지 시 Continuity 원리 자동 개입 + 페널티 부여

### 2. Spec Generation

완료된 인터뷰에서 **구조화된 프로젝트 스펙**을 생성한다. 2-Call Passthrough 패턴으로 동작.

```
Call 1: specContext 요청 → systemPrompt + specPrompt + 전체 인터뷰 라운드 반환
Call 2: caller가 생성한 Spec JSON 제출 → Zod 검증 후 저장
```

Spec 구성요소: `goal`, `constraints`, `acceptanceCriteria`, `ontologySchema` (entities + relations), `gestaltAnalysis`

### 3. Execute (Planning)

Gestalt 4원리를 **고정 순서**로 적용하여 실행 계획을 수립한다.

| Step | Principle | 역할 |
|:---:|---|---|
| 1 | **Figure-Ground** | AC를 essential(figure) / supplementary(ground)로 분류 |
| 2 | **Closure** | AC를 원자적 태스크로 분해 (암묵적 하위 태스크 포함) |
| 3 | **Proximity** | 관련 태스크를 도메인/기능 영역별로 그룹핑 |
| 4 | **Continuity** | DAG 검증 — 순환 의존, 그룹 간 충돌 확인, 위상 정렬 |

결과물: `ExecutionPlan` (classifiedACs, atomicTasks, taskGroups, dagValidation, criticalPath)

### 4. Execute (Execution) + Drift Detection

위상 정렬 순서대로 태스크를 실행하며, **Similarity 원리**를 활용하여 유사 패턴의 완료된 태스크를 참조 컨텍스트로 제공한다.

매 태스크 완료 시 **Drift Detection**이 자동 실행된다:

- **3차원 가중합**: Goal(50%) + Constraint(30%) + Ontology(20%)
- Jaccard 기반 키워드 유사도 측정
- Threshold(기본 0.3) 초과 시 `retrospectiveContext` 반환

### 5. Evaluate (2-Stage)

| Stage | 이름 | 방식 | 실패 시 |
|:---:|---|---|---|
| 1 | **Structural** | lint → build → test 자동 검증 | Contextual 스킵 (short-circuit) |
| 2 | **Contextual** | LLM 기반 AC 검증 + goalAlignment | Evolution Loop 진입 |

성공 조건: `overallScore ≥ 0.85` && `goalAlignment ≥ 0.80`

### 6. Evolution Loop

Evaluate 실패 시 3가지 경로로 자동 복구를 시도한다:

**Flow A — Structural Fix** (structural 실패 시)
```
evolve_fix → fixTasks 제출 → re-evaluate
```

**Flow B — Contextual Evolution** (contextual 점수 미달 시)
```
evolve → evolve_patch(specPatch) → evolve_re_execute(impacted tasks) → re-evaluate
```

Spec Patch 범위: AC + constraints 자유 수정, ontology 추가/변경만, **goal 변경 금지**

**Flow C — Lateral Thinking** (stagnation 감지 시 자동 분기)

evolve 호출 시 stagnation이 감지되면 즉시 종료하는 대신 **Lateral Thinking Persona**로 자동 분기한다. (아래 섹션 참조)

**종료 조건:**

| 조건 | 설명 |
|---|---|
| `success` | score ≥ 0.85, goalAlignment ≥ 0.80 |
| `stagnation` | 2회 연속 delta < 0.05 |
| `oscillation` | 2회 연속 점수 진동 (up↔down) |
| `hard_cap` | structural 3회 + contextual 3회 실패 |
| `caller` | 사용자 수동 종료 |
| `human_escalation` | Lateral Thinking 4개 persona 모두 실패 |

## Gestalt Principles

Each letter in the logo represents a core Gestalt principle used throughout the system:

| Principle | Role in Gestalt |
|-----------|----------------|
| **Closure** | Finds implicit requirements that aren't explicitly stated |
| **Proximity** | Groups related requirements and tasks by domain |
| **Continuation** | Validates dependency chains and execution order (DAG) |
| **Similarity** | Identifies repeating patterns across requirements |
| **Figure & Ground** | Separates core (figure) from supporting (ground) requirements |

> For a deep dive into how each principle maps to interview strategies, ambiguity scoring, and the dynamic principle selection algorithm, see [Gestalt 5원리 상세 문서](docs/gestalt-principles.md).

## Lateral Thinking Personas

Evolution Loop에서 stagnation이 감지되면 패턴을 분류하고 매칭되는 persona를 활성화한다:

| Stagnation Pattern | Persona | Strategy |
|--------------------|---------|----------|
| Spinning (hard cap) | **Multistability** | See from a different angle |
| Oscillation | **Simplicity** | Simplify and converge |
| No drift | **Reification** | Fill in missing pieces |
| Diminishing returns | **Invariance** | Replicate success patterns |

4개 persona를 순차적으로 시도한다. 모두 실패하면 **Human Escalation**을 트리거하여 사용자에게 actionable suggestions를 제공한다.

## Role Agent System

**8개의 내장 Role Agent**가 Execute Phase에서 다중 관점을 제공한다.

| Agent | Domain | Description |
|---|---|---|
| `architect` | system design, scalability | 시스템 아키텍처 전문가 |
| `backend-developer` | api, database, server | 백엔드 개발 전문가 |
| `frontend-developer` | ui, react, css, accessibility | 프론트엔드 개발 전문가 |
| `designer` | ux, ui, design system | UX/UI 디자인 전문가 |
| `devops-engineer` | ci/cd, infra, monitoring | DevOps/인프라 전문가 |
| `product-planner` | roadmap, user story, metrics | 제품 기획 전문가 |
| `qa-engineer` | testing, quality, automation | QA/테스트 전문가 |
| `researcher` | analysis, data, benchmarks | 리서치 및 분석 전문가 |

### 동작 방식

Execute Phase에서 각 태스크마다 2단계로 진행된다:

1. **Role Match** — 태스크의 도메인 키워드와 매칭되는 Role Agent를 동적으로 선택
2. **Role Consensus** — 선택된 Agent들의 관점을 수집하고, 충돌을 해소하여 통합 가이던스 생성

### Custom Agent 생성

`ges_create_agent` 도구로 **인터뷰 결과를 기반으로 커스텀 Role Agent를 생성**할 수 있다:

```
# 1. 인터뷰 완료 후 agent creation context 요청
ges_create_agent({ action: "start", sessionId: "<id>" })
→ systemPrompt + creationPrompt + agentMdSchema 반환

# 2. AGENT.md 콘텐츠 생성 후 제출
ges_create_agent({ action: "submit", sessionId: "<id>", agentContent: "---\nname: ..." })
→ agents/{name}/AGENT.md 파일 생성
```

커스텀 Agent는 `agents/` 디렉토리에 저장되며, 동일 이름의 내장 Agent를 override할 수 있다.

### AGENT.md 포맷

```yaml
---
name: security-expert        # 에이전트 이름 (kebab-case)
tier: standard                # frugal | standard | frontier
pipeline: execute             # interview | spec | execute | evaluate
role: true                    # Role Agent 필수
domain: ["oauth", "jwt"]      # 도메인 키워드 목록
description: "보안 전문가"     # 한줄 설명
---

System prompt 내용 (Markdown)
```

## MCP Tools

5 MCP tools exposed in passthrough mode (no API key required):

| Tool | Description |
|---|---|
| `ges_interview` | Gestalt-driven requirement interview (start, respond, score, complete) |
| `ges_generate_spec` | Generate a structured Spec from completed interview (2-Call) |
| `ges_execute` | Execute Spec via Gestalt pipeline (plan, execute, evaluate, evolve, lateral thinking, role agents) |
| `ges_create_agent` | Create custom Role Agent from completed interview (2-Call: start, submit) |
| `ges_status` | Check session status |

## Skill System

`skills/` 디렉토리의 SKILL.md 파일로 각 파이프라인 단계의 동작을 정의한다.

| Skill | Description |
|---|---|
| `interview` | 인터뷰 프로세스 — 4단계 (start → iterate → score → complete) |
| `spec` | Spec 생성 프로세스 — 2-Call Passthrough 패턴 |
| `execute` | 실행 계획 수립 — 4단계 Planning + Execution + Evaluation |

### SKILL.md 포맷

```yaml
---
name: interview
version: "1.0.0"
description: "Gestalt-driven interview"
triggers: ["interview", "clarify requirements"]
inputs:
  topic: { type: string, required: true }
outputs: [session, ambiguityScore]
---

Skill documentation (Markdown)
```

커스텀 Skill은 `skills/` 디렉토리에 추가하면 **chokidar hot-reload**로 자동 로드된다.

## Multi-provider LLM

Agent System의 **FiguralRouter**가 에이전트의 tier에 따라 다른 LLM provider를 라우팅한다:

| Tier | Provider | Model Example | Use Case |
|---|---|---|---|
| `frugal` | OpenAI | gpt-4o-mini | 반복적/저비용 태스크 (proximity-worker) |
| `standard` | Anthropic | claude-sonnet | 일반 태스크 (closure-completer, ground-mapper) |
| `frontier` | Anthropic | claude-opus | 고품질 판단 (continuity-judge) |

이를 위해 `@anthropic-ai/sdk`와 `openai` 두 SDK가 모두 포함되어 있다. Passthrough 모드에서는 caller가 LLM 호출을 하므로 이 라우팅이 적용되지 않는다.

## Event Sourcing

모든 세션 활동은 **SQLite WAL 모드 이벤트 스토어**에 기록된다.

- Interview 이벤트: session started/completed, question asked, response recorded, ambiguity scored
- Execute 이벤트: planning steps, task completed, drift measured
- Evaluate 이벤트: structural/contextual results, short-circuit
- Evolution 이벤트: spec patched, lateral thinking, human escalation
- Agent 이벤트: role match/consensus, agent created

완전한 audit trail로 세션 히스토리 재생 및 사후 분석이 가능하다.

## CLI Commands

```bash
gestalt                    # Start MCP server (default)
gestalt serve              # Start MCP server (explicit)
gestalt interview "topic"  # Interactive interview
gestalt spec <session-id>  # Generate Spec from interview
gestalt status             # List all sessions
gestalt setup              # Generate gestalt.json config file
gestalt monitor            # TUI dashboard (real-time session monitoring)
```

### TUI Dashboard

`gestalt monitor` 명령으로 터미널 기반 대시보드를 실행한다:

- **Session List** — 진행 중인 세션 목록 및 상태
- **Interview Monitor** — 실시간 인터뷰 진행 상황 + Gestalt 원리 표시
- **Evolution Tracker** — Evolution Loop 진행, Drift 수치 게이지
- **Task DAG Tree** — 태스크 의존성 관계 시각화
- **Spec Viewer** — 생성된 Spec 조회
- **Event Log** — 실시간 이벤트 로그

## Configuration

Run `gestalt setup` to generate a `gestalt.json` configuration file with IDE autocompletion support.

```json
{
  "$schema": "./node_modules/@tienne/gestalt/schemas/gestalt.schema.json",
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

Configuration is loaded with the following priority (highest → lowest):

1. Code overrides (`loadConfig(overrides)`)
2. Shell environment variables (`GESTALT_*`)
3. `.env` file
4. `gestalt.json`
5. Built-in defaults

Invalid values trigger a warning and fall back to defaults.

### Environment Variables

| Variable | Config Path | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | `llm.apiKey` | `""` |
| `GESTALT_MODEL` | `llm.model` | `claude-sonnet-4-20250514` |
| `GESTALT_AMBIGUITY_THRESHOLD` | `interview.ambiguityThreshold` | `0.2` |
| `GESTALT_MAX_ROUNDS` | `interview.maxRounds` | `10` |
| `GESTALT_DRIFT_THRESHOLD` | `execute.driftThreshold` | `0.3` |
| `GESTALT_EVOLVE_SUCCESS_THRESHOLD` | `execute.successThreshold` | `0.85` |
| `GESTALT_EVOLVE_GOAL_ALIGNMENT_THRESHOLD` | `execute.goalAlignmentThreshold` | `0.80` |
| `GESTALT_DB_PATH` | `dbPath` | `~/.gestalt/events.db` |
| `GESTALT_SKILLS_DIR` | `skillsDir` | `skills` |
| `GESTALT_AGENTS_DIR` | `agentsDir` | `agents` |
| `GESTALT_LOG_LEVEL` | `logLevel` | `info` |

## Operating Modes

Gestalt supports two operating modes:

| Mode | API Key | LLM Calls | Use Case |
|---|---|---|---|
| **Passthrough** (default) | Not needed | Caller (e.g., Claude Code) | MCP 통합 환경에서 권장 |
| **Provider-backed** | `ANTHROPIC_API_KEY` 필요 | Gestalt가 직접 호출 | 독립 실행 (CLI 등) |

### Passthrough Mode

Gestalt runs in passthrough mode by default: it returns prompts and context to the calling LLM (e.g., Claude Code) instead of making its own API calls. No `ANTHROPIC_API_KEY` needed.

### Provider-backed Mode

`ANTHROPIC_API_KEY`를 설정하면 Gestalt가 직접 LLM 호출을 수행한다. CLI 명령어(`gestalt interview`, `gestalt spec`)는 이 모드에서 동작한다.

### N-Call Passthrough Pattern

All MCP tools follow a consistent **N-Call Passthrough Pattern**:

```
Call 1: Context 요청 → systemPrompt + actionPrompt 반환
Call N: Caller가 LLM으로 결과 생성 → 제출 및 검증
```

| Tool | Pattern | Calls |
|---|---|---|
| `ges_interview` | Multi-Call | start → (respond + score) × N → complete |
| `ges_generate_spec` | 2-Call | specContext 요청 → spec JSON 제출 |
| `ges_execute` | Multi-Call | plan (4-step) → execute → evaluate (2-stage) → evolve |
| `ges_create_agent` | 2-Call | agentContext 요청 → agentContent 제출 |

## Benchmarks

`pnpm bench`로 파이프라인 벤치마크를 실행할 수 있다. 3개의 시나리오가 Interview → Spec → Execute → Evaluate 전체 파이프라인을 통과한다.

```bash
pnpm bench                          # 전체 시나리오 실행
pnpm bench -s auth-system           # 특정 시나리오만 실행
pnpm bench -o benchmarks/results    # 결과 출력 디렉토리 지정
```

### Latest Results

| Scenario | Tasks | Completion | Score | Goal Alignment | ACs |
|----------|-------|------------|-------|----------------|-----|
| auth-system | 7 | 100% | 0.92 | 0.90 | 5/5 |
| dashboard | 6 | 100% | 0.88 | 0.85 | 4/4 |
| api-gateway | 8 | 100% | 0.95 | 0.92 | 5/5 |

**Average Score: 0.92 | Average Goal Alignment: 0.89**

## License

MIT
