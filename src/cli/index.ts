import { Command } from 'commander';
import { interviewCommand } from './commands/interview.js';
import { specCommand } from './commands/spec.js';
import { serveCommand } from './commands/serve.js';
import { statusCommand } from './commands/status.js';
import { setupCommand } from './commands/setup.js';
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
    .action(async (topic: string | undefined) => {
      await interviewCommand(topic ?? 'Untitled project');
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
    .command('setup')
    .description('Generate a gestalt.json configuration file')
    .action(() => {
      setupCommand();
    });

  return program;
}
