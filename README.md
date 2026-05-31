<p align="center">
  <img src="assets/logo.svg" alt="Gestalt" width="600" />
</p>

<p align="center">
  <strong>Gestalt — AI Development Harness</strong><br/>
  Turn vague requirements into structured, executable plans — right inside Claude Code.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tienne/gestalt"><img src="https://img.shields.io/npm/v/@tienne/gestalt" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://github.com/tienne/gestalt/actions/workflows/ci.yml"><img src="https://github.com/tienne/gestalt/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<p align="center">
  <a href="./README.ko.md">한국어</a>
</p>

---

Gestalt is an MCP (Model Context Protocol) server that runs inside Claude Code. It conducts a structured requirement interview, generates a validated **Spec** — a JSON document capturing your goal, constraints, and acceptance criteria — and transforms that Spec into a dependency-aware execution plan.

Claude Code acts as the LLM throughout. Gestalt manages state, validates results, and advances the pipeline. No API key required.

> **Requires Node.js >= 20.0.0.** Use `nvm install 22 && nvm use 22` if needed.

---

## Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [The Pipeline](#the-pipeline)
  - [1. Interview](#1-interview)
  - [2. Spec Generation](#2-spec-generation)
  - [3. Execute](#3-execute)
  - [4. Evaluate](#4-evaluate)
  - [5. Evolve](#5-evolve)
  - [6. Code Review](#6-code-review)
- [Agents](#agents)
- [CLI Mode](#cli-mode)
- [Project Memory](#project-memory)
- [Configuration](#configuration)
- [Architecture](#architecture)

---

## Quick Start

Install the plugin once, then use it in any Claude Code session.

**From a terminal (outside a session):**

```bash
claude plugin install gestalt@gestalt
```

**Inside a Claude Code session:**

```bash
/plugin marketplace add tienne/gestalt
/plugin install gestalt@gestalt
```

Then run the pipeline:

```bash
/interview "user authentication system"
/spec
/execute
```

**[Full MCP Reference](./docs/mcp-reference.md)** — all tools, parameters, and examples

---

## How It Works

Vague requirements are the primary cause of implementation drift. When the goal isn't precise, Claude fills gaps with assumptions — and those assumptions diverge from intent as the project grows.

Gestalt addresses this before any code is written. It runs a structured interview guided by five **Gestalt psychology principles** to raise requirement resolution to a measurable threshold (≥ 0.8). The result is a **Spec**: a validated JSON document that drives every subsequent step.

### The Five Gestalt Principles

| Principle | Role |
|-----------|------|
| **Closure** | Finds what's missing; surfaces implicit requirements |
| **Proximity** | Groups related features and tasks by domain |
| **Similarity** | Identifies repeating patterns across requirements |
| **Figure-Ground** | Separates MVP (figure) from nice-to-have (ground) |
| **Continuity** | Validates dependency chains; detects contradictions |

### Passthrough Mode

Gestalt runs as an MCP server. Claude Code acts as the LLM: Gestalt returns prompts and context, and Claude Code does the reasoning. The server makes no API calls.

> **Note:** The Execute stage **always runs in Passthrough mode**, regardless of whether an API key is configured. Execute carries out real file edits and code execution through Claude Code's tools (Bash, Edit, etc.), so Claude Code must be the LLM that drives it — this is by design, not a missing feature.

```
You (in Claude Code)
       │
       ▼  /interview "topic"
  Gestalt MCP Server
  (returns context + prompts)
       │
       ▼
  Claude Code executes the prompts
  (generates questions, scores, plans)
       │
       ▼
  Gestalt MCP Server
  (validates, stores state, advances)
       │
       ▼  repeat until resolution ≥ 0.8
  Final Spec → Execution Plan
```

---

## Installation

### Option 1: Claude Code Plugin (Recommended)

Bundles the MCP server, slash-command skills, Gestalt agents, and project context — pre-configured in a single install.

**From a terminal:**

```bash
claude plugin install gestalt@gestalt
```

**Inside a Claude Code session:**

```bash
/plugin marketplace add tienne/gestalt
/plugin install gestalt@gestalt
```

What you get:

| Item | Details |
|------|---------|
| **MCP Tools** | `ges_interview`, `ges_generate_spec`, `ges_execute`, `ges_create_agent`, `ges_agent`, `ges_status`, `ges_code_graph`, `ges_graph_visualize`, `ges_benchmark`, `ges_generate_kb`, `ges_search`, `ges_sync` |
| **Slash Commands** | `/interview`, `/spec`, `/execute`, `/agent` |
| **Agents** | 5 pipeline agents + 9 Role agents + 3 Review agents |
| **CLAUDE.md** | Project context and MCP usage guide auto-injected |

---

### Option 2: Claude Code Desktop

Add this to your `settings.json` (or `claude_desktop_config.json`) and restart:

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

MCP tools are available immediately after restart. Slash commands require the plugin or manual skills setup.

---

### Option 3: Claude Code CLI

```bash
claude mcp add gestalt -- npx -y @tienne/gestalt
```

Or add directly to `~/.claude/settings.json`:

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

## The Pipeline

### 1. Interview

Start with any topic. A rough sentence is enough.

```bash
/interview "I want to build a checkout flow with Stripe"
```

Gestalt conducts a multi-round interview. Each round targets a specific resolution dimension:

- **Closure** — What's missing? What did you assume but not say?
- **Proximity** — Which features belong together?
- **Similarity** — Are there repeating patterns across requirements?
- **Figure-Ground** — What's the core MVP vs. what's optional?
- **Continuity** — Any contradictions or conflicts?

The interview continues until the resolution score reaches ≥ 0.8:

```
Round 1 → resolution: 0.28  (lots of unknowns)
Round 4 → resolution: 0.55  (getting clearer)
Round 8 → resolution: 0.81  ✓ ready for Spec
```

#### Context Compression

When rounds exceed 5, Gestalt signals that compression is available. Use the `compress` action to summarize earlier rounds and keep the context window lean:

```
1. respond returns needsCompression: true + compressionContext
2. ges_interview({ action: "compress", sessionId }) → compressionContext
3. Caller generates summary → submits it → stored in session
```

The compressed summary is automatically injected into all subsequent rounds.

---

### 2. Spec Generation

**From a completed interview:**

```bash
/spec
```

**From text (no interview required):**

```bash
ges_generate_spec({ text: "Build a checkout flow with Stripe" })
```

**With a built-in template:**

| Template ID | Description |
|-------------|-------------|
| `rest-api` | REST API with auth, CRUD, and OpenAPI |
| `react-dashboard` | React dashboard with charts, filters, and responsive layout |
| `cli-tool` | CLI with subcommands, config file, and distribution |

```bash
ges_generate_spec({ text: "API with JWT authentication", template: "rest-api" })
```

The generated Spec includes:

```
goal                → Clear, precise project objective
constraints         → Technical and business constraints
acceptanceCriteria  → Measurable, verifiable success conditions
ontologySchema      → Entity-relationship model
gestaltAnalysis     → Key findings per Gestalt principle
```

---

### 3. Execute

Transform the Spec into a dependency-aware execution plan and run it:

```bash
/execute
```

> Execute **always runs in Passthrough mode** — Claude Code performs the actual file edits and code execution through its tools (Bash, Edit, etc.). Configuring an API key does not switch Execute to a self-contained LLM mode; there is no such mode by design.

**Planning** applies four Gestalt principles in a fixed sequence:

| Step | Principle | What it does |
|:---:|-----------|-------------|
| 1 | **Figure-Ground** | Classifies acceptance criteria as critical vs. supplementary |
| 2 | **Closure** | Decomposes ACs into atomic tasks, including implicit ones |
| 3 | **Proximity** | Groups related tasks by domain |
| 4 | **Continuity** | Validates the dependency DAG — no cycles, topological order confirmed |

**Execution** runs tasks in topological order. After each task, drift detection checks alignment with the Spec:

- 3-dimensional score: Goal (50%) + Constraint (30%) + Ontology (20%)
- Jaccard similarity measurement
- Auto-triggers a retrospective when drift exceeds the threshold

#### Parallel Execution

The `plan_complete` response includes `parallelGroups: string[][]`. Tasks with no mutual dependencies are placed in the same group and can run concurrently:

```json
"parallelGroups": [
  ["setup-db", "setup-env"],
  ["create-schema"],
  ["seed-data", "run-tests"]
]
```

#### Resuming an Interrupted Session

```bash
ges_execute({ action: "resume", sessionId: "<id>" })
```

Returns `ResumeContext`: completed task IDs, next task, and `progressPercent`. The `ges_status` response also includes `resumeContext` automatically for any active session.

#### Brownfield Audit

When a codebase already exists, audit it against the Spec before running new tasks:

```bash
# Step 1: request audit context
ges_execute({ action: "audit", sessionId: "<id>" })
# → returns auditContext (systemPrompt, auditPrompt)

# Step 2: submit codebase snapshot + audit result
ges_execute({
  action: "audit",
  sessionId: "<id>",
  codebaseSnapshot: "...",
  auditResult: {
    implementedACs: [0, 2],
    partialACs: [1],
    missingACs: [3],
    gapAnalysis: "..."
  }
})
```

#### Sub-Agent Spawning

Decompose a complex task into sub-tasks dynamically during execution:

```bash
ges_execute({
  action: "spawn",
  sessionId: "<id>",
  parentTaskId: "task-3",
  subTasks: [
    { title: "Write DB schema", description: "..." },
    { title: "Run migration", description: "...", dependsOn: ["spawned-<id>"] }
  ]
})
```

#### Real-Time Progress Panel

The `/execute` slash command displays live execution status in the Claude Code Task panel — completed/total tasks, current task name, failed count, and parallel group progress. Updated automatically at each planning step, task completion, and evaluation stage.

---

### 4. Evaluate

Execution triggers a two-stage evaluation automatically:

| Stage | Method | On failure |
|:---:|-------|-----------|
| 1 | **Structural** — runs lint → build → test | Short-circuits; Stage 2 is skipped |
| 2 | **Contextual** — LLM validates each AC and goal alignment | Enters the Evolution Loop |

**Success condition:** `score ≥ 0.85` AND `goalAlignment ≥ 0.80`

---

### 5. Evolve

When evaluation fails, the Evolution Loop engages. Three recovery flows are available:

**Flow A — Structural Fix** (when lint/build/test fails)

```
evolve_fix → submit fix tasks → re-evaluate
```

**Flow B — Contextual Evolution** (when AC score is too low)

```
evolve → patch Spec (ACs/constraints) → re-execute impacted tasks → re-evaluate
```

Spec patch scope: ACs and constraints are freely editable; ontology can be extended; **goal is immutable**.

**Flow C — Lateral Thinking** (when stagnation is detected)

Gestalt rotates through lateral thinking personas rather than terminating:

| Stagnation Pattern | Persona | Strategy |
|--------------------|---------|---------|
| Hard cap hit | **Multistability** | View from a different angle |
| Oscillating scores | **Simplicity** | Strip down and converge |
| No progress (no drift) | **Reification** | Fill in what's missing |
| Diminishing returns | **Invariance** | Replicate what worked |

When all four personas are exhausted, the session ends with **Human Escalation** — a structured list of actionable suggestions for manual resolution.

**Termination conditions:**

| Condition | Trigger |
|-----------|---------|
| `success` | score ≥ 0.85 AND goalAlignment ≥ 0.80 |
| `stagnation` | 2 consecutive rounds with delta < 0.05 |
| `oscillation` | 2 consecutive score reversals |
| `hard_cap` | 3 structural + 3 contextual failures |
| `caller` | Manual termination |
| `human_escalation` | All 4 lateral personas exhausted |

---

### 6. Code Review

When evolution finishes, code review starts automatically:

```
review_start → agents submit perspectives → consensus → auto-fix
```

See [Agents](#agents) for the full list of built-in reviewers.

---

## Agents

Use any agent directly, outside the pipeline:

```bash
# List all available agents
/agent

# Run a specific agent on any task
/agent architect "review the module boundaries in this codebase"
/agent security-reviewer "check this authentication code for vulnerabilities"
/agent technical-writer "write a README for this module"
```

### Role Agents

Nine built-in role agents provide multi-perspective review:

| Agent | Domain |
|-------|--------|
| `architect` | System design, scalability |
| `frontend-developer` | UI, React, accessibility |
| `backend-developer` | API, database, server |
| `devops-engineer` | CI/CD, infrastructure, monitoring |
| `qa-engineer` | Testing, quality, automation |
| `designer` | UX/UI, design systems |
| `product-planner` | Roadmap, user stories, metrics |
| `researcher` | Analysis, data, benchmarks |
| `technical-writer` | Documentation, API docs, guides, README |

### Review Agents

Three built-in review agents run focused code analysis:

| Agent | Focus |
|-------|-------|
| `security-reviewer` | Injection, XSS, auth vulnerabilities, secrets |
| `performance-reviewer` | Memory leaks, N+1 queries, bundle size, async |
| `quality-reviewer` | Readability, SOLID, error handling, DRY |

### Custom Agents

Generate a custom Role Agent from interview results:

```bash
# Step 1: get agent creation context
ges_create_agent({ action: "start", sessionId: "<id>" })
# → returns agentContext (systemPrompt, creationPrompt, schema)

# Step 2: submit the generated AGENT.md content
ges_create_agent({ action: "submit", sessionId: "<id>", agentContent: "..." })
# → creates agents/{name}/AGENT.md
```

---

## CLI Mode

Run Gestalt without Claude Code. **Requires `ANTHROPIC_API_KEY`.**

```bash
# Start an interactive interview
npx @tienne/gestalt interview "my topic"

# Generate a Spec from a completed session
npx @tienne/gestalt spec <session-id>

# List all sessions
npx @tienne/gestalt status

# Generate gestalt.json config
npx @tienne/gestalt setup

# Start the MCP server manually
npx @tienne/gestalt serve
```

---

## Project Memory

Every spec and execution result is automatically recorded in `.gestalt/memory.json` at your repo root.

```json
{
  "specHistory": [
    { "specId": "...", "goal": "Build a user auth system", "sourceType": "text" }
  ],
  "executionHistory": [],
  "architectureDecisions": []
}
```

**Commit it.** `.gestalt/memory.json` is plain JSON. Teammates inherit all prior decisions on `git pull`.

**Context injection.** Prior goals and architecture decisions are automatically injected into the next spec prompt.

**User profile.** Personal preferences are stored in `~/.gestalt/profile.json` and are never committed.

---

## Configuration

Generate a `gestalt.json` with IDE autocomplete support:

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
    "resolutionThreshold": 0.8,
    "maxRounds": 10
  },
  "execute": {
    "driftThreshold": 0.3,
    "successThreshold": 0.85,
    "goalAlignmentThreshold": 0.80
  }
}
```

**Config priority** (highest → lowest): code overrides → shell env vars → `.env` → `gestalt.json` → built-in defaults

### Multi-Provider LLM Tiers

Route LLM calls by task complexity across three tiers:

| Tier | Purpose | Example models |
|------|---------|---------------|
| **frugal** | Lightweight tasks — scoring, classification, short responses | `llama3.2`, `claude-haiku` |
| **standard** | General tasks — interviews, spec generation, execution | `claude-sonnet-4-20250514` |
| **frontier** | High-complexity reasoning — architecture, code review, evolution | `claude-opus-4-20250514` |

Mix providers freely. This example uses Anthropic for standard/frontier and a local Ollama model for frugal tasks:

```json
{
  "$schema": "./node_modules/@tienne/gestalt/schemas/gestalt.schema.json",
  "llm": {
    "model": "claude-sonnet-4-20250514",
    "frugal": {
      "provider": "openai",
      "baseURL": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "model": "llama3.2"
    },
    "standard": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514"
    },
    "frontier": {
      "provider": "anthropic",
      "model": "claude-opus-4-20250514"
    }
  }
}
```

If no tiers are configured, all tiers fall back to the top-level `llm.model` with the Anthropic adapter — fully backward-compatible.

### Environment Variables

| Variable | Config path | Default | Description |
|----------|-------------|---------|-------------|
| `ANTHROPIC_API_KEY` | `llm.apiKey` | `""` | Required only for CLI direct mode |
| `GESTALT_MODEL` | `llm.model` | `claude-sonnet-4-20250514` | LLM model |
| `GESTALT_RESOLUTION_THRESHOLD` | `interview.resolutionThreshold` | `0.8` | Interview completion threshold |
| `GESTALT_MAX_ROUNDS` | `interview.maxRounds` | `10` | Max interview rounds |
| `GESTALT_DRIFT_THRESHOLD` | `execute.driftThreshold` | `0.3` | Task drift detection threshold |
| `GESTALT_EVOLVE_SUCCESS_THRESHOLD` | `execute.successThreshold` | `0.85` | Evolution success score |
| `GESTALT_EVOLVE_GOAL_ALIGNMENT_THRESHOLD` | `execute.goalAlignmentThreshold` | `0.80` | Goal alignment threshold |
| `GESTALT_DB_PATH` | `dbPath` | `~/.gestalt/events.db` | SQLite event store path |
| `GESTALT_SKILLS_DIR` | `skillsDir` | `skills` | Custom skills directory |
| `GESTALT_AGENTS_DIR` | `agentsDir` | `agents` | Custom agents directory |
| `GESTALT_LOG_LEVEL` | `logLevel` | `info` | Log level (`debug`/`info`/`warn`/`error`) |
| `GESTALT_LLM_FRUGAL_PROVIDER` | `llm.frugal.provider` | `anthropic` | Frugal tier provider |
| `GESTALT_LLM_FRUGAL_API_KEY` | `llm.frugal.apiKey` | `""` | Frugal tier API key |
| `GESTALT_LLM_FRUGAL_BASE_URL` | `llm.frugal.baseURL` | `""` | Frugal tier base URL (e.g. Ollama) |
| `GESTALT_LLM_FRUGAL_MODEL` | `llm.frugal.model` | — | Frugal tier model |
| `GESTALT_LLM_STANDARD_PROVIDER` | `llm.standard.provider` | `anthropic` | Standard tier provider |
| `GESTALT_LLM_STANDARD_API_KEY` | `llm.standard.apiKey` | `""` | Standard tier API key |
| `GESTALT_LLM_STANDARD_BASE_URL` | `llm.standard.baseURL` | `""` | Standard tier base URL |
| `GESTALT_LLM_STANDARD_MODEL` | `llm.standard.model` | — | Standard tier model |
| `GESTALT_LLM_FRONTIER_PROVIDER` | `llm.frontier.provider` | `anthropic` | Frontier tier provider |
| `GESTALT_LLM_FRONTIER_API_KEY` | `llm.frontier.apiKey` | `""` | Frontier tier API key |
| `GESTALT_LLM_FRONTIER_BASE_URL` | `llm.frontier.baseURL` | `""` | Frontier tier base URL |
| `GESTALT_LLM_FRONTIER_MODEL` | `llm.frontier.model` | — | Frontier tier model |

---

## Architecture

```
Claude Code (you)
     │
     ▼  MCP / stdio transport
┌──────────────────────────────────┐
│        Gestalt MCP Server        │
│                                  │
│  Interview Engine                │
│  ├─ GestaltPrincipleSelector     │
│  ├─ ResolutionScorer             │
│  ├─ SessionManager               │
│  └─ ContextCompressor            │
│                                  │
│  Spec Generator                  │
│  ├─ PassthroughSpecGenerator     │
│  └─ SpecTemplateRegistry         │
│                                  │
│  Execute Engine                  │
│  ├─ DAG Validator                │
│  ├─ ParallelGroupsCalculator     │
│  ├─ DriftDetector                │
│  ├─ EvaluationEngine             │
│  ├─ AuditEngine                  │
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

**Further reading:**

- [MCP Reference](./docs/mcp-reference.md) — all tools, parameters, and action schemas
- [Getting Started](./docs/getting-started.md) — 5-minute walkthrough
- [Configuration Reference](./docs/configuration.md) — full config options
- [Code Knowledge Graph](./docs/code-graph.md) — static analysis and blast-radius

---

## License

MIT © [tienne](https://github.com/tienne)
