# Gestalt MCP Reference

Complete reference for all Gestalt MCP tools.

---

## Tool Overview

| Tool | Purpose |
|------|---------|
| [`ges_interview`](#ges_interview) | Gestalt 원리 기반 요구사항 인터뷰 수행 |
| [`ges_generate_spec`](#ges_generate_spec) | 완료된 인터뷰 또는 텍스트에서 구조화된 Spec 생성 |
| [`ges_execute`](#ges_execute) | Spec에서 실행 계획 수립 및 태스크 실행 |
| [`ges_create_agent`](#ges_create_agent) | 인터뷰 결과로 커스텀 Role Agent 생성 |
| [`ges_agent`](#ges_agent) | 에이전트 목록 조회 및 상세 조회 |
| [`ges_status`](#ges_status) | 세션 상태 확인 |
| [`ges_benchmark`](#ges_benchmark) | 파이프라인 벤치마크 실행 |

---

## Passthrough Mode

`ANTHROPIC_API_KEY`가 없으면 Gestalt는 **Passthrough Mode**로 동작한다. 서버는 프롬프트와 컨텍스트 객체를 반환하고, 호출자(Claude Code)가 LLM 추론을 직접 수행한다.

모든 툴은 Passthrough Mode에서 동작한다. `gestaltContext` / `executeContext` / `specContext` 필드에 응답 생성에 필요한 프롬프트가 담겨 있다.

---

## `ges_interview`

인터뷰 세션을 시작하고, 질문-응답을 반복하며 요구사항 해상도를 0.8 이상으로 높인다.

### Actions

| Action | Description |
|--------|-------------|
| `start` | 새 인터뷰 세션 시작 |
| `respond` | 사용자 응답 제출 및 다음 라운드 진행 |
| `score` | 해상도 점수 계산 또는 제출 |
| `complete` | 인터뷰 종료 |

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `action` | `"start" \| "respond" \| "score" \| "complete"` | Y | — | 수행할 액션 |
| `topic` | `string` | `start`만 | — | 인터뷰 주제 / 프로젝트 설명 |
| `cwd` | `string` | N | — | 브라운필드 감지용 작업 디렉터리 |
| `sessionId` | `string` | `respond`, `score`, `complete` | — | `start` 응답에서 받은 세션 ID |
| `response` | `string` | `respond` | — | 현재 질문에 대한 사용자 응답 |
| `generatedQuestion` | `string` | `respond` (passthrough) | — | 호출자가 생성한 질문 텍스트 |
| `resolutionScore` | `object` | N | — | 호출자가 계산한 해상도 점수 (아래 참고) |
| `record` | `boolean` | N | `false` | `complete` 시 GIF 녹화 생성 여부 |

#### `resolutionScore` object

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `goalClarity` | `number` (0–1) | Y | 목표 명확도 |
| `constraintClarity` | `number` (0–1) | Y | 제약 조건 명확도 |
| `successCriteria` | `number` (0–1) | Y | 성공 기준 측정 가능성 |
| `priorityClarity` | `number` (0–1) | Y | 우선순위 명확도 |
| `contextClarity` | `number` (0–1) | N | 컨텍스트 이해도 |
| `contradictions` | `string[]` | N | 감지된 모순 목록 |

### Responses

**`start`**

```json
{
  "status": "started",
  "sessionId": "abc-123",
  "projectType": "greenfield",
  "detectedFiles": [],
  "gestaltContext": {
    "systemPrompt": "...",
    "questionPrompt": "...",
    "currentPrinciple": "closure",
    "principleStrategy": "...",
    "phase": "phase-1",
    "roundNumber": 1
  },
  "roundNumber": 1,
  "message": "..."
}
```

**`respond`**

```json
{
  "status": "in_progress",
  "sessionId": "abc-123",
  "roundNumber": 3,
  "gestaltContext": { "...": "next question context" },
  "resolutionScore": {
    "overall": "0.55",
    "isReady": false,
    "dimensions": [
      { "name": "goalClarity", "clarity": "0.70", "principle": "closure" }
    ]
  },
  "message": "Use gestaltContext.questionPrompt to generate the next question."
}
```

`isReady === true`가 되면 `complete`를 호출한다.

**`complete`**

```json
{
  "status": "completed",
  "sessionId": "abc-123",
  "totalRounds": 8,
  "finalResolutionScore": "0.82",
  "recordingPath": ".gestalt/recordings/my-topic-20260328.gif"
}
```

### Example: Full Interview Flow

```javascript
// 1. 세션 시작
ges_interview({ action: "start", topic: "user authentication system" })

// 2. 응답 제출 (isReady === true 될 때까지 반복)
ges_interview({
  action: "respond",
  sessionId: "<sessionId>",
  response: "OAuth2 with Google and GitHub providers",
  generatedQuestion: "What authentication methods should be supported?",
  resolutionScore: {
    goalClarity: 0.7,
    constraintClarity: 0.5,
    successCriteria: 0.4,
    priorityClarity: 0.6
  }
})

// 3. 종료
ges_interview({ action: "complete", sessionId: "<sessionId>", record: true })
```

---

## `ges_generate_spec`

완료된 인터뷰 세션 또는 평문 텍스트에서 구조화된 Spec을 생성한다. 2-call 패턴을 사용한다: 첫 번째 호출에서 컨텍스트를 받고, 호출자가 Spec JSON을 생성한 뒤, 두 번째 호출로 제출한다.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `sessionId` | `string` | `sessionId` 또는 `text` 중 하나 | — | 완료된 인터뷰 세션 ID |
| `text` | `string` | `sessionId` 또는 `text` 중 하나 | — | 인터뷰 없이 Spec을 생성할 평문 설명 |
| `force` | `boolean` | N | `false` | 해상도 임계값 미달 시에도 강제 생성 |
| `spec` | `object` | N (2번째 호출 시) | — | 호출자가 생성한 Spec 객체 (검증 후 저장) |

`text` 사용 시 생성된 Spec의 `interviewSessionId`는 `"text-input"`으로 설정되고 `.gestalt/memory.json`에 저장된다.

### Responses

**Call 1 — spec context 반환**

```json
{
  "status": "context_ready",
  "sessionId": "abc-123",
  "specContext": {
    "systemPrompt": "You are a Spec generator...",
    "specPrompt": "Based on the following interview rounds, generate a structured Spec...",
    "allRounds": [
      { "roundNumber": 1, "question": "...", "userResponse": "...", "gestaltFocus": "closure" }
    ]
  },
  "message": "Use specContext.specPrompt to generate the spec JSON, then call ges_generate_spec again with the spec field."
}
```

**Call 2 — 검증된 Spec 반환**

```json
{
  "status": "completed",
  "sessionId": "abc-123",
  "spec": {
    "version": "1.0",
    "goal": "Build a secure login system with OAuth2",
    "constraints": ["Must support Google and GitHub providers"],
    "acceptanceCriteria": ["User can log in with Google in < 3 seconds"],
    "ontologySchema": { "entities": [], "relations": [] },
    "gestaltAnalysis": [],
    "metadata": {
      "specId": "d9356d63-...",
      "interviewSessionId": "abc-123",
      "resolutionScore": 0.83,
      "generatedAt": "2026-03-28T00:00:00.000Z"
    }
  }
}
```

### Example: Text-based (인터뷰 없이)

```javascript
// Call 1
ges_generate_spec({ text: "Build a user auth system with JWT" })
// → specContext { systemPrompt, specPrompt }

// Call 2
ges_generate_spec({
  text: "Build a user auth system with JWT",
  spec: {
    goal: "...",
    constraints: [...],
    acceptanceCriteria: [...],
    ontologySchema: { entities: [...], relations: [...] },
    gestaltAnalysis: [...]
  }
})
// → validated spec; .gestalt/memory.json에 저장
```

### Example: Interview-based

```javascript
// Call 1
ges_generate_spec({ sessionId: "<id>" })
// → specContext { systemPrompt, specPrompt, allRounds }

// Call 2
ges_generate_spec({
  sessionId: "<id>",
  spec: {
    goal: "Build a secure login system with OAuth2",
    constraints: ["Must support Google and GitHub providers", "No email/password auth"],
    acceptanceCriteria: [
      "User can log in with Google in < 3 seconds",
      "JWT tokens expire after 24 hours"
    ],
    ontologySchema: {
      entities: [
        { name: "User", description: "Authenticated user", attributes: ["id", "email", "provider"] },
        { name: "Session", description: "Auth session", attributes: ["token", "expiresAt"] }
      ],
      relations: [
        { from: "User", to: "Session", type: "has_many" }
      ]
    },
    gestaltAnalysis: [
      { principle: "closure", finding: "Token refresh flow not explicitly stated", confidence: 0.8 },
      { principle: "figure_ground", finding: "OAuth2 is figure; email auth is ground", confidence: 0.9 }
    ]
  }
})
```

### Spec Object Schema

| Field | Type | Required | Notes |
|-------|------|:--------:|-------|
| `goal` | `string` | Y | 명확하고 구체적인 목표 |
| `constraints` | `string[]` | Y | 기술 및 비즈니스 제약 조건 |
| `acceptanceCriteria` | `string[]` | Y | 측정 가능한 완료 조건 |
| `ontologySchema.entities` | `Entity[]` | Y | `{ name, description, attributes[] }` |
| `ontologySchema.relations` | `Relation[]` | Y | `{ from, to, type }` |
| `gestaltAnalysis` | `Analysis[]` | Y | `{ principle, finding, confidence }` — principle: `closure \| proximity \| similarity \| figure_ground \| continuity` |

---

## `ges_execute`

Spec에서 실행 계획을 수립하고 태스크를 실행한다. Planning → Execution → Evaluation → Evolution → Code Review 순서로 진행된다.

### Actions

#### Planning

| Action | Description |
|--------|-------------|
| `start` | 실행 계획 세션 시작 |
| `plan_step` | 계획 단계 결과 제출 (`figure_ground` → `closure` → `proximity` → `continuity` 순서) |
| `plan_complete` | 최종 실행 계획 조립 및 검증 |

#### Execution

| Action | Description |
|--------|-------------|
| `execute_start` | 태스크 실행 시작 |
| `execute_task` | 태스크 결과 제출 |

#### Evaluation

| Action | Description |
|--------|-------------|
| `evaluate` | 구조적 검증 또는 컨텍스트 평가 시작/제출 |

#### Evolution

| Action | Description |
|--------|-------------|
| `evolve_fix` | 구조적 오류 수정 시작/제출 |
| `evolve` | 컨텍스트 진화 시작 |
| `evolve_patch` | Spec 패치 제출 |
| `evolve_re_execute` | 재실행 태스크 결과 제출 |
| `evolve_lateral` | 다음 Lateral Thinking Persona 요청 |
| `evolve_lateral_result` | Lateral Thinking 결과 제출 |

#### Role Agent

| Action | Description |
|--------|-------------|
| `role_match` | 현재 태스크에 Role Agent 매칭 |
| `role_consensus` | 멀티 에이전트 관점 통합 |

#### Code Review

| Action | Description |
|--------|-------------|
| `review_start` | 코드 리뷰 단계 시작 |
| `review_submit` | 에이전트 리뷰 제출 |
| `review_consensus` | 통합 컨센서스 리뷰 제출 |
| `review_fix` | 자동 수정 루프 시작 |

### Common Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `action` | `string` | Y | — | 수행할 액션 (위 테이블 참고) |
| `sessionId` | `string` | 대부분의 액션 | — | 실행 세션 ID |
| `spec` | `Spec` | `start` | — | `ges_generate_spec`에서 받은 완성된 Spec 객체 |
| `cwd` | `string` | N | — | 작업 디렉터리. `execute_start`에서 `.claude/rules/gestalt-active.md`와 `.gestalt/active-session.json` 생성에 사용. `status`에서 `resumeHint` 읽기에 사용. |
| `codeGraphRepoRoot` | `string` | N | — | `start`에서 설정 시 태스크 실행마다 관련 파일을 자동 추출해 `suggestedFiles`로 반환 |

### `start` — Example Request & Response

```javascript
ges_execute({ action: "start", spec: { goal: "...", /* ... */ } })
```

```json
{
  "status": "planning",
  "sessionId": "exec-456",
  "executeContext": {
    "systemPrompt": "You are a Gestalt execution planner...",
    "planningPrompt": "Apply the Figure-Ground principle to classify acceptance criteria...",
    "currentPrinciple": "figure_ground",
    "spec": { "..." : "..." }
  },
  "message": "Planning started. Apply figure_ground principle first."
}
```

### `plan_step` — Example Request

```javascript
ges_execute({
  action: "plan_step",
  sessionId: "exec-456",
  stepResult: {
    principle: "figure_ground",
    classifiedACs: [
      {
        acIndex: 0,
        acText: "User can log in with Google in < 3 seconds",
        classification: "figure",
        priority: "critical",
        reasoning: "Core user-facing requirement"
      }
    ]
  }
})
```

4개 원리(`figure_ground` → `closure` → `proximity` → `continuity`) 각각에 대해 반복 호출한다.

### `plan_complete` — Response

```json
{
  "status": "plan_complete",
  "sessionId": "exec-456",
  "planSummary": {
    "totalTasks": 12,
    "groupCount": 4,
    "criticalPathLength": 7,
    "parallelGroupCount": 3
  },
  "executionPlan": { "..." : "..." },
  "nextStep": "Call execute_start to begin task execution. Tasks will run in topological order — critical path has 7 tasks."
}
```

### `execute_start` — Response

`cwd` 지정 시 `.claude/rules/gestalt-active.md`와 `.gestalt/active-session.json`이 해당 디렉터리에 생성된다. 세션 종료 시 두 파일 모두 삭제된다.

```json
{
  "status": "executing",
  "sessionId": "exec-456",
  "taskContext": {
    "systemPrompt": "You are a Gestalt-trained task executor...",
    "taskPrompt": "## Task Execution\n\n**Current Task**:\n- ID: task-0\n- Title: ...",
    "phase": "executing",
    "currentTask": {
      "taskId": "task-0",
      "title": "Create OAuth routes",
      "description": "...",
      "sourceAC": [0],
      "estimatedComplexity": "medium",
      "dependsOn": []
    },
    "pendingTasks": [{ "taskId": "task-1", "dependsOn": ["task-0"] }],
    "completedTaskIds": []
  },
  "message": "Execution started. Use taskContext.taskPrompt with taskContext.systemPrompt to implement the task."
}
```

### `execute_task` — Example Request & Response

```javascript
ges_execute({
  action: "execute_task",
  sessionId: "exec-456",
  taskResult: {
    taskId: "task-0",
    status: "completed",   // "completed" | "failed" | "skipped"
    output: "Description of what was done",
    artifacts: ["src/auth/oauth.ts", "tests/auth.test.ts"]
  }
})
```

```json
{
  "status": "executing",
  "sessionId": "exec-456",
  "completedTasks": 6,
  "compressionAvailable": true,
  "taskContext": {
    "currentTask": { "taskId": "task-6", "..." : "..." },
    "completedTaskIds": ["task-0", "task-1", "task-2", "task-3", "task-4", "task-5"]
  },
  "driftScore": {
    "taskId": "task-5",
    "overall": 0.12,
    "dimensions": [
      { "name": "goal", "score": 0.05, "detail": "Goal-output Jaccard: 0.95" }
    ],
    "thresholdExceeded": false
  },
  "suggestedFiles": ["src/auth/oauth.ts", "src/middleware/auth.ts"],
  "message": "Task recorded. Use taskContext.taskPrompt to implement the next task."
}
```

- `compressionAvailable`: `completedTasks > 5`일 때만 포함
- `allTasksCompleted: true`: 모든 태스크 완료 시 포함
- `suggestedFiles`: `codeGraphRepoRoot` 설정 시 포함 (최대 10개)

### `evaluate` — Example Requests

```javascript
// 구조적 검증 (lint / build / test)
ges_execute({
  action: "evaluate",
  sessionId: "exec-456",
  structuralResult: {
    commands: [
      { name: "lint", command: "pnpm lint", exitCode: 0, output: "" },
      { name: "build", command: "pnpm build", exitCode: 0, output: "" },
      { name: "test", command: "pnpm test", exitCode: 0, output: "442 tests passed" }
    ],
    allPassed: true
  }
})

// 컨텍스트 평가 (AC 충족 여부)
ges_execute({
  action: "evaluate",
  sessionId: "exec-456",
  evaluationResult: {
    verifications: [
      { acIndex: 0, satisfied: true, evidence: "OAuth2 login implemented", gaps: [] }
    ],
    overallScore: 0.92,
    goalAlignment: 0.88,
    recommendations: []
  }
})
```

### Progress Panel

`/execute` 슬래시 커맨드 사용 시(MCP 툴 직접 호출이 아닌 경우) Claude Code Task 패널에 실시간 진행 상황이 표시된다. Planning 단계, 태스크 완료, 평가 단계, Evolution 라운드가 모두 반영된다. 패널 업데이트 실패는 실행을 중단하지 않는다.

---

## `ges_create_agent`

완료된 인터뷰에서 커스텀 Role Agent의 AGENT.md 파일을 생성한다.

### Actions

| Action | Description |
|--------|-------------|
| `start` | 에이전트 생성 컨텍스트 조회 |
| `submit` | AGENT.md 검증 및 저장 |

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `action` | `"start" \| "submit"` | Y | — | 수행할 액션 |
| `sessionId` | `string` | Y | — | 완료된 인터뷰 세션 ID |
| `agentContent` | `string` | `submit` | — | 프론트매터 + 본문이 포함된 전체 AGENT.md 내용 |
| `cwd` | `string` | N | `process.cwd()` | 에이전트 파일을 저장할 작업 디렉터리 |

### `start` — Example Response

```json
{
  "status": "context_ready",
  "sessionId": "abc-123",
  "agentContext": {
    "systemPrompt": "You are an agent designer...",
    "agentPrompt": "Based on the following interview, generate an AGENT.md...",
    "interviewSummary": { "..." : "..." }
  },
  "message": "Use agentContext.agentPrompt to generate AGENT.md content, then call ges_create_agent with action: submit."
}
```

### `submit` — Example Request & Response

```javascript
ges_create_agent({
  action: "submit",
  sessionId: "abc-123",
  agentContent: `---
name: security-expert
tier: standard
pipeline: execute
role: true
domain: ["oauth", "jwt", "security"]
description: "Security expert specializing in auth systems"
---

You are a security-focused agent. When reviewing code...`
})
```

```json
{
  "status": "completed",
  "agentPath": "agents/security-expert.md",
  "name": "security-expert"
}
```

### AGENT.md Frontmatter Fields

| Field | Type | Required | Notes |
|-------|------|:--------:|-------|
| `name` | `string` | Y | 고유 에이전트 식별자 (kebab-case) |
| `tier` | `"frugal" \| "standard" \| "frontier"` | Y | 모델 라우팅 티어 |
| `pipeline` | `"interview" \| "spec" \| "execute" \| "evaluate"` | Y | 에이전트가 동작하는 파이프라인 단계 |
| `role` | `true` | Y | Role Agent임을 명시 |
| `domain` | `string[]` | Y | 역할 매칭용 전문 도메인 |
| `description` | `string` | Y | 목록에서 표시되는 짧은 설명 |

---

## `ges_agent`

사용 가능한 에이전트 목록을 조회하거나 특정 에이전트의 시스템 프롬프트를 가져온다.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `action` | `"list" \| "get"` | Y | — | 수행할 액션 |
| `name` | `string` | `get` | — | 조회할 에이전트 이름 |

### Examples

```javascript
// 전체 에이전트 목록
ges_agent({ action: "list" })

// 특정 에이전트 시스템 프롬프트 조회
ges_agent({ action: "get", name: "architect" })
```

### `list` — Example Response

```json
{
  "agents": [
    { "name": "architect", "tier": "frontier", "pipeline": "execute", "description": "..." },
    { "name": "security-expert", "tier": "standard", "pipeline": "execute", "description": "..." }
  ],
  "total": 2
}
```

---

## `ges_status`

인터뷰 또는 실행 세션의 상태를 확인한다.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `sessionId` | `string` | N | — | 조회할 특정 세션 ID. 생략하면 전체 세션 목록 반환 |
| `sessionType` | `"interview" \| "execute" \| "all"` | N | `"all"` | 세션 유형 필터 |
| `cwd` | `string` | N | — | 작업 디렉터리. `.gestalt/active-session.json`을 읽어 `resumeHint` 포함 |

### Response (목록 조회, `cwd` 포함)

```json
{
  "sessions": [
    { "sessionId": "exec-456", "type": "execute", "status": "executing", "createdAt": "..." }
  ],
  "total": 1,
  "resumeHint": {
    "sessionId": "exec-456",
    "specId": "d9356d63-..."
  }
}
```

`resumeHint`는 `cwd`가 제공되고 `.gestalt/active-session.json`이 존재할 때만 포함된다.

---

## `ges_benchmark`

Passthrough Mode에서 Gestalt 파이프라인 벤치마크를 실행한다. 미리 정의된 시나리오로 인터뷰 → Spec → Execute 전체 흐름의 응답 품질을 측정한다.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `action` | `"start" \| "respond" \| "status"` | Y | — | 수행할 액션 |
| `scenario` | `string` | `start` | — | 벤치마크 시나리오: `auth-system`, `dashboard`, `api-gateway` |
| `benchmarkSessionId` | `string` | `respond`, `status` | — | 벤치마크 세션 ID |
| `response` | `string` | `respond` | — | 호출자 LLM이 생성한 JSON 응답 |

### `start` — Example Request & Response

```javascript
ges_benchmark({ action: "start", scenario: "auth-system" })
```

```json
{
  "benchmarkSessionId": "bench-789",
  "scenario": "auth-system",
  "step": "interview",
  "prompt": "You are conducting a requirements interview for: auth-system...",
  "message": "Respond with your LLM output as a JSON string to bench-789."
}
```

### `status` — Example Response

```json
{
  "benchmarkSessionId": "bench-789",
  "scenario": "auth-system",
  "status": "running",
  "completedSteps": 3,
  "totalSteps": 8,
  "scores": {
    "resolutionScore": 0.84,
    "specQuality": 0.79
  }
}
```

---

## Full Pipeline Example

```javascript
// 1. Interview
const { sessionId } = await ges_interview({ action: "start", topic: "checkout with Stripe" });
// ... conduct interview rounds until isReady === true ...
await ges_interview({ action: "complete", sessionId });

// 2. Generate Spec
const { specContext } = await ges_generate_spec({ sessionId });
// ... caller generates spec JSON using specContext.specPrompt ...
const { spec } = await ges_generate_spec({ sessionId, spec: generatedSpec });

// 3. Execute — Planning
const { sessionId: execId } = await ges_execute({ action: "start", spec });
// ... 4 plan_step calls: figure_ground → closure → proximity → continuity ...
await ges_execute({ action: "plan_complete", sessionId: execId });

// 4. Execute — Tasks
await ges_execute({ action: "execute_start", sessionId: execId });
// ... execute each task with execute_task ...

// 5. Evaluate
await ges_execute({ action: "evaluate", sessionId: execId, structuralResult: { /* ... */ } });
await ges_execute({ action: "evaluate", sessionId: execId, evaluationResult: { /* ... */ } });
```

---

## Error Responses

모든 툴은 에러를 JSON으로 반환한다.

```json
{
  "error": "sessionId is required for respond action"
}
```

---

## Related Docs

- [Interview Deep Dive](./01-interview.md)
- [Spec Generation](./02-spec.md)
- [Execute Engine](./03-execute.md)
- [Evaluate Phase](./04-evaluate.md)
- [Evolution Loop](./05-evolve.md)
- [Code Review](./06-code-review.md)
- [Code Knowledge Graph](./code-graph.md)
- [Configuration](./configuration.md)
