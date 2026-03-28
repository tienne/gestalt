# Getting Started with Gestalt

> **Goal:** Run your first interview in 5 minutes — no terminal, no API key required.

---

## What is Gestalt?

Gestalt is a tool that helps you turn vague ideas into structured plans. You describe what you want to build, and Gestalt asks targeted questions until your requirements are clear enough to act on.

It works entirely inside Claude Desktop — no extra accounts, no API keys.

---

## Step 1: Install the Plugin

### In Claude Desktop

1. Open Claude Desktop
2. Click the **Plugins** icon (puzzle piece) in the sidebar
3. Search for **"Gestalt"** in the marketplace
4. Click **Install**

> **Screenshot placeholder:** Claude Desktop plugin marketplace with Gestalt search result

Once installed, you'll see the Gestalt tools available in your Claude Desktop session.

**Alternative (one-time CLI setup):**

```bash
/plugin marketplace add tienne/gestalt
/plugin install gestalt@gestalt
```

---

## Step 2: Run Your First Interview

> **Skip the interview:** If you already have a clear idea, generate a spec directly without going through the interview:
> ```
> ges_generate_spec({ text: "I want to build [your idea here]" })
> ```
> The result is saved to `.gestalt/memory.json` and future specs automatically inherit the context.

Type this in Claude Desktop to start an interview:

```
/interview "I want to build [your idea here]"
```

**Example:**

```
/interview "I want to create a mobile app that helps people track their daily water intake"
```

Gestalt will guide you through a structured conversation. Just answer the questions — no technical knowledge required.

> **Screenshot placeholder:** Claude Desktop showing the first interview question

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

**Total time: ~5 minutes.** No API key needed — Claude Desktop handles the AI reasoning in passthrough mode.

> **Tip:** You don't need to write perfect answers. Short, honest responses work best. Gestalt asks follow-up questions to fill in any gaps.

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

## No API Key? No Problem.

Gestalt runs in **Passthrough Mode** by default — Claude Desktop handles all AI reasoning. The Gestalt server only manages state and structure.

You don't need an `ANTHROPIC_API_KEY` to use Gestalt with Claude Desktop.

### What if I have an API key?

If you add an `ANTHROPIC_API_KEY` to your Gestalt configuration, Gestalt can run its own LLM calls independently (useful for automation or CI/CD pipelines). For most users, passthrough mode is all you need.

**To add an API key (optional):**

Create a `.env` file in your project root:

```
ANTHROPIC_API_KEY=your-api-key-here
```

Or create `gestalt.json`:

```json
{
  "llm": { "apiKey": "your-api-key-here" }
}
```

With an API key, Gestalt can run interviews and spec generation autonomously — without Claude Desktop being open. This is useful for scripted workflows and CI pipelines.

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

> **For most users, Claude Desktop with the plugin is the easiest option.** The web option is best for teams who want to share a single hosted Gestalt instance.

---

## Troubleshooting

**The plugin doesn't appear after install**
→ Restart Claude Desktop and check the Plugins panel.

**Interview stops unexpectedly**
→ Type `/interview` again with the same topic to resume.

**"Node.js >= 20.0.0 required" error**
→ Install Node.js: `nvm install 22 && nvm use 22` (or download from [nodejs.org](https://nodejs.org))

---

## Next Steps

- **[Full MCP Reference](./mcp-reference.md)** — all tools, parameters, and advanced usage
- **[How the Interview Works](./01-interview.md)** — deep dive into the interview engine
- **[Gestalt Principles Explained](./gestalt-principles.md)** — the psychology behind the approach
