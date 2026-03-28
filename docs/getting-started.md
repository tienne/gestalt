# Getting Started with Gestalt

> **Goal:** Run your first interview in 5 minutes.

---

## What is Gestalt?

Gestalt is a tool that helps you turn vague ideas into structured plans. You describe what you want to build, and Gestalt asks targeted questions until your requirements are clear enough to act on.

It runs as an MCP server inside Claude Code. Claude Code handles all AI reasoning — Gestalt manages state, validates results, and advances the pipeline.

---

## Step 1: Install the Plugin

Run these commands in Claude Code (one-time setup):

```bash
/plugin marketplace add tienne/gestalt
/plugin install gestalt@gestalt
```

Once installed, the `/interview`, `/spec`, and `/execute` slash commands are available in any Claude Code session.

> **Requires Node.js >= 20.0.0** — use `nvm install 22 && nvm use 22` if needed.

---

## Step 2: Run Your First Interview

Start with any topic. A single rough sentence is enough.

```
/interview "I want to build [your idea here]"
```

**Example:**

```
/interview "I want to create a mobile app that helps people track their daily water intake"
```

> **Skip the interview:** If you already have a clear idea, generate a spec directly:
> ```
> ges_generate_spec({ text: "I want to build [your idea here]" })
> ```
> The result is saved to `.gestalt/memory.json` and future specs automatically inherit the context.

---

## Step 3: Follow the Interview

Gestalt asks questions based on **5 Gestalt principles**:

| Principle | What it does |
|-----------|-------------|
| **Closure** | Finds what's missing from your idea |
| **Proximity** | Groups related features together |
| **Similarity** | Identifies repeating patterns |
| **Figure-Ground** | Separates must-haves from nice-to-haves |
| **Continuity** | Checks for contradictions |

The interview continues until your requirements are clear enough (ambiguity score ≤ 0.2). This typically takes **5–10 rounds**.

---

## Example: Organizing Requirements in 5 Minutes

Here's what a real interview looks like. Start with:

```
/interview "I want to create a task management app for our team"
```

**Gestalt** (Round 1 — Closure):
> "What is the primary problem this app solves? Is it about tracking who is responsible for what, visibility into deadlines, or something else?"

**You:**
> "Mainly tracking who's doing what. We lose tasks in Slack threads."

**Gestalt** (Round 2 — Proximity):
> "What features should be grouped together in the first version? For example: task creation + assignment, or notification + status updates?"

**You:**
> "Task creation and assignment are the core. Notifications can come later."

**Gestalt** (Round 3 — Figure-Ground):
> "If you could only ship one thing, what would it be? And what's optional for the first release?"

**You:**
> "Must-have: create a task and assign it to someone. Nice-to-have: due dates and labels."

*...a few more rounds...*

**Gestalt:**
> "Ambiguity score: 0.17 ✓ Your requirements are clear enough. Run `/spec` to generate a structured plan."

**Total time: ~5 minutes.** Claude Code handles the AI reasoning in passthrough mode.

> **Tip:** Short, honest answers work best. Gestalt asks follow-up questions to fill in any gaps.

---

## Step 4: Generate a Spec

When the interview is complete, run:

```
/spec
```

Gestalt generates a structured **Spec** — a document that captures your goal, constraints, and measurable success criteria.

---

## Step 5: Create an Execution Plan

Transform your Spec into an actionable plan:

```
/execute
```

Gestalt breaks your requirements into tasks, validates dependencies, and runs them in the right order.

---

## How Passthrough Mode Works

Gestalt runs as an MCP server inside Claude Code. When you run `/interview` or `/spec`, Claude Code acts as the AI — Gestalt returns prompts and context, and Claude Code does the reasoning. The server makes no external API calls.

### CLI Mode (for automation and CI/CD)

If you want to run Gestalt without Claude Code open — for scripted workflows or CI pipelines — add an `ANTHROPIC_API_KEY`. Gestalt will then make its own LLM calls independently.

Create a `.env` file in your project root:

```
ANTHROPIC_API_KEY=your-api-key-here
```

Or add it to `gestalt.json`:

```json
{
  "llm": { "apiKey": "your-api-key-here" }
}
```

---

## Using Gestalt on claude.ai (Web)

You can use Gestalt directly on [claude.ai](https://claude.ai) by connecting it as a Remote MCP server.

### Option A: Self-Hosted (Local or Server)

Run Gestalt as an HTTP/SSE MCP server:

```bash
# Install globally
npm install -g @tienne/gestalt

# Start as an HTTP server (exposes port 3000 by default)
gestalt serve --port 3000
```

Then on [claude.ai](https://claude.ai):

1. Go to **Settings → Integrations**
2. Click **Add MCP Server**
3. Enter:
   - **Name:** Gestalt
   - **URL:** `http://localhost:3000/sse` (or your server's public URL)
4. Click **Connect**

### Option B: Cloud-Hosted

Deploy Gestalt to a cloud platform (Railway, Render, Fly.io, etc.) and use the public URL as your MCP endpoint.

```bash
# Example: deploy to Railway
railway up
# → https://your-app.railway.app
# MCP URL: https://your-app.railway.app/sse
```

### Using MCP Tools on claude.ai

Once connected, the same Gestalt tools are available in your claude.ai chat:

```
ges_interview({ action: "start", topic: "my project idea" })
```

The slash commands (`/interview`, `/spec`, `/execute`) require the Claude Code plugin and are not available on claude.ai web.

> **For most users, Claude Code with the plugin is the easiest option.** The web option is best for teams who want to share a single hosted Gestalt instance.

---

## Troubleshooting

**The plugin doesn't appear after install**
→ Restart Claude Code and check the Plugins panel.

**Interview stops unexpectedly**
→ Type `/interview` again with the same topic to resume.

**"Node.js >= 20.0.0 required" error**
→ Install Node.js: `nvm install 22 && nvm use 22` (or download from [nodejs.org](https://nodejs.org))

---

## Next Steps

- **[Full MCP Reference](./mcp-reference.md)** — all tools, parameters, and advanced usage
- **[How the Interview Works](./01-interview.md)** — deep dive into the interview engine
- **[Gestalt Principles Explained](./gestalt-principles.md)** — the psychology behind the approach
