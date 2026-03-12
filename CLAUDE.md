# Gestalt — AI Development Harness

## Overview
게슈탈트 심리학 원리를 요구사항 명확화 프로세스에 매핑한 TypeScript 기반 AI 개발 하네스.
"전체는 부분의 합보다 크다" — 흩어진 요구사항 조각들을 모아 완전한 스펙(Spec)으로 결정화.

## Architecture
- **Interview Engine**: 게슈탈트 원리 기반 Q&A로 모호성 점수를 0.2 이하로 낮춤
- **Spec Generator**: 완료된 인터뷰에서 구조화된 프로젝트 스펙(Spec) 생성
- **Execute Engine**: 게슈탈트 5원리를 실행 전략으로 사용, Spec→ExecutionPlan 변환 (Figure-Ground→Closure→Proximity→Continuity)
- **Resilience Engine**: Stagnation 감지 → Lateral Thinking Personas → Human Escalation
- **MCP Server**: stdio transport로 Claude Code 등 AI 에이전트와 통합
- **Skill System**: SKILL.md 기반 확장, chokidar hot-reload 지원
- **Event Store**: better-sqlite3 WAL 모드 이벤트 소싱

## Tech Stack
TypeScript 5.x / ESM / pnpm / vitest
Dependencies: @anthropic-ai/sdk, @modelcontextprotocol/sdk, better-sqlite3, zod, chokidar, commander, gray-matter

## Key Commands
```bash
pnpm test          # Run all tests (vitest)
pnpm run serve     # Start MCP server
pnpm tsx bin/gestalt.ts interview "topic"  # Interactive interview
pnpm tsx bin/gestalt.ts spec <session-id>  # Generate spec
pnpm tsx bin/gestalt.ts status             # Check sessions
```

## MCP Tools
- `ges_interview`: action=[start|respond|score|complete]
- `ges_generate_spec`: sessionId, force?
- `ges_execute`: action=[start|plan_step|plan_complete|execute_start|execute_task|evaluate|status|evolve_fix|evolve|evolve_patch|evolve_re_execute|evolve_lateral|evolve_lateral_result]
- `ges_status`: sessionId?

## MCP Passthrough Mode

API 키(`ANTHROPIC_API_KEY`) 없이 MCP 서버 실행 시 자동 활성화. LLM 호출을 서버가 하지 않고, caller(Claude Code 등)에게 위임한다.

### 설정 (claude_desktop_config.json / settings.json)
```json
{
  "mcpServers": {
    "gestalt": {
      "command": "npx",
      "args": ["tsx", "bin/gestalt.ts", "serve"]
    }
  }
}
```
> `env`에 `ANTHROPIC_API_KEY`를 넣지 않으면 passthrough 모드로 동작.

### Interview → Spec 전체 플로우

**Step 1: 인터뷰 시작**
```
ges_interview({ action: "start", topic: "사용자 인증 시스템" })
```
→ `gestaltContext` 반환 (systemPrompt, questionPrompt, currentPrinciple, phase 등)

**Step 2: 질문 생성 (caller 수행)**
`gestaltContext.systemPrompt` + `gestaltContext.questionPrompt`를 사용해 질문을 생성한다.

**Step 3: 사용자 응답 수집 후 전달**
```
ges_interview({
  action: "respond",
  sessionId: "<sessionId>",
  response: "사용자 답변",
  generatedQuestion: "caller가 생성한 질문",
  ambiguityScore: {              // 선택사항
    goalClarity: 0.7,
    constraintClarity: 0.5,
    successCriteria: 0.4,
    priorityClarity: 0.6
  }
})
```
→ 다음 `gestaltContext` + `ambiguityScore` 반환. `ambiguityScore.isReady === true`가 될 때까지 반복.

