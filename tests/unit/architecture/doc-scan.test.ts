import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeDrilldown } from '../../../src/architecture/drilldown.js';
import {
  parseEvidenceMarker,
  resolveDocLink,
  scanMarkdown,
} from '../../../src/architecture/doc-scan.js';
import { parseArchitectureIr } from '../../../src/architecture/ir-schema.js';
import { validateArchitectureIr } from '../../../src/architecture/validator.js';
import { handleArchitecturePassthrough } from '../../../src/mcp/tools/architecture-passthrough.js';

// 가짜 지식 레포 acme-kb와 디자인 레포 acme-design. 표시 형식만 실제 문서 레포를 흉내 낸다

// 룰 참조 검사기가 테스트 안의 md 링크도 실제 파일로 확인하므로 링크 글자를 떼어 둔다
const REFUND_LINK = './refund.md#limit';

const STATUS_MD = `---
title: 주문 상태
sources:
  - acme-api:src/orders/status.ts@main
---
# 무시되는 제목

> 최종 수정: 2026-02-01

## 상태 값

상태는 넷이다 [evidence: acme-api:src/orders/status.ts@main] [evidence: confluence:1234@2026-01-02]
코드 호스트 링크도 센다 https://github.com/acme/acme-web/blob/3f2a9c1/src/pages/order.tsx#L12

## 바뀌는 조건

[GAP: 취소 사유 코드 목록, 담당: kim] 아직 못 찾았다.
[UNVERIFIED: 부분 환불 한도]

\`\`\`
[evidence: acme-api:src/ignored.ts@main] 코드 블록 안은 세지 않는다
\`\`\`

자세한 건 [환불](${REFUND_LINK}) 참고.
`;

const INDEX_MD = `# 주문 안내

| 질문 키워드 | 참조 문서 |
|---|---|
| 주문 상태, 상태 값 | [status](references/status.md) |
| 환불 | \`references/refund.md\` |
| 정산 | [settle](references/settle.md) |
| 설명만 있는 줄 | 없음 |
`;

const SCREENS_MD = `# 상점 화면

| 타입 | 화면 | URL 또는 진입 조건 | Figma 프레임 | node_id | component_key | DESIGN.md | 동의어 |
|---|---|---|---|---|---|---|---|
| 화면 | 장바구니 | /cart | Cart / Default | 12:34 | abc123 | [보기](cart/DESIGN.md) | 카트, 바구니 |
| 바텀시트 | 결제 | /pay/:id | Pay | 12:35 | - | ❌ | - |
`;

describe('parseEvidenceMarker', () => {
  it('코드 호스트 근거는 조직을 빼고 레포와 경로, ref 고정 여부를 남긴다', () => {
    expect(parseEvidenceMarker('github-ext:acme/acme-api/src/a.ts@main', 3)).toEqual({
      group: 'code',
      ref: { repo: 'acme-api', path: 'src/a.ts', ref: 'main', pinned: 'branch', line: 3 },
    });
    expect(parseEvidenceMarker('acme-web:src/b.tsx@3f2a9c1', 1).ref?.pinned).toBe('commit');
    expect(parseEvidenceMarker('acme-web:src/b.tsx', 1).ref?.pinned).toBe('none');
  });

  it('종류 없이 레포/경로:줄로 쓴 근거도 코드로 읽고 자리표시는 버린다', () => {
    expect(parseEvidenceMarker('acme-dags/dags/a.py:78-95', 2).ref).toEqual({
      repo: 'acme-dags',
      path: 'dags/a.py',
      ref: undefined,
      pinned: 'none',
      line: 2,
    });
    expect(parseEvidenceMarker('acme-api/docs/adr.md#1.-결정', 1).ref?.path).toBe('docs/adr.md');
    expect(parseEvidenceMarker('<repo>/<path>', 1)).toEqual({ group: 'other', ref: null });
  });

  it('코드가 아닌 종류는 막대 묶음으로만 접는다', () => {
    expect(parseEvidenceMarker('jira:ACME-1', 1)).toEqual({ group: 'ticket', ref: null });
    expect(parseEvidenceMarker('Slack:general', 1)).toEqual({ group: 'chat', ref: null });
    expect(parseEvidenceMarker('meeting:주간 회의', 1)).toEqual({ group: 'other', ref: null });
  });
});

