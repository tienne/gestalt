import { BaseRegistry } from '../registry/base-registry.js';
import { parseAgentMd } from './parser.js';
import type { AgentDefinition, AgentPipeline } from '../core/types.js';

const AGENTS_DIR = 'agents';

export class AgentRegistry extends BaseRegistry<AgentDefinition> {
  constructor(agentsDir?: string) {
    super({
      dir: agentsDir ?? AGENTS_DIR,
      filename: 'AGENT.md',
      label: 'agent',
    });
  }

  protected parse(content: string, filePath: string): AgentDefinition {
    return parseAgentMd(content, filePath);
  }

  protected getName(item: AgentDefinition): string {
    return item.frontmatter.name;
  }

  getByPipeline(pipeline: AgentPipeline): AgentDefinition[] {
    return this.getAll().filter((a) => a.frontmatter.pipeline === pipeline && !a.frontmatter.role);
  }

  getByRole(): AgentDefinition[] {
    return this.getAll().filter((a) => a.frontmatter.role === true);
  }
}
