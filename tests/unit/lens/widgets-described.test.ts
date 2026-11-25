import { describe, expect, it } from 'vitest';
import type { Widget } from '../../../src/digest/lens-widget-schema.js';
import { lintSteps, stepFrames, stepsSchema, type Step } from '../../../src/digest/lens-steps.js';
import type { DigestIssue } from '../../../src/digest/lint.js';
import { numbersIn, sourceNumbersIn } from '../../../src/digest/lint-lens.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown } from '../../../src/digest/render-md.js';
import { parseDigest } from '../../../src/digest/schema.js';
import { lensDigest, lensSource } from './fixture.js';
import { at, deployCodes, deployTranscript, withWidget } from './deploy-fixture.js';

const flow = (): Widget => ({
  id: 'deploy-flow',
  class: 'D',
  kind: 'stepSlider',
  title: '배포 건이 겹칠 때',
  cite: at(0),
  steps: [
    {
      label: 'release/20260721이 나간다',
      note: 'production에 나간다.',
      cite: at(0),
      nodes: [
        { id: 'm', label: 'main' },
        { id: 'r', label: 'release/20260721' },
      ],
      edges: [{ from: 'r', to: 'm', strength: 'strong' }],
    },
    {
      label: 'release/20260728을 다시 rebase',
      note: '0721로 앞으로 나간 main 위에 다시 올린다.',
      cite: at(2),
      nodes: [
        { id: 'm', label: 'main' },
        { id: 'n', label: 'release/20260728' },
      ],
      edges: [{ from: 'n', to: 'm', strength: 'strong' }],
    },
  ],
});

const codes = deployCodes;

describe('이름 속 숫자', () => {
  it('리포트 쪽은 이름 속 숫자를 세지 않고 원문 쪽은 모은다', () => {
    expect(numbersIn('release/20260721 배포')).toEqual([]);
    expect(sourceNumbersIn('release/20260721 배포')).toContain(20260721);
    // 짧은 이름 속 숫자는 모델 이름이라 원문 쪽에서도 안 모은다
    expect(sourceNumbersIn('ResNet-34와 ViT-L/16')).toEqual([]);
    expect(sourceNumbersIn('GPT-4로 실험했다')).not.toContain(4);
  });

  it('줄임 꼴은 원문에 직접 없으면 받지 않는다', () => {
    expect(sourceNumbersIn('release/20260721')).not.toContain(721);
    expect(sourceNumbersIn('release/20260721')).not.toContain(2026);
  });
});

describe('D 원문 서술 그림 lint', () => {
  it('원문 이름과 출처 문단 숫자만 쓴 D 슬라이더는 통과한다', () => {
    expect(parseDigest(lensDigest(withWidget(flow()))).ok).toBe(true);
    expect(codes(flow())).toEqual([]);
  });

  it('원문에 없는 이름을 쓰면 D_NAME_UNKNOWN', () => {
    const w = flow();
    if (w.kind === 'stepSlider') w.steps[0]!.nodes[1]!.label = 'release/20260722';
    expect(codes(w)).toContain('D_NAME_UNKNOWN');
  });

  it('단계 출처 문단에 없는 숫자를 쓰면 D_NUMBER_UNKNOWN', () => {
    const w = flow();
    if (w.kind === 'stepSlider') w.steps[0]!.note = '0723에 production에 나간다.';
    expect(codes(w)).toContain('D_NUMBER_UNKNOWN');
  });

  it('숫자는 다른 단계의 출처 문단으로는 허락되지 않는다', () => {
    const w = flow();
    // 0721은 세 번째 문단에만 있다. 첫 단계의 출처는 첫 문단이다
    if (w.kind === 'stepSlider') w.steps[0]!.note = '0721로 앞으로 나간다.';
    expect(codes(w)).toContain('D_NUMBER_UNKNOWN');
  });

  it('단계에 출처가 없으면 D_STEP_NO_CITE', () => {
    const w = flow();
    if (w.kind === 'stepSlider') delete w.steps[1]!.cite;
    expect(codes(w)).toContain('D_STEP_NO_CITE');
  });

  it('원문 그림을 달면 C로 만들게 한다', () => {
    const w = { ...flow(), figure: 'figure-1' } as Widget;
    expect(codes(w)).toContain('D_FIGURE_REF');
  });

  it('예시 요소는 원문 이름 대조 대신 B 규칙을 받는다', () => {
    const ok = flow();
    if (ok.kind === 'stepSlider')
      ok.steps[1]!.nodes.push({ id: 'x', label: '내 수정 커밋', illustrative: true });
    expect(codes(ok)).toEqual([]);
    const numbered = flow();
    if (numbered.kind === 'stepSlider') {
      numbered.steps[1]!.nodes.push({ id: 'x', label: 'hotfix 3개', illustrative: true });
    }
    const c = codes(numbered);
    expect(c).toContain('B_HAS_NUMBER');
    expect(c).not.toContain('D_NAME_UNKNOWN');
  });

  it('D는 toggleBars나 heatmap을 못 쓴다', () => {
    const w: Widget = {
      id: 'd-bars',
      class: 'D',
      kind: 'toggleBars',
      title: '배포',
      cite: at(0),
      toggle: { off: 'alpha', on: 'production' },
      items: [
        {
          label: 'main',
          off: { value: 1, src: { cite: at(0) } },
          on: { value: 1, src: { cite: at(0) } },
        },
      ],
    };
    expect(codes(w)).toContain('WIDGET_KIND_CLASS');
  });

  it('D beforeAfter 값은 출처 문단과 대조하고 원문 지표 말만 쓴다', () => {
    const w: Widget = {
      id: 'd-pair',
      class: 'D',
      kind: 'beforeAfter',
      title: 'rebase 전과 후',
      cite: at(2),
      before: { title: 'main', items: [{ label: 'release/20260728' }] },
      after: { title: 'main', items: [{ label: 'force push 정확도' }] },
    };
    expect(codes(w)).toContain('WIDGET_METRIC_UNKNOWN');
  });
});