describe('resolveDocLink', () => {
  it('상대 링크를 레포 기준으로 펴고 레포 밖과 바깥 주소는 버린다', () => {
    expect(resolveDocLink('a/b/INDEX.md', './c.md#x')).toBe('a/b/c.md');
    expect(resolveDocLink('a/b/INDEX.md', '../d.md')).toBe('a/d.md');
    expect(resolveDocLink('a/INDEX.md', '../../e.md')).toBeUndefined();
    expect(resolveDocLink('a/INDEX.md', 'https://acme.test/x.md')).toBeUndefined();
  });
});

describe('scanMarkdown', () => {
  it('제목과 수정일, 절, 근거 구성, 구멍, md 링크를 뽑고 코드 블록은 건너뛴다', () => {
    const d = scanMarkdown('kb', 'domains/orders/references/status.md', STATUS_MD);
    expect(d.title).toBe('주문 상태');
    expect(d.updatedAt).toBe('2026-02-01');
    expect(d.sections).toEqual(['상태 값', '바뀌는 조건']);
    expect(d.evidenceMix).toEqual({ code: 3, wiki: 1 });
    expect(d.codeRefs.map((r) => `${r.repo}:${r.path}:${r.pinned}`)).toEqual([
      'acme-api:src/orders/status.ts:branch',
      'acme-api:src/orders/status.ts:branch',
      'acme-web:src/pages/order.tsx:commit',
    ]);
    expect(d.gaps).toEqual([
      { kind: 'gap', text: '취소 사유 코드 목록, 담당: kim', owner: 'kim', line: 17 },
      { kind: 'unverified', text: '부분 환불 한도', line: 18 },
    ]);
    expect(d.mdLinks).toEqual(['domains/orders/references/refund.md']);
  });

  it('구멍 담당은 담당 표기나 글자로 시작하는 @핸들만 받고 날짜 앞 @는 무시한다', () => {
    const d = scanMarkdown(
      'kb',
      'a.md',
      '# A\n\n[GAP: 진술 @2026-08-11 기준]\n[GAP: 정산 주기 @lee 확인]\n',
    );
    expect(d.gaps.map((g) => g.owner)).toEqual([undefined, 'lee']);
  });

  it('질문 안내 표의 키워드와 대상 문서를 줄마다 뽑는다', () => {
    const d = scanMarkdown('kb', 'domains/orders/INDEX.md', INDEX_MD);
    expect(d.routes).toEqual([
      {
        keywords: ['주문 상태', '상태 값'],
        targetPath: 'domains/orders/references/status.md',
        link: 'references/status.md',
      },
      {
        keywords: ['환불'],
        targetPath: 'domains/orders/references/refund.md',
        link: 'references/refund.md',
      },
      {
        keywords: ['정산'],
        targetPath: 'domains/orders/references/settle.md',
        link: 'references/settle.md',
      },
    ]);
  });

  it('화면 색인 표의 라우트와 프레임, 심볼화, 설계 문서 유무를 읽는다', () => {
    const d = scanMarkdown('design', 'products/store/screens.md', SCREENS_MD);
    expect(d.screens).toEqual([
      {
        name: '장바구니',
        line: 5,
        route: '/cart',
        screenType: '화면',
        frame: 'Cart / Default',
        frameNode: '12:34',
        symbolized: true,
        hasSpec: true,
        synonyms: ['카트', '바구니'],
      },
      {
        name: '결제',
        line: 6,
        route: '/pay/:id',
        screenType: '바텀시트',
        frame: 'Pay',
        frameNode: '12:35',
        symbolized: false,
        hasSpec: false,
      },
    ]);
  });

  it('설명 없는 [GAP]은 그 줄 나머지를 설명으로 삼고 프레임이나 타입 열 없는 표는 화면 색인으로 안 본다', () => {
    const d = scanMarkdown(
      'design',
      'a/DESIGN.md',
      '- **[GAP]** 알림 규약의 현행성.\n\n| 영역 | 화면 | URL |\n|---|---|---|\n| 홈 | 메인 | /main |\n',
    );
    expect(d.gaps).toEqual([{ kind: 'gap', text: '알림 규약의 현행성.', line: 1 }]);
    expect(d.screens).toEqual([]);
  });

  it('본문과 코드 블록의 METHOD /path를 한 번씩만 뽑는다', () => {
    const d = scanMarkdown(
      'kb',
      'a.md',
      '조회는 `GET /api/orders/{id}`로 한다.\n\n```\nGET /api/orders/{id}\nPOST /api/orders\n```\n',
    );
    expect(d.apiRefs).toEqual([
      { method: 'GET', path: '/api/orders/{id}', line: 1 },
      { method: 'POST', path: '/api/orders', line: 5 },
    ]);
  });

  it('패턴을 바꾸면 다른 표시 형식도 읽는다', () => {
    const d = scanMarkdown('kb', 'a.md', 'TODO(src): acme-api:src/x.ts\n', {
      evidence: String.raw`TODO\(src\):\s*(\S+)`,
    });
    expect(d.codeRefs).toHaveLength(1);
  });
});

