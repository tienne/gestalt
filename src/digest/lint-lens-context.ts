import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { DigestIssue } from './lint.js';
import type { Report } from './schema.js';
import { readRaw, type DigestStore } from './store.js';

export const KNOWLEDGE_FILE = 'knowledge.json';

export const knowledgeFileSchema = z.object({
  roots: z.array(z.string()),
  terms: z.array(z.string()),
  hits: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().positive(),
      text: z.string(),
      terms: z.array(z.string()),
    }),
  ),
});

export type KnowledgeFile = z.infer<typeof knowledgeFileSchema>;

/**
 * 내 지식 소스. merge와 validate가 knowledge.json의 폴더 목록과 파일 읽기를 넘긴다.
 * undefined면 파일 대조를 건너뛰고(이미 합친 리포트를 다시 그릴 때) null이면 지식 소스가 없는 것이라 연결 카드를 하나도 받지 않는다
 */
export interface KnowledgeContext {
  roots: string[];
  /** 절대 경로의 파일 글자. 없거나 못 읽으면 null */
  read: (absPath: string) => string | null;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 바깥 맥락 카드와 내 지식 연결 카드를 본다. 카드 줄마다 바깥 출처가 있어야 하고
 * 연결 카드의 인용은 그 노트 파일에 글자 그대로 있어야 한다
 */
export function lintLensContext(
  report: Report,
  p: string,
  knowledge: KnowledgeContext | null | undefined,
  issues: DigestIssue[],
): void {
  const sectionIds = new Set(report.sections.map((s) => s.id));
  const cardIds = new Set<string>();
  (report.cards ?? []).forEach((card, k) => {
    const cp = `${p}.cards.${k}`;
    if (cardIds.has(card.id)) {
      issues.push({
        path: `${cp}.id`,
        severity: 'error',
        code: 'DUPLICATE_ID',
        message: `카드 id ${card.id}가 겹친다`,
      });
    }
    cardIds.add(card.id);
    if (!sectionIds.has(card.section)) {
      issues.push({
        path: `${cp}.section`,
        severity: 'error',
        code: 'CARD_SECTION_UNKNOWN',
        message: `대섹션 ${card.section}이 리포트에 없다`,
      });
    }
    const sources = new Set(card.sources.map((s) => s.id));
    const used = new Set<string>();
    card.points.forEach((pt, j) => {
      for (const id of pt.sources) {
        used.add(id);
        if (!sources.has(id)) {
          issues.push({
            path: `${cp}.points.${j}.sources`,
            severity: 'error',
            code: 'CARD_SOURCE_UNKNOWN',
            message: `출처 ${id}가 카드 sources에 없다`,
          });
        }
      }
    });
    card.lineage?.forEach((l, j) => {
      used.add(l.source);
      if (!sources.has(l.source)) {
        issues.push({
          path: `${cp}.lineage.${j}.source`,
          severity: 'error',
          code: 'CARD_SOURCE_UNKNOWN',
          message: `출처 ${l.source}가 카드 sources에 없다`,
        });
      }
    });
    for (const s of card.sources) {
      if (used.has(s.id)) continue;
      issues.push({
        path: `${cp}.sources`,
        severity: 'warning',
        code: 'CARD_SOURCE_UNUSED',
        message: `출처 ${s.id}를 어느 줄도 쓰지 않는다`,
      });
    }
  });

  report.limits?.forEach((limit, k) => {
    if (limit.card && !cardIds.has(limit.card)) {
      issues.push({
        path: `${p}.limits.${k}.card`,
        severity: 'error',
        code: 'LIMIT_CARD_UNKNOWN',
        message: `맥락 카드 ${limit.card}가 cards에 없다`,
      });
    }
  });

  report.links?.forEach((link, k) => {
    const lp = `${p}.links.${k}`;
    if (!sectionIds.has(link.section)) {
      issues.push({
        path: `${lp}.section`,
        severity: 'error',
        code: 'LINK_SECTION_UNKNOWN',
        message: `대섹션 ${link.section}이 리포트에 없다`,
      });
    }
    if (knowledge === undefined) return;
    if (knowledge === null) {
      issues.push({
        path: lp,
        severity: 'error',
        code: 'LINK_NO_KNOWLEDGE',
        message:
          'knowledge.json이 없어 연결 카드를 대조할 수 없다. gestalt lens knowledge를 먼저 돌린다',
      });
      return;
    }
    if (!isAbsolute(link.path) || !knowledge.roots.some((r) => inside(r, link.path))) {
      issues.push({
        path: `${lp}.path`,
        severity: 'error',
        code: 'LINK_OUTSIDE_SOURCES',
        message: `${link.path}는 지식 소스 폴더(${knowledge.roots.join(', ')}) 안의 절대 경로가 아니다`,
      });
      return;
    }
    const text = knowledge.read(link.path);
    if (text === null) {
      issues.push({
        path: `${lp}.path`,
        severity: 'error',
        code: 'LINK_FILE_MISSING',
        message: `${link.path}를 못 읽었다`,
      });
    } else if (!squash(text).includes(squash(link.quote))) {
      issues.push({
        path: `${lp}.quote`,
        severity: 'error',
        code: 'LINK_QUOTE_NOT_FOUND',
        message: '인용이 노트 파일에 글자 그대로 없다. 노트에서 그대로 옮긴다',
      });
    }
  });
}

/** merge와 validate가 연결 카드를 대조할 때 쓴다. knowledge.json이 없으면 null */
export function knowledgeContext(store: DigestStore, slug: string): KnowledgeContext | null {
  const raw = readRaw(join(store.dir(slug), KNOWLEDGE_FILE));
  if (raw.kind !== 'ok') return null;
  const parsed = knowledgeFileSchema.safeParse(raw.value);
  if (!parsed.success) return null;
  return {
    roots: parsed.data.roots,
    read: (abs) => {
      if (!isAbsolute(abs)) return null;
      try {
        return readFileSync(abs, 'utf-8');
      } catch {
        return null;
      }
    },
  };
}
