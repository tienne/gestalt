import { describe, expect, it } from 'vitest';
import type { Widget } from '../../../src/digest/lens-widget-schema.js';
import { extractProse } from '../../../src/digest/prose.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown } from '../../../src/digest/render-md.js';
import { GRAPH_WIDGET_CSS, wrapLabel } from '../../../src/digest/render-widgets-graph.js';
import { parseDigest } from '../../../src/digest/schema.js';
import { lensDigest, lensSource } from './fixture.js';
import { at, deployCodes as codes, deployTranscript, withWidget } from './deploy-fixture.js';

const prState = (): Extract<Widget, { kind: 'stateMachine' }> => ({
  id: 'pr-state',
  class: 'D',
  kind: 'stateMachine',
  title: 'PR이 production까지 거치는 상태',
  cite: at(5),
  states: [
    { id: 'pr', label: 'PR 리뷰', initial: true, cite: at(5) },
    { id: 'rel', label: 'release 브랜치에 들어감', cite: at(5) },
    { id: 'alpha', label: 'alpha QA', cite: at(3) },
    { id: 'prod', label: 'production', final: true, cite: at(4) },
  ],
  transitions: [
    { id: 't1', from: 'pr', to: 'rel', label: 'squash 머지', cite: at(5) },
    { id: 't2', from: 'rel', to: 'alpha' },
    { id: 't3', from: 'alpha', to: 'pr', label: '버그', cite: at(5) },
    { id: 't4', from: 'alpha', to: 'prod', label: 'production 배포', cite: at(4) },
  ],
  steps: [
    { label: 'PR이 release 브랜치에 들어간다', cite: at(5), focus: ['pr', 't1'] },
    { label: 'alpha QA에서 버그가 나오면 돌아간다', cite: at(5), focus: ['t3'] },
  ],
});

const rebase = (): Extract<Widget, { kind: 'sequence' }> => ({
  id: 'rebase',
  class: 'D',
  kind: 'sequence',
  title: 'main이 앞으로 가면 release/20260728이 하는 일',
  cite: at(2),
  actors: [
    { id: 'main', label: 'main' },
    { id: 'r28', label: 'release/20260728' },
    { id: 'alpha', label: 'alpha' },
  ],
  messages: [
    { id: 'm1', from: 'main', to: 'r28', label: 'rebase', cite: at(2) },
    { id: 'm2', from: 'r28', to: 'r28', label: 'force push', cite: at(2) },
    { id: 'm3', from: 'r28', to: 'alpha', label: '다시 올라간다', cite: at(1), reply: true },
  ],
});

const roles = (): Extract<Widget, { kind: 'swimlane' }> => ({
  id: 'roles',
  class: 'D',
  kind: 'swimlane',
  title: '배포 한 주에 단계별로 하는 일',
  cite: at(3),
  lanes: [
    { id: 'rel', label: 'release 브랜치' },
    { id: 'qa', label: 'QA' },
    { id: 'prod', label: 'production' },
  ],
  activities: [
    { id: 'a1', lane: 'rel', col: 0, label: 'squash 머지', cite: at(5) },
    { id: 'a2', lane: 'qa', col: 1, label: 'alpha QA', cite: at(3) },
    { id: 'a3', lane: 'qa', col: 2, label: 'beta QA', cite: at(4) },
    { id: 'a4', lane: 'prod', col: 3, label: 'production 배포', cite: at(4) },
  ],
  arrows: [
    { from: 'a1', to: 'a2' },
    { from: 'a2', to: 'a1', label: '버그' },
    { from: 'a2', to: 'a3' },
    { from: 'a3', to: 'a4' },
  ],
});