describe('ges_architecture scan_docs', () => {
  let tmpRoot: string;
  const put = (rel: string, text: string): void => {
    const p = join(tmpRoot, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };

  beforeEach(() => {
    tmpRoot = resolve('.gestalt-test', `doc-scan-${randomUUID()}`);
    put('acme-kb/README.md', '# 지식 저장소\n');
    put('acme-kb/domains/orders/INDEX.md', INDEX_MD);
    put('acme-kb/domains/orders/references/status.md', STATUS_MD);
    put('acme-kb/domains/orders/references/refund.md', '# 환불\n');
    put('acme-kb/node_modules/x/README.md', '# 건너뛴다\n');
    // 심링크 폴더로 같은 파일이 한 번 더 보여도 숨김 폴더 밖 경로 하나만 남는다
    symlinkSync('domains', join(tmpRoot, 'acme-kb/.mirror'), 'dir');
    put('acme-design/products/store/screens.md', SCREENS_MD);
    mkdirSync(join(tmpRoot, 'work'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('docRoots가 없으면 거부한다', async () => {
    const r = (await handleArchitecturePassthrough(
      { action: 'scan_docs' },
      join(tmpRoot, 'work'),
    )) as { errors: { code: string }[] };
    expect(r.errors[0]!.code).toBe('MISSING_INPUT');
  });

  it('요약과 경로만 돌려주고 초안 IR은 검증을 통과하며 레포마다 tree 맨 위 카드가 된다', async () => {
    const r = (await handleArchitecturePassthrough(
      {
        action: 'scan_docs',
        docRoots: [
          { repoId: 'kb', name: 'acme-kb', path: '../acme-kb' },
          { repoId: 'design', name: 'acme-design', path: '../acme-design' },
        ],
      },
      join(tmpRoot, 'work'),
    )) as { summary: Record<string, unknown>; draftPath: string; scanPath: string };
    expect(r.summary).toMatchObject({
      docCount: 5,
      withUpdatedAt: 1,
      gapCount: 1,
      unverifiedCount: 1,
      codeRefCount: 3,
      routeCount: 3,
      unresolvedRouteCount: 1,
      screenCount: 2,
    });
    expect(JSON.stringify(r)).not.toContain('취소 사유');

    const parsed = parseArchitectureIr(JSON.parse(readFileSync(r.draftPath, 'utf8')));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const ir = parsed.value;
    const validated = validateArchitectureIr(ir, { checkFiles: false });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(ir.edges.map((e) => `${e.from} -> ${e.to}`)).toEqual([
      'doc:kb/domains/orders/INDEX.md -> doc:kb/domains/orders/references/refund.md',
      'doc:kb/domains/orders/INDEX.md -> doc:kb/domains/orders/references/status.md',
    ]);
    const cart = ir.nodes.find((n) => n.kind === 'design_screen' && n.displayName === '장바구니');
    expect(cart?.doc?.screen?.route).toBe('/cart');
    const status = ir.nodes.find((n) => n.id === 'doc:kb/domains/orders/references/status.md');
    expect(status?.doc?.links).toEqual({
      total: 3,
      broken: 0,
      branchOnly: 2,
      pinned: 1,
      unchecked: 3,
    });
    const d = await computeDrilldown(validated.value);
    expect(d.levels[0]!.nodeIds).toEqual(['dir:design/.', 'dir:kb/.']);
  });
});
