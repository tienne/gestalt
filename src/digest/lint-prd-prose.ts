import { detect, splitLines, splitSentences } from '../humanize/detectors.js';
import { allBlocks, type PrdView } from './prd-schema.js';
import { classifyLines, type PrdSource } from './prd-source.js';

export const PRD_PROSE_CODES = [
  'REQ_NO_SUBJECT',
  'REQ_NO_BOUNDARY',
  'MODAL_AMBIGUOUS',
  'RISK_NO_RESPONSE',
  'SENTENCE_LONG',
  'PROSE_AI_TELL',
] as const;
export type PrdProseCode = (typeof PRD_PROSE_CODES)[number];
export interface PrdProseSample {
  sentence: string;
  blockId?: string;
  field?: string;
  line?: number;
  ruleId?: string;
}
export interface PrdProseGroup {
  code: PrdProseCode;
  severity: 'info';
  count: number;
  samples: PrdProseSample[];
}
export const PROSE_SAMPLE_LIMIT = 3;
const SUBJECT = /(?:^|\s)[가-힣A-Za-z][가-힣A-Za-z0-9]*(?:은|는|이|가)\s/;
const MODAL = /[가-힣]+\s*수\s*있(?:다|습니다|어요)/;

/** 원문을 고치지 않고 문장 진단만 코드별로 묶는다. errors나 warnings에는 섞지 않는다 */
export function lintPrdProse(view: PrdView, source: PrdSource): PrdProseGroup[] {
  const groups = new Map<PrdProseCode, PrdProseGroup>();
  const add = (code: PrdProseCode, sample: PrdProseSample, count = 1) => {
    const group = groups.get(code) ?? { code, severity: 'info' as const, count: 0, samples: [] };
    group.count += count;
    if (group.samples.length < PROSE_SAMPLE_LIMIT) group.samples.push(sample);
    groups.set(code, group);
  };
  const modal = (text: string, blockId: string, field: string) => {
    for (const sentence of splitSentences(text))
      if (MODAL.test(sentence)) add('MODAL_AMBIGUOUS', { sentence, blockId, field });
  };
  for (const { block } of allBlocks(view)) {
    if (block.kind === 'requirement') {
      const sentence =
        (block.detail?.[0] ? splitSentences(block.detail[0])[0] : splitSentences(block.title)[1]) ??
        block.title;
      if (!SUBJECT.test(sentence)) add('REQ_NO_SUBJECT', { sentence, blockId: block.id });
      if (!block.boundary) add('REQ_NO_BOUNDARY', { sentence, blockId: block.id });
      block.acceptance?.forEach((a, k) => modal(a.text, block.id, `acceptance.${k}.text`));
      if (block.slots?.data) modal(block.slots.data.text, block.id, 'slots.data.text');
    }
    if (block.kind === 'risk') {
      if (!block.response) add('RISK_NO_RESPONSE', { sentence: block.text, blockId: block.id });
      modal(block.text, block.id, 'text');
      if (block.response) modal(block.response, block.id, 'response');
    }
  }
  const lines = splitLines(source.lines.join('\n'));
  const classes = classifyLines(source.lines);
  for (const line of [...lines.prose, ...lines.table].sort((a, b) => a.number - b.number)) {
    if (classes[line.number - 1] !== 'content') continue;
    for (const sentence of splitSentences(line.text)) {
      if ([...sentence].length > 66) add('SENTENCE_LONG', { sentence, line: line.number });
      for (const hit of detect(sentence))
        add('PROSE_AI_TELL', { sentence, line: line.number, ruleId: hit.ruleId }, hit.count);
    }
  }
  return PRD_PROSE_CODES.flatMap((code) => (groups.has(code) ? [groups.get(code)!] : []));
}
