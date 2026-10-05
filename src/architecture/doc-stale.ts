import type { ArchitectureIr } from './types.js';
import type { ScannedDoc } from './doc-scan.js';
import { splitCodeLocation } from './doc-link.js';

export interface ChangedFile {
  /** 기술 IR의 repo id나 레포 이름, 또는 문서가 적은 레포 이름 */
  repo: string;
  path: string;
}

export interface StaleReason {
  /** code-ref는 문서가 직접 가리킨 파일, node는 문서가 설명하는 기술 노드의 근거 파일이 바뀌었다 */
  kind: 'code-ref' | 'node';
  file: string;
  node?: string;
  line?: number;
}

export interface StaleDoc {
  /** `<repoId>/<path>` */
  doc: string;
  title?: string;
  reasons: StaleReason[];
}

export interface StaleDocsOptions {
  /** 문서가 적은 레포 이름 → 기술 IR의 repo id */
  repoAliases?: Record<string, string>;
  /** link_docs가 쓴 knowledge-link IR. 없으면 문서가 직접 가리킨 파일만 본다 */
  linkIr?: ArchitectureIr;
}

/** 근거가 폴더를 가리켰으면 그 아래 파일이 바뀐 것도 문서에 닿는다 */
const covers = (ref: string, changed: string): boolean =>
  ref === changed || changed.startsWith(ref.endsWith('/') ? ref : `${ref}/`);

/**
 * 바뀐 파일 목록으로 손봐야 할 문서를 고른다. 문서가 직접 가리킨 파일이 바뀌었거나,
 * 문서가 설명한다고 이어진 기술 노드의 근거 파일이 바뀐 문서다
 */
export function findStaleDocs(
  scanned: readonly ScannedDoc[],
  changed: readonly ChangedFile[],
  options: StaleDocsOptions = {},
): StaleDoc[] {
  const ir = options.linkIr;
  const aliases = options.repoAliases ?? {};
  // 레포 이름과 id를 모두 id 하나로 모아 같은 레포를 다르게 불러도 맞게 한다
  const canon = (name: string): string =>
    aliases[name] ?? ir?.repos.find((r) => r.name === name || r.id === name)?.id ?? name;
  const changes = changed.map((c) => ({ repo: canon(c.repo), path: c.path.replace(/^\.?\//, '') }));
  const hit = (repo: string, path: string): string | undefined =>
    changes.find((c) => c.repo === canon(repo) && covers(path, c.path))?.path;

  const out = new Map<string, StaleDoc>();
  const add = (key: string, title: string | undefined, reason: StaleReason): void => {
    const cur = out.get(key) ?? {
      doc: key,
      ...(title !== undefined ? { title } : {}),
      reasons: [],
    };
    const dup = cur.reasons.some(
      (r) => r.kind === reason.kind && r.file === reason.file && r.node === reason.node,
    );
    if (!dup) cur.reasons.push(reason);
    out.set(key, cur);
  };

  for (const d of scanned) {
    for (const ref of d.codeRefs) {
      const file = hit(ref.repo, ref.path);
      if (file !== undefined)
        add(`${d.repoId}/${d.path}`, d.title, { kind: 'code-ref', file, line: ref.line });
    }
  }

  if (ir !== undefined) {
    const changedByNode = new Map<string, string>();
    for (const n of ir.nodes) {
      for (const e of n.evidence) {
        if (e.type !== 'code') continue;
        const loc = splitCodeLocation(e.location);
        const file = loc && hit(loc.repo, loc.path);
        if (file !== undefined && !changedByNode.has(n.id)) changedByNode.set(n.id, file);
      }
    }
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    for (const e of ir.edges) {
      if (e.kind !== 'describes') continue;
      const file = changedByNode.get(e.to);
      const src = byId.get(e.from);
      if (file === undefined || src?.repo === undefined || src.doc === undefined) continue;
      const key = `${src.repo}/${src.doc.path.replace(/#.*$/, '')}`;
      add(key, src.displayName, { kind: 'node', file, node: e.to });
    }
  }
  return [...out.values()].sort((a, b) => (a.doc < b.doc ? -1 : 1));
}
