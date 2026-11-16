import { allBlocks, type BlockOf, type PrdView } from './prd-schema.js';
import type { PrdIssue } from './lint-prd.js';

/** 요구사항 트리와 질문 참조는 문서 전체에서 검사한다. 섹션 사이 참조도 허용한다 */
export function lintPrdReferences(view: PrdView): PrdIssue[] {
  const blocks = new Map([...allBlocks(view)].map(({ block }) => [block.id, block]));
  const issues: PrdIssue[] = [];
  for (const { block, path } of allBlocks(view)) {
    if (block.kind !== 'requirement') continue;
    const push = (field: string, code: string, message: string) =>
      issues.push({
        path: `${path}.${field}`,
        severity: 'error',
        code,
        message,
        blockId: block.id,
      });
    if (block.parent && blocks.get(block.parent)?.kind !== 'requirement') {
      push('parent', 'UNKNOWN_PARENT', `상위 requirement "${block.parent}"가 없다`);
    }
    for (const [k, id] of (block.questions ?? []).entries()) {
      if (blocks.get(id)?.kind !== 'question')
        push(`questions.${k}`, 'UNKNOWN_QUESTION', `question "${id}"가 없다`);
    }
    const seen = new Set<string>([block.id]);
    let current: BlockOf<'requirement'> = block;
    let depth = 1;
    let cycle = false;
    while (current.parent) {
      if (seen.has(current.parent)) {
        push('parent', 'PARENT_CYCLE', '상위 요구사항 참조가 순환한다');
        cycle = true;
        break;
      }
      seen.add(current.parent);
      const parent = blocks.get(current.parent);
      if (parent?.kind !== 'requirement') break;
      current = parent;
      depth++;
    }
    if (!cycle && depth > 2)
      push('parent', 'REQUIREMENT_TOO_DEEP', '요구사항은 그룹과 기능 2단까지만 허용한다');
  }
  return issues;
}