**Step 4: 스코어링 (선택)**
respond 시 ambiguityScore를 안 보냈다면 별도로 요청 가능:
```
ges_interview({ action: "score", sessionId: "<id>" })
→ scoringPrompt 반환 → caller가 점수 산출 →
ges_interview({ action: "score", sessionId: "<id>", ambiguityScore: {...} })
```

**Step 5: 인터뷰 완료**
```
ges_interview({ action: "complete", sessionId: "<id>" })
```

**Step 6: Spec 생성 (2단계)**
```
// 6a: specContext 요청
ges_generate_spec({ sessionId: "<id>" })
→ specContext (systemPrompt, specPrompt, allRounds) 반환

// 6b: caller가 spec JSON 생성 후 제출
ges_generate_spec({
  sessionId: "<id>",
  spec: {
    goal: "...",
    constraints: ["..."],
    acceptanceCriteria: ["..."],
    ontologySchema: { entities: [...], relations: [...] },
    gestaltAnalysis: [{ principle: "closure", finding: "...", confidence: 0.9 }]
  }
})
→ Zod 검증 후 최종 Spec 반환
```

### Spec → Execute 플로우

**Step 1: 실행 계획 세션 시작**
```
ges_execute({ action: "start", spec: { ...completeSpecObject } })
```
→ `executeContext` 반환 (systemPrompt, planningPrompt, currentPrinciple 등)

**Step 2~5: 4단계 계획 수립 (caller가 각 단계 결과를 생성)**
```
// Figure-Ground → Closure → Proximity → Continuity 순서로 진행
ges_execute({
  action: "plan_step",
  sessionId: "<id>",
  stepResult: { principle: "figure_ground", classifiedACs: [...] }
})
→ 다음 단계 executeContext 반환. isLastStep === true가 될 때까지 반복.
```

**Step 6: 실행 계획 조립**
```
ges_execute({ action: "plan_complete", sessionId: "<id>" })
→ ExecutionPlan (classifiedACs, atomicTasks, taskGroups, dagValidation) 반환
```

### Execute → Evaluate → Evolution 플로우

**Execution Phase**: execute_start → execute_task (반복) → evaluate (3-Call: structural → contextual)

**Evolution Loop** (Evaluate 점수가 threshold 미달 시):

**Flow A: Structural Fix** (structural 실패 시)
```
// 1. Fix context 요청
ges_execute({ action: "evolve_fix", sessionId: "<id>" })
→ fixContext 반환

// 2. Fix tasks 제출
ges_execute({ action: "evolve_fix", sessionId: "<id>", fixTasks: [...] })
→ 상태 복원, evaluate 재실행 가능

// 3. Re-evaluate
ges_execute({ action: "evaluate", sessionId: "<id>" })
```

**Flow B: Contextual Evolution** (structural 통과, contextual 점수 미달 시)
```
// 1. Evolution context 요청
ges_execute({ action: "evolve", sessionId: "<id>" })
→ evolveContext 반환 (또는 terminateReason으로 종료)

// 2. Spec patch 제출
ges_execute({ action: "evolve_patch", sessionId: "<id>", specPatch: {...} })
→ impactedTaskIds + reExecuteContext 반환

// 3. Impacted tasks 재실행 (반복)
ges_execute({ action: "evolve_re_execute", sessionId: "<id>", reExecuteTaskResult: {...} })
→ allTasksCompleted === true가 될 때까지 반복

// 4. Re-evaluate
ges_execute({ action: "evaluate", sessionId: "<id>" })
```

**Spec Patch 범위**: L1(AC)+L2(constraints) 자유, L3(ontology) 추가/변경만, L4(goal) 금지
**종료 조건**: success(≥0.85, ≥0.80), stagnation, oscillation, hard_cap(3+3), caller, human_escalation
**Caller 종료**: `ges_execute({ action: "evolve", sessionId: "<id>", terminateReason: "caller" })`

**Flow C: Lateral Thinking** (evolution stagnation/oscillation/hard_cap 감지 시 자동 분기)

