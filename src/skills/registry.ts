import { BaseRegistry } from '../registry/base-registry.js';
import { parseSkillMd } from './parser.js';
import type { SkillDefinition } from './types.js';
import { SKILLS_DIR } from '../core/constants.js';

export class SkillRegistry extends BaseRegistry<SkillDefinition> {
  constructor(skillsDir?: string) {
    super({
      dir: skillsDir ?? SKILLS_DIR,
      filename: 'SKILL.md',
      label: 'skill',
    });
  }

  protected parse(content: string, filePath: string): SkillDefinition {
    return parseSkillMd(content, filePath);
  }

  protected getName(item: SkillDefinition): string {
    return item.frontmatter.name;
  }
}
