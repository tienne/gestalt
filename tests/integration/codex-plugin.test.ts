import { describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function parse(result: { content: unknown }) {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find((x) => x.type === 'text')!.text!);
}

// This exercises copied plugin assets and real source MCP processes without a
// prior build. Built CLI installation is covered by the separate packaging suite;
// neither suite claims a registry install or an LLM-driven Codex end-to-end test.
describe('Codex copied-plugin installation contracts', () => {
  it('ships physical skills, host adapter, CLI scripts and intact agent references', () => {
    const root = mkdtempSync(join(tmpdir(), 'gestalt-plugin-assets-'));
    try {
      const installed = join(root, 'plugin');
      cpSync(join(ROOT, 'plugin'), installed, { recursive: true });
      const files = readdirSync(installed, { recursive: true, withFileTypes: true });
      expect(files.some((x) => x.isSymbolicLink())).toBe(false);
      expect(existsSync(join(installed, 'node_modules'))).toBe(false);
      expect(existsSync(join(installed, '.git'))).toBe(false);
      const manifest = JSON.parse(
        readFileSync(join(installed, '.codex-plugin/plugin.json'), 'utf8'),
      );
      expect(existsSync(resolve(installed, manifest.skills))).toBe(true);
      expect(existsSync(resolve(installed, manifest.mcpServers))).toBe(true);
      for (const skill of readdirSync(join(installed, 'skills'), { withFileTypes: true }).filter(
        (x) => x.isDirectory() && !x.name.startsWith('_'),
      )) {
        const source = readFileSync(join(installed, 'skills', skill.name, 'SKILL.md'), 'utf8');
        expect(source, skill.name).toContain('../_shared/host-runtime.md');
        expect(
          source,
          `${skill.name} must use the versioned launcher instead of global/cwd probes`,
        ).not.toMatch(
          /if gestalt --version|pnpm tsx bin\/gestalt\.ts --version|npm i -g @tienne\/gestalt/,
        );
      }
      expect(existsSync(join(installed, 'skills/_shared/host-runtime.md'))).toBe(true);
      expect(
        readFileSync(join(installed, 'skills/_shared/host-runtime.md'), 'utf8'),
        'Every skill reaches the versioned CLI launcher through its mandatory host adapter',
      ).toContain('./cli-launcher.md');
      expect(existsSync(join(installed, 'scripts/gestalt-cli.mjs'))).toBe(true);
      expect(
        existsSync(
          join(
            installed,
            'skills/review/../../role-agents/_shared/references/ai-tell-quick-rules.md',
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('connects as Codex to local MCP with only copied plugin assets and persists an interview', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gestalt-codex-mcp-'));
    const installed = join(root, 'plugin');
    cpSync(join(ROOT, 'plugin'), installed, { recursive: true });
    const project = join(root, 'project');
    mkdirSync(project);
    const client = new Client(
      { name: 'codex', version: 'installation-test' },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        join(ROOT, 'node_modules/tsx/dist/loader.mjs'),
        join(ROOT, 'bin/gestalt.ts'),
        'serve',
      ],
      cwd: project,
      env: {
        PATH: process.env.PATH ?? '',
        GESTALT_HOME: join(root, 'home'),
        GESTALT_DB_PATH: join(root, 'events.db'),
        GESTALT_NO_UPDATE_CHECK: '1',
        GESTALT_NOTIFICATIONS: 'false',
        ...Object.fromEntries(
          [
            ['SKILLS', 'skills'],
            ['AGENTS', 'agents'],
            ['ROLE_AGENTS', 'role-agents'],
            ['REVIEW_AGENTS', 'review-agents'],
            ['PERSONAS', 'personas'],
            ['RESEARCH_SOURCES', 'research-sources'],
          ].map(([key, dir]) => [`GESTALT_${key}_DIR`, join(installed, dir!)]),
        ),
      },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (x) => {
      stderr += x.toString();
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((x) => x.name)).toContain('ges_interview');
      const status = parse(await client.callTool({ name: 'ges_status', arguments: {} }));
      expect(status.client, stderr).toBe('codex');
      expect(status.hostClient).toBe('codex');
      expect(status.tierModels.standard).toBe('inherit');
      const agent = parse(
        await client.callTool({
          name: 'ges_agent',
          arguments: { action: 'get', name: 'architect' },
        }),
      );
      expect(agent.model).toBe('inherit');
      expect(agent.systemPrompt).toBeTruthy();
      const started = parse(
        await client.callTool({
          name: 'ges_interview',
          arguments: { action: 'start', topic: 'A project notes tracker', cwd: project },
        }),
      );
      expect(started.status).toBe('started');
      expect(started.gestaltContext).toBeTruthy();
      const response = parse(
        await client.callTool({
          name: 'ges_interview',
          arguments: {
            action: 'respond',
            sessionId: started.sessionId,
            generatedQuestion: 'Which data should a note contain?',
            response: 'A title and a body.',
          },
        }),
      );
      expect(response.status).toBe('in_progress');
      const saved = parse(
        await client.callTool({ name: 'ges_status', arguments: { sessionId: started.sessionId } }),
      );
      expect(saved.session.sessionId).toBe(started.sessionId);
      expect(saved.session.answeredRounds).toBe(1);
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
