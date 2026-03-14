import matter from 'gray-matter';
import { z } from 'zod';
import { SkillParseError } from '../core/errors.js';
import type { AgentDefinition, AgentFrontmatter } from '../core/types.js';

const agentFrontmatterSchema = z.object({
  name: z.string().min(1),
  model: z.string().optional(),
  tier: z.enum(['frugal', 'standard', 'frontier']),
  pipeline: z.enum(['interview', 'spec', 'execute', 'evaluate']),
  escalateTo: z.string().optional(),
  description: z.string().min(1),
  role: z.boolean().default(false),
  domain: z.array(z.string()).default([]),
});

export function parseAgentMd(content: string, filePath: string): AgentDefinition {
  try {
    const { data, content: body } = matter(content);
    const result = agentFrontmatterSchema.safeParse(data);

    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      throw new SkillParseError(
        `Invalid AGENT.md frontmatter in ${filePath}:\n${issues.join('\n')}`,
      );
    }

    return {
      frontmatter: result.data as AgentFrontmatter,
      systemPrompt: body.trim(),
      filePath,
    };
  } catch (e) {
    if (e instanceof SkillParseError) throw e;
    throw new SkillParseError(
      `Failed to parse AGENT.md at ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
