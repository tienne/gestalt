import type { SkillDefinition } from './types.js';
import { SkillParseError } from '../core/errors.js';

export interface SkillContext {
  inputs: Record<string, unknown>;
  cwd: string;
}

export interface SkillResult {
  skillName: string;
  body: string;
  inputs: Record<string, unknown>;
}

export class SkillExecutor {
  execute(skill: SkillDefinition, context: SkillContext): SkillResult {
    // Validate required inputs
    for (const [name, def] of Object.entries(skill.frontmatter.inputs)) {
      if (def.required && !(name in context.inputs)) {
        throw new SkillParseError(`Missing required input: ${name}`);
      }
    }

    return {
      skillName: skill.frontmatter.name,
      body: skill.body,
      inputs: context.inputs,
    };
  }
}
