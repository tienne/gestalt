import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { watch } from 'chokidar';
import { parseSkillMd } from './parser.js';
import type { SkillDefinition } from './types.js';
import { SKILLS_DIR } from '../core/constants.js';
import { log } from '../core/log.js';

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();
  private watcher: ReturnType<typeof watch> | null = null;
  private skillsDir: string;

  constructor(skillsDir?: string) {
    this.skillsDir = resolve(skillsDir ?? SKILLS_DIR);
  }

  loadAll(): void {
    if (!existsSync(this.skillsDir)) return;

    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const entries = readdirSync(this.skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = join(this.skillsDir, entry.name, 'SKILL.md');
        if (existsSync(skillPath)) {
          this.loadSkill(skillPath);
        }
      }
    }

    log(`Loaded ${this.skills.size} skill(s)`);
  }

  private loadSkill(filePath: string): void {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const skill = parseSkillMd(content, filePath);
      this.skills.set(skill.frontmatter.name, skill);
    } catch (e) {
      log(`Failed to load skill at ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  startWatching(): void {
    if (this.watcher) return;
    if (!existsSync(this.skillsDir)) return;

    this.watcher = watch(join(this.skillsDir, '**/SKILL.md'), {
      ignoreInitial: true,
    });

    this.watcher.on('add', (path) => {
      log(`Skill added: ${path}`);
      this.loadSkill(path);
    });

    this.watcher.on('change', (path) => {
      log(`Skill changed: ${path}`);
      this.loadSkill(path);
    });

    this.watcher.on('unlink', (path) => {
      for (const [name, skill] of this.skills) {
        if (skill.filePath === path) {
          this.skills.delete(name);
          log(`Skill removed: ${name}`);
          break;
        }
      }
    });
  }

  async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  getAll(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }
}
