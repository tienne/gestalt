<p align="center">
  <img src="assets/logo.svg" alt="Gestalt" width="600" />
</p>

<p align="center">
  <strong>Gestalt psychology-driven AI development harness</strong><br/>
  Transforms scattered requirements into structured, validated specifications through interactive interviews.
</p>

---

## Installation

### Claude Plugin (Recommended)

```bash
claude plugin install tienne/gestalt
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

1. **Interview** — Gestalt principles guide requirement clarification until ambiguity score drops below 0.2
2. **Spec** — Structured specification with goal, constraints, acceptance criteria, and ontology
3. **Execute** — 4-phase planning (Figure-Ground → Closure → Proximity → Continuity) produces a dependency-aware execution plan
4. **Evaluate** — 2-stage verification (structural + contextual) with evolution loop for iterative improvement
5. **Resilience** — Stagnation detection triggers Lateral Thinking Personas for alternative approaches; escalates to human when all personas exhausted

## Gestalt Principles

Each letter in the logo represents a core Gestalt principle used throughout the system:

| Principle | Role in Gestalt |
|-----------|----------------|
| **Closure** | Finds implicit requirements that aren't explicitly stated |
| **Proximity** | Groups related requirements and tasks by domain |
| **Continuation** | Validates dependency chains and execution order (DAG) |
| **Similarity** | Identifies repeating patterns across requirements |
| **Figure & Ground** | Separates core (figure) from supporting (ground) requirements |

## Lateral Thinking Personas

When the evolution loop stagnates, Gestalt classifies the pattern and activates a matching persona:

| Stagnation Pattern | Persona | Strategy |
|--------------------|---------|----------|
| Spinning (hard cap) | **Multistability** | See from a different angle |
| Oscillation | **Simplicity** | Simplify and converge |
| No drift | **Reification** | Fill in missing pieces |
| Diminishing returns | **Invariance** | Replicate success patterns |

All 4 personas are tried sequentially. If none succeed, the system triggers **Human Escalation** with actionable suggestions.

## MCP Tools

4 MCP tools exposed in passthrough mode (no API key required):

| Tool | Description |
|---|---|
| `ges_interview` | Gestalt-driven requirement interview (start, respond, score, complete) |
| `ges_generate_spec` | Generate a structured Spec from completed interview |
| `ges_execute` | Execute Spec via Gestalt pipeline (plan, execute, evaluate, evolve, lateral thinking) |
| `ges_status` | Check session status |

## CLI Commands

```bash
gestalt                    # Start MCP server (default)
gestalt serve              # Start MCP server (explicit)
gestalt interview "topic"  # Interactive interview
gestalt spec <session-id>  # Generate Spec from interview
gestalt status             # List all sessions
```

## Passthrough Mode

Gestalt runs in passthrough mode by default: it returns prompts and context to the calling LLM (e.g., Claude Code) instead of making its own API calls. No `ANTHROPIC_API_KEY` needed.

## License

MIT
