---
name: agent
version: "1.0.0"
description: "Invoke a Gestalt agent directly for any task — no pipeline required"
triggers:
  - "agent"
  - "use agent"
  - "invoke agent"
  - "run agent"
inputs:
  name:
    type: string
    required: false
    description: "Agent name (e.g. architect, security-reviewer). Omit to list all available agents."
  task:
    type: string
    required: false
    description: "Task or question for the agent to perform"
outputs:
  - response
---

# Agent Skill

Invoke any Gestalt Role or Review agent directly, outside the Gestalt pipeline.

## Usage

```bash
# List all available agents
/agent

# Run a Role Agent
/agent architect "review the module boundaries in this codebase"
/agent backend-developer "is this REST API design consistent?"
/agent qa-engineer "what edge cases am I missing for this login flow?"
/agent frontend-developer "review this React component for accessibility issues"
/agent presentation-designer "분기 실적 발표용 Reveal.js 슬라이드 구조 설계해줘"

# Run a Review Agent
/agent security-reviewer "check this authentication code for vulnerabilities"
/agent performance-reviewer "are there any N+1 queries or memory leaks here?"
/agent quality-reviewer "review this for readability and maintainability"
```

## Agent Groups

**Role Agents** — domain specialists for consultation and advice:

| Agent | Domain |
|-------|--------|
| `architect` | System design, scalability, design patterns |
| `harness-architect` | Claude Code harness design, agent pipeline, skill/command structure |
| `backend-developer` | API, database, authentication, server |
| `frontend-developer` | UI, React, accessibility |
| `designer` | UX/UI, design systems, interaction |
| `presentation-designer` | Reveal.js slides, storytelling, visual design for decks |
| `qa-engineer` | Testing, edge cases, quality |
| `devops-engineer` | CI/CD, infrastructure, monitoring |
| `product-planner` | Requirements, roadmap, user stories |
| `researcher` | Analysis, benchmarks, best practices |
| `technical-writer` | Documentation, API docs, README, developer guides |
| `humanize-monolith` | AI-tell 패턴 탐지·윤문, 번역투 교정, 텍스트 자연스럽게 |

**Review Agents** — code review specialists:

| Agent | Focus |
|-------|-------|
| `security-reviewer` | Injection, XSS, auth vulnerabilities, secrets |
| `performance-reviewer` | Memory leaks, N+1 queries, bundle size, async |
| `quality-reviewer` | Readability, SOLID, error handling, DRY |

## Proactive Invocation

이 스킬은 사용자가 `/agent`를 명시하지 않아도 아래 상황에서 자동으로 실행된다. CLAUDE.md의 Role Agent 자동 라우팅 규칙에 따라 적절한 에이전트를 선택해 실행한다.

- 영상·비디오 URL 포함 또는 "요약해줘" → `video-summarizer`
- 번역투·AI 말투 교정 → `humanize-monolith`
- 문서·README·가이드 작성 → `technical-writer`
- 슬라이드·발표자료 → `presentation-designer`
- 보안 검토 → `security-reviewer`
- 성능 분석 → `performance-reviewer`
- 코드 리뷰 → `quality-reviewer`

에이전트 이름 없이 태스크 설명만 있는 경우: `ges_agent({ action: "list" })`로 전체 목록을 조회한 뒤 설명과 domain을 기반으로 가장 적합한 에이전트를 자동 선택한다.

## Instructions

### Listing agents

When called without a `name` argument:

1. Call `ges_agent({ action: "list" })` to retrieve all available agents
2. Display the results grouped as **Role Agents** and **Review Agents**
3. For each agent, show name, description, and key domains
4. Suggest example invocations based on common use cases

### Running an agent

When called with a `name` and `task`:

1. Call `ges_agent({ action: "get", name: "<agent-name>" })` to retrieve the agent definition
2. If the agent is not found, list available agents and ask the user to choose one
3. Adopt the agent's `systemPrompt` as your active persona for this response
4. Perform the task from that agent's specialist perspective
5. Follow the output format defined in the agent's system prompt (severity levels, structured findings, etc.)

### Agent name only, no task

When a `name` is provided but no `task`:

1. Call `ges_agent({ action: "get", name: "<agent-name>" })` to retrieve the agent
2. Display the agent's description, domains, and what it can help with
3. Prompt the user to provide a specific task or question

### Partial name matching

If the provided name doesn't exactly match (e.g. "security" instead of "security-reviewer"):

1. Call `ges_agent({ action: "list" })` to get all agent names
2. Find the closest match and confirm with the user before proceeding
