// 새 칸(summary, note, 레포 head) 없이 저장된 예전 IR을 디스크에서 읽어 서버 render 액션과 같은 길로 그리고
// 클라이언트 스크립트를 happy-dom에서 돌린다. 드릴다운이면 바깥 맥락, 전체 검색 색인, 개요 패널이 다 켜진 경로다
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import {
  computeDrilldown,
  renderArchitectureHtml,
  renderDrilldownHtml,
  shouldDrillDown,
  validateArchitectureIr,
} from '../../../src/architecture/index.js';
import { computeLayout } from '../../../src/architecture/layout.js';
import { ArchitectureStore } from '../../../src/architecture/store.js';
import { LEGACY_IRS } from '../../fixtures/architecture-legacy/render.js';

const roots: string[] = [];
const windows: Window[] = [];
afterAll(async () => {
  for (const w of windows) await w.happyDOM.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function run(html: string): Promise<{ w: Window; errs: string[] }> {
  const w = new Window({
    url: 'http://localhost/',
    width: 1400,
    height: 900,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  } as never);
  windows.push(w);
  const errs: string[] = [];
  w.addEventListener('error', (e) =>
    errs.push(String((e as unknown as { error?: unknown }).error)),
  );
  w.document.write(html);
  await w.happyDOM.waitUntilComplete();
  return { w, errs };
}

describe('새 칸 이전에 저장된 IR의 화면', () => {
  for (const [name, build] of Object.entries(LEGACY_IRS)) {
    for (const audience of ['private', 'shared'] as const) {
      it(`${name} IR(${audience})이 읽히고 개요 패널과 검색까지 에러 없이 돈다`, async () => {
        const ir = build();
        expect(ir.summary).toBeUndefined();
        expect(ir.note).toBeUndefined();
        expect(ir.nodes.every((n) => n.summary === undefined)).toBe(true);
        expect(ir.repos.every((r) => r.head === undefined)).toBe(true);

        const root = resolve('.gestalt-test', `legacy-client-${randomUUID()}`);
        roots.push(root);
        mkdirSync(join(root, '.gestalt', 'architecture'), { recursive: true });
        writeFileSync(
          join(root, '.gestalt', 'architecture', `${ir.view}.json`),
          JSON.stringify(ir, null, 2),
        );
        const loaded = new ArchitectureStore(root).load(ir.view);
        expect(loaded).not.toBeNull();

        const v = validateArchitectureIr(loaded!, { checkFiles: false });
        if (!v.ok) throw new Error(JSON.stringify(v.errors));
        // deploy처럼 드릴다운 대상이 아닌 그림은 서버도 평면으로 그린다
        const drill = shouldDrillDown(v.value);
        const html = drill
          ? renderDrilldownHtml(v.value, await computeDrilldown(v.value), { audience })
          : renderArchitectureHtml(
              v.value,
              await computeLayout(v.value.ir, v.value.drawableNodeIds, v.value.drawableEdgeIds),
              { audience },
            );
        const { w, errs } = await run(html);
        const d = w.document;
        expect(errs).toEqual([]);

        // 개요 패널은 요약 줄 없이 숫자만 채운다
        const body = d.getElementById('overview-body')!;
        expect(body.querySelector('.ov-sum')).toBeNull();
        expect(body.querySelector('.ov-note')).toBeNull();
        expect(Array.from(body.querySelectorAll('.ov-h')).map((x) => x.textContent)).toContain(
          '살펴볼 것',
        );

        const search = d.getElementById('search') as unknown as HTMLInputElement;
        const type = (q: string) => {
          search.focus();
          search.value = q;
          search.dispatchEvent(new w.Event('input'));
        };
        const data = JSON.parse(d.getElementById('ir')!.textContent!) as {
          nodes: { id: string; label: string }[];
          nodeLevels?: Record<string, string[]>;
        };
        const labelOf = (id: string) => data.nodes.find((n) => n.id === id)!.label;
        if (drill) {
          // 색인에 오른 첫 카드의 이름 앞 글자로 찾으면 목록이 뜬다. 공유본이면 가린 이름으로 찾는다
          const firstId = Object.keys(data.nodeLevels ?? {})[0];
          expect(firstId).toBeDefined();
          type(labelOf(firstId!).slice(0, 2));
          const list = d.getElementById('search-list')!;
          expect(list.hidden).toBe(false);
          expect(list.querySelectorAll('li[role="option"]').length).toBeGreaterThan(0);
        } else {
          // 평면 그림은 목록 없이 캔버스의 카드만 강조한다
          expect(d.getElementById('search-list')).toBeNull();
          const card = d.querySelector('.node[data-node-id]')!;
          type(labelOf(card.getAttribute('data-node-id')!).slice(0, 2));
          expect(d.querySelectorAll('.node.hit').length).toBeGreaterThan(0);
        }
        expect(errs).toEqual([]);
      });
    }
  }
});