describe('D 그림 렌더', () => {
  it('배지와 단계 출처, 예시 꼬리표를 붙인다', () => {
    const w = flow();
    if (w.kind === 'stepSlider')
      w.steps[1]!.nodes.push({ id: 'x', label: '내 수정 커밋', illustrative: true });
    const html = renderDigestHtml(lensDigest(withWidget(w)), deployTranscript(), {
      source: lensSource(),
    }).html;
    expect(html).toContain('<span class="w-badge w-badge-D">원문 설명을 그림으로 옮김</span>');
    expect(html).toContain('내 수정 커밋 (예시)');
    expect(html).toContain('class="w-ill"');
    const md = renderDigestMarkdown(lensDigest(withWidget(w)), deployTranscript(), {
      source: lensSource(),
    });
    expect(md).toContain('(원문 설명을 그림으로 옮김)');
  });
});

describe('공통 단계 모델', () => {
  const steps = (): Step[] => [
    { label: '처음', show: [], state: [{ key: 'production', value: 'release/20260714' }] },
    {
      label: '다음',
      show: ['b'],
      gone: ['a'],
      focus: ['b'],
      state: [{ key: 'production', value: 'release/20260721' }],
    },
    { label: '끝', focus: ['c'] },
  ];

  it('show에 없는 요소는 처음부터 보이고 gone은 그 단계에 점선, 다음부터 숨는다', () => {
    const frames = stepFrames(['a', 'b', 'c'], steps());
    expect(frames.map((f) => f.looks.get('a'))).toEqual(['shown', 'gone', 'hidden']);
    expect(frames.map((f) => f.looks.get('b'))).toEqual(['hidden', 'focus', 'shown']);
    expect(frames.map((f) => f.looks.get('c'))).toEqual(['shown', 'shown', 'focus']);
  });

  it('상태 칸은 첫 단계 키를 따르고 빈 단계는 앞 값을 이어 쓴다', () => {
    const frames = stepFrames(['a', 'b', 'c'], steps());
    expect(frames.map((f) => f.state[0]?.value)).toEqual([
      'release/20260714',
      'release/20260721',
      'release/20260721',
    ]);
  });

  it('없는 id, 숨긴 요소 되살리기, 첫 단계에 없는 상태 키를 막는다', () => {
    const s = steps();
    s[2]!.show = ['a', 'z'];
    s[2]!.state = [{ key: 'alpha', value: 'release/20260728' }];
    const issues: DigestIssue[] = [];
    lintSteps(s, ['a', 'b', 'c'], 'w.steps', issues);
    expect(issues.map((i) => i.code).sort()).toEqual([
      'STEP_REF_UNKNOWN',
      'STEP_REVIVES_GONE',
      'STEP_STATE_KEY_UNKNOWN',
    ]);
  });

  it('단계는 2~16개다', () => {
    expect(stepsSchema.safeParse([{ label: '하나' }]).success).toBe(false);
    expect(stepsSchema.safeParse(Array.from({ length: 17 }, () => ({ label: '칸' }))).success).toBe(
      false,
    );
    expect(stepsSchema.safeParse(steps()).success).toBe(true);
  });
});
