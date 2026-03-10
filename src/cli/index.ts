import { Command } from 'commander';
import { interviewCommand } from './commands/interview.js';
import { seedCommand } from './commands/seed.js';
import { serveCommand } from './commands/serve.js';
import { statusCommand } from './commands/status.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('gestalt')
    .description('Gestalt — AI Development Harness with Gestalt psychology-driven requirement clarification')
    .version('0.1.0');

  program
    .command('interview [topic]')
    .description('Start an interactive Gestalt interview')
    .action(async (topic: string | undefined) => {
      await interviewCommand(topic ?? 'Untitled project');
    });

  program
    .command('seed <session-id>')
    .description('Generate a Seed specification from a completed interview')
    .option('-f, --force', 'Force generation even if ambiguity threshold is not met')
    .action(async (sessionId: string, options: { force?: boolean }) => {
      await seedCommand(sessionId, options);
    });

  program
    .command('serve')
    .description('Start the Gestalt MCP server (stdio transport)')
    .action(async () => {
      await serveCommand();
    });

  program
    .command('status [session-id]')
    .description('Check interview session status')
    .action((sessionId?: string) => {
      statusCommand(sessionId);
    });

  return program;
}
