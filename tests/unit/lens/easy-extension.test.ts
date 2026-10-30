import { describe, expect, it } from 'vitest';
import type { Extension } from '../../../src/digest/blocks.js';
import { lintDigest, lintErrors } from '../../../src/digest/lint.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown, renderExtensionMarkdown } from '../../../src/digest/render-md.js';
import { pairIndex } from '../../../src/digest/reports.js';
import type { Report } from '../../../src/digest/schema.js';
import { lensDigest, lensReport, lensSource, lensTranscript } from './fixture.js';

// 렌즈 스킬이 보통 리포트를 풀어 쓴 쉬운 리포트. 뼈대와 출처, 렌즈 칸의 숫자는 그대로 두고 글만 바꾼다
function easyReport(): Report {
  const r = lensReport();
  r.options = { ...r.options, difficulty: 'easy' };
  r.lead.answer =
    '재료끼리 얼마나 잘 어울리는지를 그래프로 그리고 diffusion 모델로 다시 맞춰 봐요.';
  r.sections[0]!.subsections[0]!.bullets[0]!.text =
    '**FlavorDiffusion**이라는 새 방법을 내놓는다. 재료 사이 연결을 다시 그려 보는 방법이다.';
  return r;
}

const timestampsExt = (): Extension => ({
  template: 'timestamps',
  title: '목차',
  lang: 'ko',
  blocks: [
    {
      type: 'timestamps',
      items: [
        { title: '제안', cite: { key: 1, from: 0, to: 2 } },
        { title: '결과', summary: '표 4를 본다.', cite: { key: 3, from: 3, to: 8 } },
      ],
    },
  ],
});

const quizExt = (): Extension => ({
  template: 'quiz',
  title: '퀴즈',
  lang: 'ko',
  blocks: [
    {
      type: 'quiz',
      questions: [
        {
          question: '논문이 제안한 모델 이름은?',
          choices: ['FlavorDiffusion', 'FlavorGraph', 'DIFUSCO'],
          answer: 0,
          explanation: '첫 문단에서 FlavorDiffusion을 제안한다고 쓴다.',
          cite: { key: 1, from: 1, to: 1 },
        },
      ],
    },
  ],
});

const templates = new Map([
  ['timestamps', { id: 'timestamps', blocks: ['timestamps'] }],
  ['quiz', { id: 'quiz', blocks: ['quiz'] }],
]);

describe('읽기 렌즈 쉬운 리포트', () => {
  it('보통 리포트와 쉬운 리포트를 함께 두어도 lint 오류가 없고 쉽게 보기 짝이 맞는다', () => {
    const d = lensDigest();
    d.reports.push(easyReport());
    const issues = lintDigest(d, lensTranscript(), { source: lensSource() });
    expect(lintErrors(issues)).toEqual([]);
    expect(pairIndex(d.reports, 0)).toBe(1);
    expect(pairIndex(d.reports, 1)).toBe(0);
  });

  it('쉬운 리포트도 의심 표시 숫자를 바꾸면 보통 리포트처럼 막힌다', () => {
    const d = lensDigest();
    const easy = easyReport();
    easy.sections[1]!.subsections[0]!.bullets[0]!.doubt!.note =
      '노드 50개에서는 0.32에서 0.29로 떨어진다.';
    d.reports.push(easy);
    const errs = lintErrors(lintDigest(d, lensTranscript(), { source: lensSource() }));
    expect(errs.map((i) => i.code)).toContain('DOUBT_NUMBER_UNKNOWN');
    expect(errs.every((i) => i.path.startsWith('reports.1.'))).toBe(true);
  });
});

describe('읽기 렌즈 확장 리포트', () => {
  it('문단 단위 원문에서도 확장 lint를 통과한다', () => {
    for (const kind of ['pdf', 'web'] as const) {
      const d = lensDigest();
      d.extensions = [timestampsExt(), quizExt()];
      const issues = lintDigest(d, lensTranscript(kind), { source: lensSource(), templates });
      expect(issues.filter((i) => i.path.startsWith('extensions.'))).toEqual([]);
    }
  });

  it('뷰어는 확장 탭을 그리고 목차 항목에 시각 대신 문단 칩을 단다', () => {
    const d = lensDigest();
    d.extensions = [timestampsExt()];
    const html = renderDigestHtml(d, lensTranscript('web'), { source: lensSource() }).html;
    expect(html).toContain('<ol class="ext-toc">');
    expect(html).toContain('<button type="button" class="loc" data-unit="1">¶2</button>');
    expect(html).not.toContain('class="ts"');
  });

  it('마크다운 목차도 시각 대신 쪽이나 문단 번호를 적는다', () => {
    const pdf = renderExtensionMarkdown(timestampsExt(), lensTranscript('pdf'));
    expect(pdf).toContain('- p.1 **제안**');
    expect(pdf).toContain('- p.2 **결과**');
    expect(pdf).not.toContain('0:00');
    const web = renderExtensionMarkdown(timestampsExt(), lensTranscript('web'));
    expect(web).toContain('- ¶2 **제안**');
  });

  it('리포트 마크다운의 대섹션 도식 노드도 시각 대신 쪽 번호를 단다', () => {
    const r = lensReport();
    r.sections[0]!.diagram = {
      kind: 'flow',
      steps: [
        { label: '그래프 만들기', cite: { key: 1, from: 1, to: 1 } },
        { label: '간선 복원', cite: { key: 3, from: 3, to: 3 } },
      ],
    };
    const md = renderDigestMarkdown(lensDigest(r), lensTranscript(), { source: lensSource() });
    expect(md).toContain('1. 그래프 만들기 p.1');
    expect(md).toContain('2. 간선 복원 p.2');
  });
});
