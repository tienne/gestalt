import { Command } from 'commander';
import { interviewCommand } from './commands/interview.js';
import { specCommand } from './commands/spec.js';
import { serveCommand } from './commands/serve.js';
import { statusCommand } from './commands/status.js';
import { setupCommand } from './commands/setup.js';
import { initCommand } from './commands/init.js';
import { monitorCommand } from './commands/monitor.js';
import { getVersion } from '../core/version.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('gestalt')
    .description('Gestalt — AI Development Harness with Gestalt psychology-driven requirement clarification')
    .version(getVersion());

  program
    .command('serve', { isDefault: true })
    .description('Start the Gestalt MCP server (stdio transport)')
    .action(async () => {
      await serveCommand();
    });

  program
    .command('interview [topic]')
    .description('Start an interactive Gestalt interview')
    .option('--no-record', 'Disable automatic terminal session recording')
    .option('--mp4', 'Also generate an MP4 alongside the GIF')
    .action(async (topic: string | undefined, options: { record?: boolean; mp4?: boolean }) => {
      await interviewCommand(topic ?? 'Untitled project', options);
    });

  program
    .command('spec <session-id>')
    .description('Generate a Spec from a completed interview')
    .option('-f, --force', 'Force generation even if ambiguity threshold is not met')
    .action(async (sessionId: string, options: { force?: boolean }) => {
      await specCommand(sessionId, options);
    });

  program
    .command('status [session-id]')
    .description('Check interview session status')
    .action((sessionId?: string) => {
      statusCommand(sessionId);
    });

  program
    .command('init')
    .description('Initialize Gestalt: create gestalt.json, build code graph, and install post-commit hook')
    .option('--skip-graph', 'Skip code graph build')
    .option('--skip-hook', 'Skip post-commit hook installation')
    .action(async (options: { skipGraph?: boolean; skipHook?: boolean }) => {
      await initCommand(options);
    });

  program
    .command('setup')
    .description('Generate a gestalt.json configuration file')
    .action(() => {
      setupCommand();
    });

  program
    .command('monitor [session-id]')
    .description('Launch TUI dashboard for real-time pipeline monitoring')
    .action(async (sessionId?: string) => {
      await monitorCommand(sessionId);
    });

  return program;
}