evolve 호출 시 non-success termination이 감지되면 즉시 종료하는 대신 lateral thinking persona로 자동 분기한다.

```
// 1. evolve 호출 → lateralContext 자동 반환 (stagnation 시)
ges_execute({ action: "evolve", sessionId: "<id>" })
→ { status: "lateral_thinking", lateralContext: { persona, pattern, systemPrompt, lateralPrompt, ... } }

// 2. Lateral result 제출 (caller가 persona 관점으로 specPatch 생성)
ges_execute({
  action: "evolve_lateral_result",
  sessionId: "<id>",
  lateralResult: {
    persona: "multistability",
    specPatch: { acceptanceCriteria: [...], constraints: [...] },
    description: "관점 전환으로 요구사항 재구성"
  }
})
→ impactedTaskIds + reExecuteContext 반환

// 3. Impacted tasks 재실행 (기존 action 재사용)
ges_execute({ action: "evolve_re_execute", sessionId: "<id>", reExecuteTaskResult: {...} })
→ 반복...

// 4. Re-evaluate
ges_execute({ action: "evaluate", sessionId: "<id>" })

// 5. 다음 persona 요청 (점수 미달 시)
ges_execute({ action: "evolve_lateral", sessionId: "<id>" })
→ 다음 lateralContext (or humanEscalation if 4개 persona 소진)
```

**Stagnation Pattern → Persona 매핑**:
| Pattern | Persona | 전략 |
|---|---|---|
| spinning (hard_cap) | Multistability | 다른 각도로 보기 |
| oscillation | Simplicity | 단순하게 줄이기 |
| no_drift (delta≈0) | Reification | 빠진 조각 채우기 |
| diminishing_returns (delta↓) | Invariance | 성공 패턴 복제하기 |

**Human Escalation**: 4개 persona 모두 소진 시 `humanEscalation` 반환 (triedPersonas, bestScore, suggestions 포함). session은 `status: 'failed'`, `terminationReason: 'human_escalation'`으로 종료.

### 핵심 규칙
- `action: "respond"` 시 `generatedQuestion` **필수**, `ambiguityScore` 선택
- ambiguityScore 차원: `goalClarity`, `constraintClarity`, `successCriteria`, `priorityClarity` (필수), `contextClarity` (선택)
- Spec의 `gestaltAnalysis[].principle`은 enum: `closure | proximity | similarity | figure_ground | continuity`
- `ontologySchema.entities[]`: `{ name, description, attributes[] }`
- `ontologySchema.relations[]`: `{ from, to, type }`

## Project Structure
- `src/core/` — types, errors, Result monad, config, constants
- `src/gestalt/` — 게슈탈트 원리 엔진 (핵심 차별점)
- `src/interview/` — InterviewEngine, AmbiguityScorer, SessionManager
- `src/spec/` — SpecGenerator, SpecExtractor
- `src/execute/` — ExecuteEngine, DAG Validator, ExecuteSessionManager
- `src/resilience/` — Stagnation Detector, Lateral Thinking Personas, Human Escalation
- `src/skills/` — SkillRegistry, parser
- `src/agent/` — AgentRegistry, FiguralRouter, multi-provider LLM
- `src/registry/` — BaseRegistry 추상 클래스
- `src/mcp/` — MCP 서버 + 툴 핸들러
- `src/events/` — EventStore (SQLite)
- `src/llm/` — Anthropic SDK adapter
- `src/cli/` — commander 기반 CLI

## Conventions
- MCP 서버에서 `console.log` 사용 금지 → stderr(`log()` 유틸)
- LLM 호출: temperature 0.3, JSON 응답 파싱 + fallback
- 모호성 점수 ≤ 0.2 = 요구사항 충분히 명확
- Spec 생성 실패 시 최대 3회 재시도
- 테스트: 각 test에서 고유 DB 경로 사용 (병렬 테스트 안전)