describe('상태 전이, 순서도, 역할별 줄 lint', () => {
  it('원문 이름과 출처만 쓴 세 그림은 통과한다', () => {
    for (const w of [prState(), rebase(), roles()]) {
      expect(parseDigest(lensDigest(withWidget(w))).ok).toBe(true);
      expect(codes(w)).toEqual([]);
    }
  });

  it('B와 C, D로만 쓴다', () => {
    for (const w of [prState(), rebase(), roles()]) {
      expect(codes({ ...w, class: 'A' } as Widget)).toContain('WIDGET_KIND_CLASS');
    }
  });

  it('stateMachine 전이가 없는 상태를 가리키면 막는다', () => {
    const w = prState();
    w.transitions[1]!.to = 'zz';
    expect(codes(w)).toContain('STATE_TRANSITION_UNKNOWN');
  });

  it('stateMachine 시작 상태가 둘이거나 자리 힌트가 겹치면 막는다', () => {
    const many = prState();
    many.states[1]!.initial = true;
    expect(codes(many)).toContain('STATE_INITIAL_MANY');
    const overlap = prState();
    overlap.states[0]!.pos = { row: 0, col: 0 };
    overlap.states[2]!.pos = { row: 0, col: 0 };
    expect(codes(overlap)).toContain('STATE_POS_OVERLAP');
  });

  it('상태와 전이는 id를 같이 쓴다', () => {
    const w = prState();
    w.transitions[0]!.id = 'pr';
    expect(codes(w)).toContain('WIDGET_ID_DUPLICATE');
  });

  it('D 단계와 이름, 숫자 규칙을 그대로 받는다', () => {
    const noCite = prState();
    delete noCite.steps![1]!.cite;
    expect(codes(noCite)).toContain('D_STEP_NO_CITE');
    const name = prState();
    name.states[2]!.label = 'staging QA';
    expect(codes(name)).toContain('D_NAME_UNKNOWN');
    const num = prState();
    num.transitions[2]!.label = '버그 3건';
    expect(codes(num)).toContain('D_NUMBER_UNKNOWN');
  });

  it('예시 요소는 B 규칙을 받는다', () => {
    const w = prState();
    w.states.push({ id: 'retry', label: '재시도 2번', illustrative: true });
    expect(codes(w)).toContain('B_HAS_NUMBER');
  });

  it('sequence 메시지의 참여자가 없으면 막는다', () => {
    const w = rebase();
    w.messages[0]!.from = 'ghost';
    expect(codes(w)).toContain('SEQUENCE_ACTOR_UNKNOWN');
  });

  it('sequence는 단계를 안 적어도 D 단계 출처를 따로 요구하지 않는다', () => {
    const w = rebase();
    delete w.messages[1]!.cite;
    expect(codes(w)).toEqual([]);
  });

  it('sequence 단계도 요소 id를 대조한다', () => {
    const w = rebase();
    w.steps = [
      { label: 'rebase', cite: at(2), focus: ['m1'] },
      { label: 'force push', cite: at(2), show: ['m9'] },
    ];
    expect(codes(w)).toContain('STEP_REF_UNKNOWN');
  });

  it('swimlane 줄이나 화살표 끝이 없거나 같은 칸에 두 활동을 놓으면 막는다', () => {
    const lane = roles();
    lane.activities[0]!.lane = 'nope';
    expect(codes(lane)).toContain('SWIMLANE_LANE_UNKNOWN');
    const arrow = roles();
    arrow.arrows![0]!.to = 'a9';
    expect(codes(arrow)).toContain('SWIMLANE_ARROW_UNKNOWN');
    const cell = roles();
    cell.activities[2]!.col = 1;
    expect(codes(cell)).toContain('SWIMLANE_CELL_TAKEN');
  });
});

