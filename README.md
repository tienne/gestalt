# @tienne/gestalt

Gestalt psychology-driven AI development harness. Transforms scattered requirements into structured, validated specifications through interactive interviews.

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

## MCP Tools

Gestalt exposes 4 MCP tools in passthrough mode (no API key required):

| Tool | Description |
|---|---|
| `ges_interview` | Gestalt-driven requirement interview (start, respond, score, complete) |
| `ges_generate_spec` | Generate a structured Spec from completed interview |
| `ges_execute` | Execute Spec via Gestalt planning pipeline (plan, execute, evaluate, evolve) |
| `ges_status` | Check session status |

## CLI Commands

```bash
gestalt                    # Start MCP server (default)
gestalt serve              # Start MCP server (explicit)
gestalt interview "topic"  # Interactive interview
gestalt spec <session-id>  # Generate Spec from interview
gestalt status             # List all sessions
```

## How It Works

1. **Interview** - Gestalt principles guide requirement clarification until ambiguity score drops below 0.2
2. **Spec** - Structured specification generated with goal, constraints, acceptance criteria, and ontology
3. **Execute** - 4-phase planning (Figure-Ground, Closure, Proximity, Continuity) produces a dependency-aware execution plan
4. **Evaluate** - 2-stage verification (structural + contextual) with evolution loop for iterative improvement

## Passthrough Mode

Gestalt runs in passthrough mode by default: it returns prompts and context to the calling LLM (e.g., Claude Code) instead of making its own API calls. No `ANTHROPIC_API_KEY` needed.

## License

MIT
