import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { log } from '../core/log.js';
import { parseSourceMd, type SourceDefinition } from './source-schema.js';

export type SourceOrigin = 'builtin' | 'personal';

export interface LoadedSource extends SourceDefinition {
  origin: SourceOrigin;
  filePath: string;
  /** 같은 이름의 내장 출처를 개인 출처가 덮어썼는지 */
  overridden: boolean;
}

export interface SourceDiagnostic {
  filePath: string;
  message: string;
}

/**
 * ResearchSourceRegistry: 내장 research-sources/ 다음에 개인 research-sources/를 읽는다.
 * 같은 이름이면 나중에 읽은 개인 쪽이 덮어쓴다. RoleAgentRegistry와 같은 순서다.
 */
export class ResearchSourceRegistry {
  private sources = new Map<string, LoadedSource>();
  private diagnostics: SourceDiagnostic[] = [];

  constructor(
    private builtinDir: string,
    private personalDir?: string,
  ) {}

  loadAll(): void {
    this.sources.clear();
    this.diagnostics = [];
    this.loadFromDir(resolve(this.builtinDir), 'builtin');
    if (this.personalDir) this.loadFromDir(resolve(this.personalDir), 'personal');
  }

  private loadFromDir(dir: string, origin: SourceOrigin): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = join(dir, entry.name, 'SOURCE.md');
      if (!existsSync(filePath)) continue;
      const problem = (message: string): void => {
        this.diagnostics.push({ filePath, message });
        log(`research source를 못 읽었어요 ${filePath}: ${message}`);
      };
      try {
        if (!statSync(filePath).isFile()) continue;
        const parsed = parseSourceMd(readFileSync(filePath, 'utf-8'));
        if (!parsed.ok) {
          problem(parsed.error.message);
          continue;
        }
        const name = parsed.value.frontmatter.name;
        if (name !== entry.name) {
          problem(`name(${name})이 디렉토리 이름(${entry.name})과 다르다`);
          continue;
        }
        const previous = this.sources.get(name);
        this.sources.set(name, {
          ...parsed.value,
          origin,
          filePath,
          overridden: previous !== undefined,
        });
      } catch (e) {
        problem(e instanceof Error ? e.message : String(e));
      }
    }
  }

  getAll(): LoadedSource[] {
    return [...this.sources.values()].sort((a, b) =>
      a.frontmatter.name.localeCompare(b.frontmatter.name),
    );
  }

  getByName(name: string): LoadedSource | undefined {
    return this.sources.get(name);
  }

  getDiagnostics(): SourceDiagnostic[] {
    return [...this.diagnostics];
  }
}