describe('상태 전이, 순서도, 역할별 줄 렌더', () => {
  const html = (w: Widget) =>
    renderDigestHtml(lensDigest(withWidget(w)), deployTranscript(), { source: lensSource() }).html;
  const md = (w: Widget) =>
    renderDigestMarkdown(lensDigest(withWidget(w)), deployTranscript(), { source: lensSource() });
  const frame = (out: string, k: number) => {
    const start = out.indexOf(`data-w-state="${k}"`);
    const next = out.indexOf(`data-w-state="${k + 1}"`);
    return out.slice(start, next === -1 ? undefined : next);
  };

  it('stateMachine은 시작 표시와 끝 테두리를 그리고 되돌아가는 전이를 휘어 그린다', () => {
    const out = html(prState());
    expect(out).toContain('role="img" aria-label="PR이 production까지 거치는 상태"');
    expect(out).toContain('class="wg-start"');
    expect(out).toContain('class="wg-final"');
    expect(out).toContain('<span class="w-pos">단계 1 / 2</span>');
    expect(frame(out, 0)).toContain('wg-edge w-focus');
    // alpha QA → PR 리뷰는 위층으로 거슬러 올라가 곡선이다
    expect(out).toMatch(/<g class="wg-edge w-focus"><path d="M[\d.,]+ Q/);
  });

  it('그림이 보여 주는 상태와 전이를 화면 낭독기용 글로 같이 둔다', () => {
    const out = html(prState());
    expect(out).toContain('<ul class="sr-only">');
    expect(out).toContain('<li>alpha QA → PR 리뷰: 버그</li>');
  });

  it('sequence는 단계가 없으면 메시지 하나를 한 단계로 보이고 순번을 붙인다', () => {
    const out = html(rebase());
    expect(out).toContain('<span class="w-pos">단계 1 / 3</span>');
    expect(frame(out, 0)).toContain('<b>rebase</b>');
    expect(frame(out, 0)).toContain('wg-msg wg-reply w-hide');
    expect(frame(out, 2)).toContain('wg-msg wg-reply w-focus');
    expect(out).toContain('>1. rebase</tspan></text>');
  });

  it('긴 화살표 라벨과 메시지 라벨은 두 줄로 접고 넘치면 줄임표로 끝낸다', () => {
    const long = '버그가 나오면 수정 PR을 다시 squash 머지하고 alpha QA를 처음부터 다시 돌린다';
    const state = prState();
    state.transitions[2]!.label = long;
    const edge =
      html(state).match(
        /<text class="wg-elabel"[^>]*>((?:<tspan[^>]*>[^<]*<\/tspan>)+)<\/text>/g,
      ) ?? [];
    const wrapped = edge.find((t) => t.includes('…'));
    expect(wrapped?.match(/<tspan/g)).toHaveLength(2);
    const seq = rebase();
    seq.messages[0]!.label = long;
    const msg = html(seq);
    expect(msg).toMatch(
      /<text class="wg-elabel"[^>]*><tspan[^>]*>1\. [^<]*<\/tspan><tspan[^>]*>[^<]*…<\/tspan><\/text>/,
    );
  });

  it('일부 상태에만 자리 힌트를 줘도 자동 배치가 끝나고 칸이 안 겹친다', () => {
    const w: Extract<Widget, { kind: 'stateMachine' }> = {
      id: 'mixed',
      class: 'D',
      kind: 'stateMachine',
      title: '자리 힌트가 섞인 상태',
      cite: at(5),
      states: [
        { id: 'a', label: 'PR 리뷰', initial: true, pos: { row: 1, col: 0 }, cite: at(5) },
        { id: 'b', label: 'alpha QA', cite: at(3) },
        { id: 'c', label: 'production', cite: at(4) },
      ],
      transitions: [
        { id: 't1', from: 'a', to: 'b', cite: at(5) },
        { id: 't2', from: 'a', to: 'c', cite: at(4) },
      ],
    };
    const out = html(w);
    const boxes = new Set(
      [...out.matchAll(/<g class="wg-node[^"]*">.*?<rect x="([-\d.]+)" y="([-\d.]+)"/g)].map(
        (m) => `${m[1]},${m[2]}`,
      ),
    );
    expect(boxes.size).toBe(3);
  }, 2000);

  it('swimlane은 줄마다 띠를 깔고 앞 칸으로 돌아가는 화살표를 따로 칠한다', () => {
    const out = html(roles());
    expect(out.match(/class="wsw-lane /g)).toHaveLength(3);
    expect(out).toContain('wg-edge wg-back');
    expect(out).not.toContain('<div class="w-nav"');
  });

  it('예시 요소에는 렌더러가 예시 꼬리표를 붙인다', () => {
    const w = prState();
    w.states.push({ id: 'hold', label: '보류', illustrative: true });
    expect(html(w)).toContain('<tspan x="');
    expect(html(w)).toContain('보류 (예시)');
  });

  it('마크다운으로도 낸다', () => {
    const state = md(prState());
    expect(state).toContain(
      '상태: PR 리뷰(시작), release 브랜치에 들어감, alpha QA, production(끝)',
    );
    expect(state).toContain('- alpha QA → PR 리뷰: 버그');
    const seq = md(rebase());
    expect(seq).toContain('1. main → release/20260728: rebase');
    expect(seq).toContain('3. release/20260728 → alpha: 다시 올라간다 (응답)');
    const lanes = md(roles());
    expect(lanes).toContain('- QA: alpha QA → beta QA');
    expect(lanes).toContain('- alpha QA → squash 머지: 버그');
  });

  it('라벨에 줄바꿈과 마크다운 문법 글자가 있어도 마크다운 줄이 늘지 않는다', () => {
    const plain = md(prState()).split('\n').length;
    const w = prState();
    w.states[2]!.label = '# 배포\n- 끼어든 줄';
    w.transitions[2]!.label = '[x](y)';
    const out = md(w);
    expect(out.split('\n').length).toBe(plain);
    expect(out).toContain('\\# 배포 - 끼어든 줄');
    expect(out).toContain('- \\# 배포 - 끼어든 줄 → PR 리뷰: \\[x\\](y)');
  });

  it('낭독 줄은 이스케이프 전 라벨로 적고 단계 라벨은 다시 넣지 않는다', () => {
    const w = prState();
    w.transitions[2]!.label = 'a | b [x]';
    const sr = html(w).match(/<ul class="sr-only">(.*?)<\/ul>/)![1]!;
    expect(sr).toContain('<li>alpha QA → PR 리뷰: a | b [x]</li>');
    expect(sr).not.toContain('\\');
    expect(sr).not.toContain('PR이 release 브랜치에 들어간다');
  });

  it('사라진 상자와 메시지는 예시 점선과 다른 간격으로 긋고 글자에 취소선을 긋는다', () => {
    expect(GRAPH_WIDGET_CSS).toContain(
      '.wg-edge.w-gone path,.wg-msg.w-gone line,.wg-msg.w-gone path{stroke-dasharray:1 4}',
    );
    expect(GRAPH_WIDGET_CSS).toContain(
      '.wg-node.w-gone rect,.wg-actor.w-gone rect{stroke-dasharray:1 4}',
    );
    expect(GRAPH_WIDGET_CSS).toContain(
      '.wg-svg .w-gone text{fill:var(--muted);text-decoration:line-through}',
    );
    // 답장 점선보다 뒤에 둬야 사라진 답장이 보통 답장과 갈린다
    expect(GRAPH_WIDGET_CSS.indexOf('.wg-msg.w-gone path')).toBeGreaterThan(
      GRAPH_WIDGET_CSS.indexOf('.wg-reply path'),
    );
    expect(GRAPH_WIDGET_CSS.indexOf('.w-gone text')).toBeGreaterThan(
      GRAPH_WIDGET_CSS.indexOf('.wg-elabel{'),
    );
  });

  it('윤문은 상태와 메시지, 활동 글자를 받는다', () => {
    const paths = [prState(), rebase(), roles()].flatMap((w) =>
      extractProse(lensDigest(withWidget(w))).map((p) => p.path),
    );
    expect(paths.some((p) => p.endsWith('.states.0.label'))).toBe(true);
    expect(paths.some((p) => p.endsWith('.messages.2.label'))).toBe(true);
    expect(paths.some((p) => p.endsWith('.activities.3.label'))).toBe(true);
  });

  it('상자 글자는 글자 폭으로 재서 띄어쓰기에서 먼저 끊고 세 줄을 넘으면 줄임표로 끝낸다', () => {
    expect(wrapLabel('release 브랜치에 들어감')).toEqual(['release 브랜치에', '들어감']);
    // 영숫자는 한글 폭의 0.6으로 쳐서 release/20260728은 한 줄에 들어간다
    expect(wrapLabel('release/20260728')).toEqual(['release/20260728']);
    expect(wrapLabel('abcdefghijklmnopqrst')).toEqual(['abcdefghijklmnop', 'qrst']);
    const long = wrapLabel(
      '하나 둘 셋 넷 다섯 여섯 일곱 여덟 아홉 열 열하나 열둘 열셋 열넷 열다섯',
    );
    expect(long).toHaveLength(3);
    expect(long[2]!.endsWith('…')).toBe(true);
  });
});
