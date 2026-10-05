export interface SkillFrontmatter {
  name: string;
  version: string;
  description: string;
  triggers: string[];
  inputs: Record<string, SkillInputDef>;
  outputs: string[];
  /** 있으면 proactive-routing.md 스킬 표에 triggers와 함께 실린다 */
  routing?: { note?: string };
}

export interface SkillInputDef {
  type: string;
  required: boolean;
  description: string;
}

export interface SkillDefinition {
  frontmatter: SkillFrontmatter;
  body: string;
  filePath: string;
}
