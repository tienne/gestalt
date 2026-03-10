export interface SkillFrontmatter {
  name: string;
  version: string;
  description: string;
  triggers: string[];
  inputs: Record<string, SkillInputDef>;
  outputs: string[];
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
