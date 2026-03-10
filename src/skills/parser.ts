import matter from 'gray-matter';
import { z } from 'zod';
import { SkillParseError } from '../core/errors.js';
import type { SkillDefinition, SkillFrontmatter } from './types.js';

const skillInputSchema = z.object({
  type: z.string(),
  required: z.boolean().default(false),
  description: z.string().default(''),
});

const skillFrontmatterSchema = z.object({
  name: z.string().min(1),
  version: z.string().default('1.0.0'),
  description: z.string().default(''),
  triggers: z.array(z.string()).default([]),
  inputs: z.record(z.string(), skillInputSchema).default({}),
  outputs: z.array(z.string()).default([]),
});

export function parseSkillMd(content: string, filePath: string): SkillDefinition {
  try {
    const { data, content: body } = matter(content);
    const result = skillFrontmatterSchema.safeParse(data);

    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      throw new SkillParseError(
        `Invalid SKILL.md frontmatter in ${filePath}:\n${issues.join('\n')}`,
      );
    }

    return {
      frontmatter: result.data as SkillFrontmatter,
      body: body.trim(),
      filePath,
    };
  } catch (e) {
    if (e instanceof SkillParseError) throw e;
    throw new SkillParseError(
      `Failed to parse SKILL.md at ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
