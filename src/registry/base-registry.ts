import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { watch } from 'chokidar';
import { log } from '../core/log.js';

export interface RegistryItem {
  filePath: string;
}

export interface RegistryOptions {
  dir: string;
  filename: string;
  label: string;
}

export abstract class BaseRegistry<T extends RegistryItem> {
  protected items = new Map<string, T>();
  private watcher: ReturnType<typeof watch> | null = null;
  protected readonly dir: string;
  protected readonly filename: string;
  protected readonly label: string;

  constructor(options: RegistryOptions) {
    this.dir = resolve(options.dir);
    this.filename = options.filename;
    this.label = options.label;
  }

  protected abstract parse(content: string, filePath: string): T;
  protected abstract getName(item: T): string;

  loadAll(): void {
    if (!existsSync(this.dir)) return;

    const entries = readdirSync(this.dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const filePath = join(this.dir, entry.name, this.filename);
        if (existsSync(filePath)) {
          this.loadItem(filePath);
        }
      }
    }

    log(`Loaded ${this.items.size} ${this.label}(s)`);
  }

  private loadItem(filePath: string): void {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const item = this.parse(content, filePath);
      this.items.set(this.getName(item), item);
    } catch (e) {
      log(
        `Failed to load ${this.label} at ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  startWatching(): void {
    if (this.watcher) return;
    if (!existsSync(this.dir)) return;

    this.watcher = watch(join(this.dir, `**/${this.filename}`), {
      ignoreInitial: true,
    });

    this.watcher.on('add', (path) => {
      log(`${this.label} added: ${path}`);
      this.loadItem(path);
    });

    this.watcher.on('change', (path) => {
      log(`${this.label} changed: ${path}`);
      this.loadItem(path);
    });

    this.watcher.on('unlink', (path) => {
      for (const [name, item] of this.items) {
        if (item.filePath === path) {
          this.items.delete(name);
          log(`${this.label} removed: ${name}`);
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

  get(name: string): T | undefined {
    return this.items.get(name);
  }

  getAll(): T[] {
    return Array.from(this.items.values());
  }

  has(name: string): boolean {
    return this.items.has(name);
  }
}
