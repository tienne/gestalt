import { describe, expect, it } from 'vitest';
import type { Widget } from '../../../src/digest/lens-widget-schema.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown } from '../../../src/digest/render-md.js';
import { extractProse } from '../../../src/digest/prose.js';
import { parseDigest } from '../../../src/digest/schema.js';
import { lintDigest, lintErrors } from '../../../src/digest/lint.js';
import { VIEWER_JS } from '../../../src/digest/viewer-js.js';
import { FLOW_WIDGET_CSS } from '../../../src/digest/render-widgets-flow.js';
import { lensDigest, lensSource } from './fixture.js';
import {
  at,
  deployCodes as codes,
  deployTranscript,
  parcel,
  withWidget,
} from './deploy-fixture.js';

const lanes = (): Extract<Widget, { kind: 'laneGraph' }> => ({
  id: 'overlap',
  class: 'D',
  kind: 'laneGraph',
  title: 'release/20260728이 QA하는 동안 main이 앞으로 간다',
  cite: at(0),
  lanes: [
    { id: 'main', label: 'main' },
    { id: 'r21', label: 'release/20260721' },
    { id: 'r28', label: 'release/20260728' },
  ],
  nodes: [
    { id: 'm0', lane: 'main', label: 'main' },
    { id: 'a1', lane: 'r21', label: 'PR', parents: ['m0'] },
    { id: 'b1', lane: 'r28', label: 'PR', parents: ['m0'], cite: at(1) },
    { id: 'm1', lane: 'main', label: 'PR', parents: ['m0'], copyOf: 'a1' },
    { id: 'b2', lane: 'r28', label: 'PR', parents: ['m1'], copyOf: 'b1', cite: at(2) },
  ],
  steps: [
    {
      label: 'release/20260728이 갈라진다',
      cite: at(1),
      show: [],
      state: [{ key: 'production', value: 'main' }],
    },
    {
      label: 'release/20260721이 production에 나간다',
      cite: at(0),
      show: ['m1'],
      gone: ['a1'],
      focus: ['m1'],
      state: [{ key: 'production', value: 'release/20260721' }],
    },
    {
      label: 'release/20260728을 다시 rebase',
      cite: at(2),
      show: ['b2'],
      gone: ['b1'],
      focus: ['b2'],
    },
  ],
});

const week = (): Extract<Widget, { kind: 'calendar' }> => ({
  id: 'week',
  class: 'D',
  kind: 'calendar',
  title: '정기배포 한 주',
  cite: at(3),
  columns: ['전주 수요일', '목요일', '금요일', '월요일', '화요일'],
  tracks: [{ id: 'r28', label: 'release 브랜치' }],
  spans: [
    { id: 'make', track: 'r28', at: 0, label: 'release 브랜치', cite: at(3) },
    { id: 'alpha', track: 'r28', from: 1, to: 2, label: 'alpha QA', cite: at(3) },
    { id: 'beta', track: 'r28', from: 2, to: 3, label: 'beta QA', cite: at(4) },
    { id: 'prod', track: 'r28', at: 4, label: 'production 배포', marker: 'release', cite: at(4) },
  ],
  note: '금요일 또는 다음 주 월요일에 beta QA로 넘어간다.',
});

const journey = (): Extract<Widget, { kind: 'stepper' }> => ({
  id: 'journey',
  class: 'D',
  kind: 'stepper',
  title: 'PR 하나가 나가기까지',
  cite: at(5),
  items: [
    { id: 'squash', label: 'release로 squash 머지', cite: at(5) },
    { id: 'alpha', label: 'alpha QA', cite: at(5) },
    { id: 'check', label: '전수검사', optional: true, cite: at(6) },
    { id: 'prod', label: 'production 배포', cite: at(4) },
  ],
  loops: [{ from: 'alpha', to: 'squash', label: '버그가 나오면 수정 PR로' }],
});

