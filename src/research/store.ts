import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOrQuarantine, writeJsonAtomic } from '../core/json-file.js';
import { parseResearch, type Research } from './schema.js';

export type ResearchAudience = 'private' | 'shared';

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/**
 * 리서치 결과 저장소: `<repoRoot>/.gestalt/research/<slug>/`.
 * `.gestalt/`는 gitignore 대상이라 캡처와 근거 자료가 커밋에 딸려가지 않는다.
 */
export class ResearchStore {
  private readonly root: string;

  constructor(repoRoot: string) {
    this.root = join(repoRoot, '.gestalt', 'research');
  }

  /** slug는 경로 조각이라 패턴을 통과한 것만 받는다 */
  dir(slug: string): string {
    if (!isValidSlug(slug)) throw new Error(`slug가 올바르지 않다: ${slug}`);
    return join(this.root, slug);
  }

  capturesDir(slug: string): string {
    return join(this.dir(slug), 'captures');
  }

  jsonPath(slug: string): string {
    return join(this.dir(slug), 'research.json');
  }

  htmlPath(slug: string, audience: ResearchAudience): string {
    return join(this.dir(slug), audience === 'shared' ? 'research.shared.html' : 'research.html');
  }

  /** 없으면 null. 깨졌거나 스키마에 안 맞으면 `.corrupt-*`로 옮기고 null */
  load(slug: string): Research | null {
    const raw = readJsonOrQuarantine(this.jsonPath(slug), (v) => parseResearch(v).ok);
    if (raw === undefined) return null;
    const parsed = parseResearch(raw);
    return parsed.ok ? parsed.value : null;
  }

  save(research: Research): string {
    const path = this.jsonPath(research.meta.slug);
    writeJsonAtomic(path, research);
    return path;
  }

  saveHtml(slug: string, audience: ResearchAudience, html: string): string {
    const path = this.htmlPath(slug, audience);
    mkdirSync(this.dir(slug), { recursive: true });
    writeFileSync(path, html, 'utf-8');
    return path;
  }
}
