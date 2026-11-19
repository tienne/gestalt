// LLM이 쓴 글자 칸에 위험한 조각이 들어와도 세 종류 HTML(본인용, 공유본, delta)에서 스크립트가 늘지 않는지 본다.
// 브라우저 대신 happy-dom 파서로 읽는다. 기본 설정이 스크립트를 실행하지 않아 파싱만 한다
import { Window } from 'happy-dom';
import { afterAll, describe, expect, it } from 'vitest';
import {
  computeArchitectureDelta,
  deltaScope,
  type DeltaSnapshot,
} from '../../../src/architecture/delta.js';
import { computeDeltaLayout, renderDeltaHtml } from '../../../src/architecture/delta-renderer.js';
import {
  renderArchitectureHtml,
  renderDrilldownHtml,
} from '../../../src/architecture/html-renderer.js';
import { computeDrilldown, shouldDrillDown } from '../../../src/architecture/drilldown.js';
import { computeLayout } from '../../../src/architecture/layout.js';
import { maskSecrets, maskValidatedIr } from '../../../src/architecture/secret-mask.js';
import type {
  ArchitectureIr,
  ArchitectureNode,
  Evidence,
} from '../../../src/architecture/types.js';
import {
  redactForSharing,
  validateArchitectureIr,
  type ValidatedIr,
} from '../../../src/architecture/validator.js';
import { cspCoversInline, executableScripts } from './csp-check.js';
import { FAKE_TOKEN } from './fake-secrets.js';

const HOSTILE: [string, string][] = [
  ['</script>', '</script><script>alert(1)</script>'],
  ['<!--', '<!-- <script>alert(1)</script> -->'],
  ['<script', '<script src=//x.test/a.js>'],
  ['on* 속성', '<img src=x onerror=alert(1)>'],
  ['javascript: 링크', '<a href="javascript:alert(1)">x</a>'],
  ['속성 탈출', '"><svg onload=alert(1)>'],
  ['bidi 제어 문자', 'pay‮gnp.js ⁦x⁩'],
  ['줄 구분 문자', 'a b c'],
  ['비밀값 섞임', `</script>${FAKE_TOKEN}<script>`],
];

function ev(excerpt: string): Evidence {
  return { type: 'doc', location: 'https://docs.acme.test/a', visibility: 'public', excerpt };
}

const CODE: Evidence = { type: 'code', location: 'web:src/a.ts:1', visibility: 'public' };

function node(id: string, kind: ArchitectureNode['kind'], h: string): ArchitectureNode {
  return {
    id,
    kind,
    label: `${id} ${h}`,
    displayName: `${id} 이름 ${h}`,
    description: `${id} 설명 ${h}`,
    repo: 'web',
    evidence: [ev(h)],
  };
}

function hostileIr(h: string, extra = false): ArchitectureIr {
  const nodes = [node('home', 'screen', h), node('api', 'endpoint', h)];
  if (extra) nodes.push(node('detail', 'screen', h));
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'web', name: 'acme-web', root: '.' }],
    nodes,
    edges: [
      { id: 'e1', from: 'home', to: 'api', kind: 'calls', evidence: [CODE], lineStyle: 'solid' },
      ...(extra
        ? [
            {
              id: 'e2',
              from: 'home',
              to: 'detail',
              kind: 'calls' as const,
              evidence: [CODE],
              lineStyle: 'solid' as const,
            },
          ]
        : []),
    ],
    flows: [
      {
        id: 'f1',
        title: `흐름 ${h}`,
        actors: [{ id: 'guest', label: `손님 ${h}`, kind: 'person' }],
        steps: [
          { id: 's1', actor: 'guest', label: `단계 ${h}`, evidence: [CODE] },
          { id: 's2', actor: 'guest', label: '끝', terminal: true, evidence: [CODE] },
        ],
        transitions: [
          {
            id: 't1',
            from: 's1',
            to: 's2',
            path: 'main',
            label: `전이 ${h}`,
            evidence: [CODE],
            lineStyle: 'solid',
          },
        ],
      },
    ],
    projections: [
      {
        id: 'p1',
        shape: 'sequence',
        title: `투영 ${h}`,
        question: `질문 ${h}`,
        participants: ['home', 'api'],
        messages: [
          {
            id: 'm1',
            from: 'home',
            to: 'api',
            label: `메시지 ${h}`,
            evidence: [CODE],
            lineStyle: 'solid',
          },
        ],
      },
    ],
    unresolved: [{ id: 'q1', subject: { nodeId: 'api' }, question: `누가 맡나 ${h}` }],
    sourcesUsed: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** 서버 render와 같은 순서로 검증한 뒤 가린다 */
function prepared(ir: ArchitectureIr): ValidatedIr {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return maskValidatedIr(r.value).validated;
}