describe('새 위젯 lint', () => {
  it('원문 이름과 출처만 쓴 laneGraph, calendar, stepper, 비유 표는 통과한다', () => {
    for (const w of [lanes(), week(), journey(), parcel()]) {
      expect(parseDigest(lensDigest(withWidget(w))).ok).toBe(true);
      expect(codes(w)).toEqual([]);
    }
  });

  it('laneGraph 부모가 없거나 뒤에 있으면 막는다', () => {
    const missing = lanes();
    missing.nodes[1]!.parents = ['zz'];
    expect(codes(missing)).toContain('LANE_PARENT_UNKNOWN');
    const late = lanes();
    late.nodes[1]!.parents = ['m1'];
    expect(codes(late)).toContain('LANE_PARENT_ORDER');
    const lane = lanes();
    lane.nodes[0]!.lane = 'nope';
    expect(codes(lane)).toContain('LANE_UNKNOWN');
  });

  it('laneGraph 단계가 없는 점을 가리키거나 숨긴 점을 되살리면 막는다', () => {
    const w = lanes();
    w.steps![2]!.show = ['a1', 'ghost'];
    const c = codes(w);
    expect(c).toContain('STEP_REF_UNKNOWN');
    expect(c).toContain('STEP_REVIVES_GONE');
  });

  it('D 공통 단계도 단계마다 출처를 받고 상태 키는 원문 이름이어야 한다', () => {
    const w = lanes();
    delete w.steps![1]!.cite;
    w.steps![0]!.state = [{ key: 'staging', value: 'main' }];
    const c = codes(w);
    expect(c).toContain('D_STEP_NO_CITE');
    expect(c).toContain('D_NAME_UNKNOWN');
  });

  it('calendar 칸 번호가 columns 밖이거나 모양이 틀리면 막는다', () => {
    const out = week();
    out.spans[1]!.to = 9;
    expect(codes(out)).toContain('CALENDAR_SPAN_OUT_OF_RANGE');
    const both = week();
    both.spans[0]!.from = 0;
    both.spans[0]!.to = 1;
    expect(codes(both)).toContain('CALENDAR_SPAN_SHAPE');
    const track = week();
    track.spans[0]!.track = 'zz';
    expect(codes(track)).toContain('CALENDAR_TRACK_UNKNOWN');
  });

  it('calendar 기간의 숫자는 그 기간 출처에 있어야 한다', () => {
    const w = week();
    w.spans[1]!.label = 'alpha QA 3일';
    expect(codes(w)).toContain('D_NUMBER_UNKNOWN');
  });

  it('calendar는 A와 B로 못 쓴다', () => {
    expect(codes({ ...week(), class: 'A' })).toContain('WIDGET_KIND_CLASS');
    expect(codes({ ...week(), class: 'B' })).toContain('WIDGET_KIND_CLASS');
  });

  it('stepper 되돌아가는 화살표의 카드가 없으면 막는다', () => {
    const w = journey();
    w.loops = [{ from: 'alpha', to: 'nowhere' }];
    expect(codes(w)).toContain('STEPPER_LOOP_UNKNOWN');
  });

  it('calendar 칸 id가 겹치면 겹친 칸의 순번을 짚는다', () => {
    const w = week();
    delete w.spans[0]!.id;
    w.spans[3]!.id = w.spans[2]!.id;
    const dup = lintErrors(
      lintDigest(lensDigest(withWidget(w)), deployTranscript(), { source: lensSource() }),
    ).find((i) => i.code === 'WIDGET_ID_DUPLICATE');
    expect(dup?.path).toMatch(/\.spans\.3\.id$/);
  });

  it('비유 표는 안 맞는 지점이 비면 막는다', () => {
    const w = parcel();
    w.breaks = ['  '];
    expect(codes(w)).toContain('ANALOGY_BREAKS_EMPTY');
  });

  it('안 맞는 곳에는 원문 이름은 쓰되 숫자와 지표 말은 막는다', () => {
    const name = parcel();
    name.breaks = ['택배와 달리 release 브랜치는 다시 rebase된다'];
    expect(codes(name)).not.toContain('B_HAS_NUMBER');
    const num = parcel();
    num.breaks = ['택배는 3일이면 오지만 배포는 다르다'];
    expect(codes(num)).toContain('B_HAS_NUMBER');
    const metric = parcel();
    metric.breaks = ['택배처럼 정확도가 오르지는 않는다'];
    expect(codes(metric)).toContain('B_METRIC_LABEL');
  });

  it('비유 칸에 원문 이름이나 숫자, 지표 말을 쓰면 막는다', () => {
    const named = parcel();
    named.rows[0]!.analog = 'main 장부';
    expect(codes(named)).toContain('B_BORROWS_NAME');
    const numbered = parcel();
    numbered.rows[1]!.analog = '상자 3개';
    expect(codes(numbered)).toContain('B_HAS_NUMBER');
    const metric = parcel();
    metric.rows[2]!.analog = '검수 정확도';
    expect(codes(metric)).toContain('B_METRIC_LABEL');
  });

  it('비유 표의 원문 말 칸은 원문 이름이어야 하고 B로만 쓴다', () => {
    const w = parcel();
    w.rows[0]!.term = 'trunk';
    expect(codes(w)).toContain('D_NAME_UNKNOWN');
    expect(codes({ ...parcel(), class: 'D' })).toContain('WIDGET_KIND_CLASS');
  });

  it('중복 id를 막는다', () => {
    const w = journey();
    w.items[1]!.id = 'squash';
    expect(codes(w)).toContain('WIDGET_ID_DUPLICATE');
  });
});

