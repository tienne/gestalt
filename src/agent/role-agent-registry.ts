import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { log } from '../core/log.js';
import { parseAgentMd } from './parser.js';
import type { AgentDefinition } from '../core/types.js';

/**
 * RoleAgentRegistry: 내장 role-agents/ + 사용자 agents/ (role=true)를 병합.
 * 동일 이름은 커스텀이 오버라이드.
 */
export class RoleAgentRegistry {
  private agents = new Map<string, AgentDefinition>();

  constructor(
    private builtinDir: string,
    private customDir?: string,
  ) {}

  loadAll(): void {
    // 1. 내장 role agents 로드
    this.loadFromDir(resolve(this.builtinDir));

    // 2. 커스텀 디렉토리에서 role=true인 에이전트 로드 (오버라이드)
    if (this.customDir) {
      this.loadFromDir(resolve(this.customDir), true);
    }

    log(`Loaded ${this.agents.size} role agent(s)`);
  }

  private loadFromDir(dir: string, onlyRoles = false): void {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = join(dir, entry.name, 'AGENT.md');
      if (!existsSync(filePath)) continue;

      try {
        const content = readFileSync(filePath, 'utf-8');
        const agent = parseAgentMd(content, filePath);

        if (onlyRoles && !agent.frontmatter.role) continue;

        this.agents.set(agent.frontmatter.name, agent);
      } catch (e) {
        log(`Failed to load role agent at ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  getAll(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  getByName(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  getByDomain(domain: string): AgentDefinition[] {
    const lower = domain.toLowerCase();
    return this.getAll().filter((a) =>
      a.frontmatter.domain?.some((d) => d.toLowerCase() === lower),
    );
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }
}