/** 서버 render처럼 드릴다운 여부에 따라 본인용과 공유본을 그린다 */
async function renderMaps(v: ValidatedIr): Promise<{ private: string; shared: string }> {
  if (shouldDrillDown(v)) {
    const d = await computeDrilldown(v);
    return {
      private: renderDrilldownHtml(v, d, { audience: 'private' }),
      shared: renderDrilldownHtml(v, d, { audience: 'shared' }),
    };
  }
  const layout = await computeLayout(v.ir, v.drawableNodeIds, v.drawableEdgeIds);
  return {
    private: renderArchitectureHtml(v, layout, { audience: 'private' }),
    shared: renderArchitectureHtml(v, layout, { audience: 'shared' }),
  };
}

async function renderPages(h: string): Promise<Record<string, string>> {
  const v = prepared(hostileIr(h));
  const maps = await renderMaps(v);
  const after = prepared(hostileIr(h, true));
  const snap = (x: ValidatedIr, redact: boolean): DeltaSnapshot => ({
    ir: redact ? redactForSharing(x.ir) : x.ir,
    nodeIds: x.drawableNodeIds,
    edgeIds: x.drawableEdgeIds,
  });
  const delta = computeArchitectureDelta(snap(v, false), snap(after, false));
  const scope = deltaScope(delta);
  const sharedDelta = computeArchitectureDelta(snap(v, true), snap(after, true));
  const sharedScope = deltaScope(sharedDelta);
  return {
    ...maps,
    'delta-private': renderDeltaHtml(delta, scope, await computeDeltaLayout(delta, scope), {
      audience: 'private',
    }),
    'delta-shared': renderDeltaHtml(
      sharedDelta,
      sharedScope,
      await computeDeltaLayout(sharedDelta, sharedScope),
      { audience: 'shared' },
    ),
  };
}

const windows: Window[] = [];
afterAll(async () => {
  for (const w of windows) await w.happyDOM.close();
});

function parse(html: string) {
  const w = new Window();
  windows.push(w);
  return new w.DOMParser().parseFromString(html, 'text/html');
}

const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'data']);

/** 스크립트를 실행할 수 있는 자리. on* 속성과 javascript: 주소를 모은다 */
function executionPaths(html: string): string[] {
  const doc = parse(html);
  const found: string[] = [];
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) found.push(`${el.tagName}[${name}]`);
      if (URL_ATTRS.has(name) && /^\s*javascript:/i.test(attr.value)) {
        found.push(`${el.tagName}[${name}=javascript:]`);
      }
    }
  }
  return found;
}

function scriptCount(html: string): number {
  return parse(html).querySelectorAll('script').length;
}

function dataBlock(html: string): {
  nodes: { id: string; label: string; description?: string }[];
} {
  const el = parse(html).querySelector('script#ir');
  if (!el) throw new Error('데이터 블록이 없다');
  return JSON.parse(el.textContent ?? '');
}

describe('위험 입력 왕복', () => {
  const clean = renderPages('평범한 글자');

  it.each(HOSTILE)('%s', async (_name, h) => {
    const pages = await renderPages(h);
    const base = await clean;
    for (const [kind, html] of Object.entries(pages)) {
      expect(scriptCount(html), kind).toBe(scriptCount(base[kind]!));
      expect(executableScripts(html).length, kind).toBe(executableScripts(base[kind]!).length);
      expect(cspCoversInline(html), kind).toBe(true);
      expect(executionPaths(html), kind).toEqual([]);
      expect(html, kind).not.toContain(FAKE_TOKEN);
    }

    const masked = maskSecrets(h).text;
    for (const kind of ['private', 'shared']) {
      const api = dataBlock(pages[kind]!).nodes.find((n) => n.id === 'api')!;
      expect(api.label, kind).toBe(`api ${masked}`);
      expect(api.description, kind).toBe(`api 설명 ${masked}`);
    }
  });
});

describe('검사 도구 자체', () => {
  it('이스케이프 없이 끼운 조각이면 실행 경로와 늘어난 script를 잡는다', () => {
    const raw = `<html><body><p>${HOSTILE[3]![1]}</p><a href=" JavaScript:x">a</a><script>1</script>${HOSTILE[0]![1]}</body></html>`;
    expect(executionPaths(raw)).toEqual(['IMG[onerror]', 'A[href=javascript:]']);
    expect(scriptCount(raw)).toBe(2);
  });

  it('흐름과 투영, 질문 칸도 실제로 그려진다', async () => {
    const html = (await renderPages('표식-XYZ')).private!;
    const text = html.replace(/<script id="ir"[\s\S]*?<\/script>/, '');
    for (const s of ['흐름 표식-XYZ', '투영 표식-XYZ', '누가 맡나 표식-XYZ'])
      expect(text).toContain(s);
  });
});
