import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, type GestaltConfig } from '../core/config.js';
import { log } from '../core/log.js';
import { EventStore } from '../events/store.js';
import { AnthropicAdapter } from '../llm/adapter.js';
import { InterviewEngine } from '../interview/engine.js';
import { SeedGenerator } from '../seed/generator.js';
import { SkillRegistry } from '../skills/registry.js';
import { handleInterview } from './tools/interview.js';
import { handleSeed } from './tools/seed.js';
import { handleStatus } from './tools/status.js';
import { interviewInputSchema, seedInputSchema, statusInputSchema } from './schemas.js';

export async function createMcpServer(configOverrides?: Partial<GestaltConfig>) {
  const config = loadConfig(configOverrides);
  const eventStore = new EventStore(config.dbPath);
  const llm = new AnthropicAdapter(config.anthropicApiKey, config.model);
  const engine = new InterviewEngine(llm, eventStore);
  const seedGenerator = new SeedGenerator(llm, eventStore);
  const skillRegistry = new SkillRegistry(config.skillsDir);

  skillRegistry.loadAll();

  const server = new McpServer({
    name: 'gestalt',
    version: '0.1.0',
  });

  // ─── gestalt_interview ──────────────────────────────────────
  server.tool(
    'gestalt_interview',
    'Conduct a Gestalt-driven interview to clarify project requirements. Actions: start, respond, score, complete.',
    {
      action: z.enum(['start', 'respond', 'score', 'complete']).describe(
        'start: begin interview, respond: answer a question, score: check ambiguity, complete: finish interview',
      ),
      topic: z.string().optional().describe('Topic for the interview (required for start)'),
      sessionId: z.string().optional().describe('Session ID (required for respond/score/complete)'),
      response: z.string().optional().describe('User response to the current question (required for respond)'),
      cwd: z.string().optional().describe('Working directory for brownfield detection'),
    },
    async (params) => {
      const input = interviewInputSchema.parse(params);
      const result = await handleInterview(engine, input);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // ─── gestalt_generate_seed ──────────────────────────────────
  server.tool(
    'gestalt_generate_seed',
    'Generate a Seed specification from a completed interview session.',
    {
      sessionId: z.string().describe('The interview session ID'),
      force: z.boolean().optional().default(false).describe(
        'Force generation even if ambiguity threshold is not met',
      ),
    },
    async (params) => {
      const input = seedInputSchema.parse(params);
      const result = await handleSeed(engine, seedGenerator, input);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // ─── gestalt_status ─────────────────────────────────────────
  server.tool(
    'gestalt_status',
    'Check the status of interview sessions.',
    {
      sessionId: z.string().optional().describe('Specific session ID to check (omit for all sessions)'),
    },
    (params) => {
      const input = statusInputSchema.parse(params);
      const result = handleStatus(engine, input);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  return { server, eventStore, skillRegistry };
}

export async function startMcpServer(configOverrides?: Partial<GestaltConfig>) {
  const { server, skillRegistry } = await createMcpServer(configOverrides);

  skillRegistry.startWatching();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('MCP server started on stdio');

  process.on('SIGINT', async () => {
    await skillRegistry.stopWatching();
    await server.close();
    process.exit(0);
  });
}