describe('새 위젯 렌더', () => {
  const html = (w: Widget) =>
    renderDigestHtml(lensDigest(withWidget(w)), deployTranscript(), { source: lensSource() }).html;
  const md = (w: Widget) =>
    renderDigestMarkdown(lensDigest(withWidget(w)), deployTranscript(), { source: lensSource() });

  it('단계 수만큼 그림을 미리 그리고 첫 단계만 보인다', () => {
    const out = html(lanes());
    const frames = [...out.matchAll(/<div data-w-state="(\d+)"( hidden)?>/g)];
    expect(frames.map((m) => m[1])).toEqual(['0', '1', '2']);
    expect(frames.map((m) => Boolean(m[2]))).toEqual([false, true, true]);
    expect(out).toContain('<span class="w-pos">단계 1 / 3</span>');
    // 단계 라벨까지 읽히게 늘 있는 알림 자리를 두고 뷰어가 채운다
    expect(out).toContain('<span class="w-live sr-only" aria-live="polite"></span>');
    expect(VIEWER_JS).toContain("querySelector('.ws-step')");
    expect(out).toContain('data-w-step="prev" aria-disabled="true"');
  });

  it('laneGraph는 첫 단계에 나중에 생길 점을 그리지 않고 버려진 점은 흐린 점선으로 남긴다', () => {
    const out = html(lanes());
    const frame = (k: number) =>
      out.slice(out.indexOf(`data-w-state="${k}"`), out.indexOf(`data-w-state="${k + 1}"`));
    expect(frame(0)).not.toContain('<title>PR</title><circle cx="295.0"');
    expect(frame(1)).toContain('w-gone');
    expect(frame(1)).toContain('wl-copy');
    expect(frame(1)).toContain('<dd>release/20260721</dd>');
  });

  it('calendar는 기간을 칸에 걸쳐 놓고 표 칸 수가 단계와 상관없이 같다', () => {
    const out = html(week());
    expect(out).toContain('<td colspan="2"><span class="wc-span">alpha QA');
    expect(out).toContain('wc-release');
    // alpha와 beta가 금요일에 겹쳐 아랫줄로 내려간다
    expect(out).toContain('rowspan="2"');
  });

  it('stepper는 순번을 렌더러가 붙이고 되돌아가는 화살표를 그린다', () => {
    const out = html(journey());
    expect(out).toContain('<span class="wst-n">1</span>');
    expect(out).toContain('class="wst-loop"');
    expect(out).toContain('↩ release로 squash 머지(으)로 돌아가요');
    expect(out).toContain('wst-card wst-opt');
  });

  it('비유 표는 구분과 상관없이 비유 배지를 달고 안 맞는 지점을 펼친다', () => {
    const out = html(parcel());
    expect(out).toContain('<span class="w-badge w-badge-analogy">비유, 원문에 없는 설명</span>');
    expect(out).toContain('<b>비유가 안 맞는 곳</b>');
    expect(out).toContain('택배 출고에 빗대면');
  });

  it('마크다운으로도 낸다', () => {
    expect(md(lanes())).toContain('- release/20260728: PR → PR(PR 복사)');
    expect(md(week())).toContain(
      '| release 브랜치 | release 브랜치 | alpha QA | alpha QA, beta QA | beta QA | production 배포 |',
    );
    expect(md(journey())).toContain('3. 전수검사 (선택)');
    expect(md(parcel())).toContain('비유가 안 맞는 곳:');
  });

  it('마크다운 표 칸의 세로줄과 줄바꿈은 표를 깨지 않는다', () => {
    const w = week();
    w.tracks[0]!.label = 'release | 브랜치';
    w.spans[1]!.label = 'alpha\nQA';
    const out = md(w);
    expect(out).toContain('| release \\| 브랜치 |');
    expect(out).toContain('alpha QA');
    expect(out).not.toContain('alpha\nQA');
  });

  it('윤문은 상태 키를 빼고 값만 받는다', () => {
    const r = withWidget(lanes());
    const paths = extractProse(lensDigest(r)).map((p) => p.path);
    expect(paths.some((p) => p.endsWith('.state.0.value'))).toBe(true);
    expect(paths.some((p) => p.endsWith('.state.0.key'))).toBe(false);
  });

  it('뷰어 스크립트는 이전, 다음 버튼과 좌우 화살표로 단계를 넘긴다', () => {
    expect(VIEWER_JS).toContain("closest('[data-w-step]')");
    expect(VIEWER_JS).toContain("ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight'");
  });

  it('사라진 요소는 흐리게 하지 않고 점선과 취소선으로 보이고 단계 버튼에 포커스 테두리가 있다', () => {
    expect(FLOW_WIDGET_CSS).not.toMatch(/\.w-gone\{opacity/);
    expect(FLOW_WIDGET_CSS).toContain('.wc-span.w-gone{background:none;border:1px dashed var(--muted);text-decoration:line-through}');
    expect(FLOW_WIDGET_CSS).toContain('.wst-card.w-gone b{text-decoration:line-through}');
    expect(FLOW_WIDGET_CSS).toContain('.w-nav button:focus-visible{outline:2px solid var(--accent)');
  });
});
