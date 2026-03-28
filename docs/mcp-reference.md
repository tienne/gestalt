# Gestalt MCP Reference

Complete reference for all Gestalt MCP tools. For a beginner-friendly introduction, see [Getting Started](./getting-started.md).

---

## Overview

Gestalt exposes the following MCP tools:

| Tool | Purpose |
|------|---------|
| [`ges_interview`](#ges_interview) | Conduct a Gestalt-driven requirements interview |
| [`ges_generate_spec`](#ges_generate_spec) | Generate a structured Spec from a completed interview |
| [`ges_execute`](#ges_execute) | Plan and execute tasks from a Spec |
| [`ges_create_agent`](#ges_create_agent) | Generate a custom Role Agent from an interview |
| [`ges_agent`](#ges_agent) | List or inspect available agents |
| [`ges_status`](#ges_status) | Check session status |
| [`ges_benchmark`](#ges_benchmark) | Run pipeline benchmarks |

---

## Passthrough Mode

When `ANTHROPIC_API_KEY` is not set, Gestalt runs in **Passthrough Mode**: the server returns prompts and context objects, and the caller (Claude Code) performs all LLM reasoning.

All tools work in passthrough mode. The `gestaltContext` / `executeContext` / `specContext` fields contain the prompts you need to generate responses.

---

## `ges_interview`

Conducts a structured requirements interview using Gestalt principles.

### Actions

| Action | Description |
|--------|-------------|
| `start` | Begin a new interview session |
| `respond` | Submit user response and advance to next round |
| `score` | Compute or submit ambiguity scores |
| `complete` | Finalize the interview |

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"start" \| "respond" \| "score" \| "complete"` | ✅ | Action to perform |
| `topic` | `string` | For `start` | Interview topic / project description |
| `cwd` | `string` | Optional | Working directory for brownfield detection |
| `sessionId` | `string` | For `respond`, `score`, `complete` | Session ID from `start` response |
| `response` | `string` | For `respond` | User's answer to the current question |
| `generatedQuestion` | `string` | For `respond` (passthrough) | The question the caller generated |
| `ambiguityScore` | `object` | Optional | Ambiguity scores computed by caller |
| `record` | `boolean` | Optional | Generate a GIF recording on `complete` |

#### `ambiguityScore` object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `goalClarity` | `number` (0–1) | ✅ | How clearly the goal is defined |
| `constraintClarity` | `number` (0–1) | ✅ | How clearly constraints are defined |
| `successCriteria` | `number` (0–1) | ✅ | How measurable success conditions are |
| `priorityClarity` | `number` (0–1) | ✅ | How well priorities are ordered |
| `contextClarity` | `number` (0–1) | Optional | How well the context is understood |
| `contradictions` | `string[]` | Optional | List of detected contradictions |

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
  "ambiguityScore": {
    "overall": "0.45",
    "isReady": false,
    "dimensions": [
      { "name": "goalClarity", "clarity": "0.70", "principle": "closure" }
    ]
  },
  "message": "Use gestaltContext.questionPrompt to generate the next question."
}
```

**`complete`**
```json
{
  "status": "completed",
  "sessionId": "abc-123",
  "totalRounds": 8,
  "finalAmbiguityScore": "0.18",
  "recordingPath": ".gestalt/recordings/my-topic-20260328.gif"
}
```

### Example: Full Interview Flow

```javascript
// 1. Start
ges_interview({ action: "start", topic: "user authentication system" })

// 2. Respond to each question (repeat until isReady === true)
ges_interview({
  action: "respond",
  sessionId: "<sessionId>",
  response: "We need OAuth2 with Google and GitHub providers",
  generatedQuestion: "What authentication methods should be supported?",
  ambiguityScore: {
    goalClarity: 0.7,
    constraintClarity: 0.5,
    successCriteria: 0.4,
    priorityClarity: 0.6
  }
})

// 3. Complete (optionally with recording)
ges_interview({ action: "complete", sessionId: "<sessionId>", record: true })
```

---

## `ges_generate_spec`

Generates a structured Spec from a completed interview session, or directly from plain text without an interview.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | Optional | Completed interview session ID |
| `text` | `string` | Optional | Plain text description to generate spec without an interview |
| `force` | `boolean` | Optional | Force generation even if ambiguity threshold not met |
| `spec` | `object` | Optional (passthrough) | Externally generated spec to validate and store |

> Either `sessionId` or `text` must be provided. When using `text`, the `interviewSessionId` in the generated spec metadata is set to `"text-input"`, and the result is saved to `.gestalt/memory.json`.

### Responses

**Call 1 response (spec context):**
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

**Call 2 response (validated spec):**
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
      "ambiguityScore": 0.17,
      "generatedAt": "2026-03-28T00:00:00.000Z"
    }
  }
}
```

### Passthrough Flow (2-Call)

Two input paths are available. Both follow the same 2-call pattern.

**Option A — Text-based (no interview required)**

```javascript
// Call 1: Request spec context from plain text
ges_generate_spec({ text: "Build a user auth system with JWT" })
// Returns: specContext { systemPrompt, specPrompt }

// Call 2: Submit generated spec
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
// Returns validated spec; saves to .gestalt/memory.json
```

**Option B — Interview-based (existing flow)**

```javascript
// Call 1: Request spec context from a completed interview
ges_generate_spec({ sessionId: "<id>" })
// Returns: specContext { systemPrompt, specPrompt, allRounds }

// Call 2: Submit generated spec
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
|-------|------|----------|-------|
| `goal` | `string` | ✅ | Clear, unambiguous objective |
| `constraints` | `string[]` | ✅ | Technical and business constraints |
| `acceptanceCriteria` | `string[]` | ✅ | Measurable success conditions |
| `ontologySchema.entities` | `Entity[]` | ✅ | `{ name, description, attributes[] }` |
| `ontologySchema.relations` | `Relation[]` | ✅ | `{ from, to, type }` |
| `gestaltAnalysis` | `Analysis[]` | ✅ | `{ principle, finding, confidence }` — principle: `closure \| proximity \| similarity \| figure_ground \| continuity` |

---

## `ges_execute`

Plans and executes tasks derived from a Spec.

### Planning Actions

| Action | Description |
|--------|-------------|
| `start` | Begin execution planning session |
| `plan_step` | Submit a planning step result |
| `plan_complete` | Assemble and validate the final execution plan |

### Execution Actions

| Action | Description |
|--------|-------------|
| `execute_start` | Begin task execution |
| `execute_task` | Submit a task result |

### Evaluation Actions

| Action | Description |
|--------|-------------|
| `evaluate` | Start/submit evaluation (structural or contextual) |

### Evolution Actions

| Action | Description |
|--------|-------------|
| `evolve_fix` | Start/submit structural fix |
| `evolve` | Start contextual evolution |
| `evolve_patch` | Submit spec patch |
| `evolve_re_execute` | Submit re-execution task result |
| `evolve_lateral` | Request next lateral thinking persona |
| `evolve_lateral_result` | Submit lateral thinking result |

### Role Agent Actions

| Action | Description |
|--------|-------------|
| `role_match` | Match role agents to the current task |
| `role_consensus` | Synthesize multi-agent perspectives |

### Code Review Actions

| Action | Description |
|--------|-------------|
| `review_start` | Begin code review phase |
| `review_submit` | Submit an agent's review |
| `review_consensus` | Submit merged consensus review |
| `review_fix` | Start auto-fix loop |

### Common Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `string` | ✅ | See action tables above |
| `sessionId` | `string` | Most actions | Execute session ID |
| `spec` | `Spec object` | For `start` | Complete Spec from `ges_generate_spec` |
| `cwd` | `string` | Optional | Working directory; `execute_start` uses this to create `.claude/rules/gestalt-active.md` and `.gestalt/active-session.json`; `status` uses it to read `resumeHint` |

### `plan_complete` Response

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
  "executionPlan": { "...": "..." },
  "nextStep": "Call execute_start to begin task execution. Tasks will run in topological order — critical path has 7 tasks."
}
```

### Planning Step Result

```javascript
// plan_step for each of 4 principles: figure_ground → closure → proximity → continuity
ges_execute({
  action: "plan_step",
  sessionId: "<id>",
  stepResult: {
    principle: "figure_ground",
    classifiedACs: [
      { acIndex: 0, acText: "...", classification: "figure", priority: "critical", reasoning: "..." }
    ]
  }
})
```

### `execute_start` Response

When `cwd` is provided, `.claude/rules/gestalt-active.md` and `.gestalt/active-session.json` are created in the working directory. Both files are deleted when the session terminates.

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

### `execute_task` Response

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
  "message": "Task recorded. TIP: Context is getting long — consider calling compress to summarize completed work. Use taskContext.taskPrompt to implement the next task."
}
```

`compressionAvailable` is only included when `completedTasks > 5`. When all tasks are complete, the response includes `"allTasksCompleted": true`.

### Task Result

```javascript
ges_execute({
  action: "execute_task",
  sessionId: "<id>",
  taskResult: {
    taskId: "task-0",
    status: "completed",   // "completed" | "failed" | "skipped"
    output: "Description of what was done",
    artifacts: ["src/auth/oauth.ts", "tests/auth.test.ts"]
  }
})
```

### Evaluation Result

```javascript
// Structural check
ges_execute({
  action: "evaluate",
  sessionId: "<id>",
  structuralResult: {
    commands: [
      { name: "lint", command: "pnpm lint", exitCode: 0, output: "" },
      { name: "build", command: "pnpm build", exitCode: 0, output: "" },
      { name: "test", command: "pnpm test", exitCode: 0, output: "442 tests passed" }
    ],
    allPassed: true
  }
})

// Contextual evaluation
ges_execute({
  action: "evaluate",
  sessionId: "<id>",
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

---

## `ges_create_agent`

Generates a custom Role Agent AGENT.md file from a completed interview.

### Actions

| Action | Description |
|--------|-------------|
| `start` | Get agent creation context |
| `submit` | Validate and save the AGENT.md |

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"start" \| "submit"` | ✅ | Action to perform |
| `sessionId` | `string` | ✅ | Completed interview session ID |
| `agentContent` | `string` | For `submit` | Full AGENT.md content (frontmatter + body) |
| `cwd` | `string` | Optional | Working directory (default: `process.cwd()`) |

### AGENT.md Format

```markdown
---
name: security-expert
tier: standard
pipeline: execute
role: true
domain: ["oauth", "jwt", "security"]
description: "Security expert specializing in auth systems"
---

You are a security-focused agent. When reviewing code...
```

### Required Frontmatter Fields

| Field | Type | Notes |
|-------|------|-------|
| `name` | `string` | Unique agent identifier (kebab-case) |
| `tier` | `"frugal" \| "standard" \| "frontier"` | Model routing tier |
| `pipeline` | `"interview" \| "spec" \| "execute" \| "evaluate"` | Which pipeline stage this agent operates in |
| `role` | `true` | Must be `true` for Role Agents |
| `domain` | `string[]` | Expertise domains for role matching |
| `description` | `string` | Short description shown in listings |

---

## `ges_agent`

Lists or retrieves agent definitions.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"list" \| "get"` | ✅ | Action to perform |
| `name` | `string` | For `get` | Agent name to retrieve |

### Example

```javascript
// List all available agents
ges_agent({ action: "list" })

// Get a specific agent's system prompt
ges_agent({ action: "get", name: "architect" })
```

---

## `ges_status`

Checks session status for interview or execute sessions.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | Optional | Specific session ID to check; omit for all sessions |
| `sessionType` | `"interview" \| "execute" \| "all"` | Optional | Filter by session type (default: `"all"`) |
| `cwd` | `string` | Optional | Working directory; reads `.gestalt/active-session.json` to include `resumeHint` in the response |

### Response (list, with `cwd`)

```json
{
  "sessions": [...],
  "total": 2,
  "resumeHint": {
    "sessionId": "exec-456",
    "specId": "d9356d63-..."
  }
}
```

`resumeHint` is only included when `cwd` is provided and `.gestalt/active-session.json` exists.

---

## `ges_benchmark`

Runs Gestalt pipeline benchmarks in passthrough mode.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"start" \| "respond" \| "status"` | ✅ | Action to perform |
| `scenario` | `string` | For `start` | Benchmark scenario: `auth-system`, `dashboard`, `api-gateway` |
| `benchmarkSessionId` | `string` | For `respond`, `status` | Benchmark session ID |
| `response` | `string` | For `respond` | JSON response from the caller LLM |

---

## Full Pipeline Example

```javascript
// 1. Interview
const { sessionId } = await ges_interview({ action: "start", topic: "checkout with Stripe" });
// ... conduct interview rounds ...
await ges_interview({ action: "complete", sessionId });

// 2. Generate Spec
const specContext = await ges_generate_spec({ sessionId });
// ... caller generates spec JSON using specContext.specPrompt ...
const { spec } = await ges_generate_spec({ sessionId, spec: generatedSpec });

// 3. Execute
const { sessionId: execId } = await ges_execute({ action: "start", spec });
// ... 4 planning steps (figure_ground → closure → proximity → continuity) ...
await ges_execute({ action: "plan_complete", sessionId: execId });
await ges_execute({ action: "execute_start", sessionId: execId });
// ... execute each task ...

// 4. Evaluate
await ges_execute({ action: "evaluate", sessionId: execId, structuralResult: { ... } });
await ges_execute({ action: "evaluate", sessionId: execId, evaluationResult: { ... } });
```

---

## Error Responses

All tools return errors as JSON:

```json
{
  "error": "sessionId is required for respond action"
}
```

---

## Related Docs

- [Getting Started](./getting-started.md) — non-developer introduction
- [Interview Deep Dive](./01-interview.md)
- [Spec Generation](./02-spec.md)
- [Execute Engine](./03-execute.md)
- [Evaluate Phase](./04-evaluate.md)
- [Evolution Loop](./05-evolve.md)
- [Code Review](./06-code-review.md)
