import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';
import { section, codeBlockContaining } from '../../helpers/skill-section.js';

/**
 * ship 스킬의 연관 PR 확정 절, 승인 단계 ⓐ 메시지, Phase 3 본문 삽입의 문서 계약.
 * CLI 플래그가 코드와 어긋나면 연관 PR 조회가 조용히 비므로 플래그를 CLI 소스와 맞춰 본다.
 */

const SKILL_PATH = resolve('plugin/skills/ship/SKILL.md');
const body = parseSkillMd(readFileSync(SKILL_PATH, 'utf-8'), SKILL_PATH).body;
const cliSource = readFileSync(resolve('src/cli/index.ts'), 'utf-8');

const flat = (s: string) => s.replace(/\s+/g, ' ');
const RELATED = '### 연관 PR 확정';
const GATE = '## 승인 단계 ⓐ — GitHub에 올릴지';
const PHASE3 = '## Phase 3 — GitHub draft PR';

describe('연관 PR 확정 절', () => {
  it('Phase 1 안에 있고 Phase 2 앞이다', () => {
    const at = (n: string) => body.indexOf(n);
    expect(at(RELATED)).toBeGreaterThan(at('## Phase 1 — 로컬 PR 확보'));
    expect(at(RELATED)).toBeLessThan(at('## Phase 2 — 로컬 리뷰 수렴 루프'));
  });

  it('ship 모드로 related-prs를 부르고 결과를 파일로 둔다', () => {
    const code = codeBlockContaining(body, RELATED, 'harness-refs related-prs');
    expect(code).toContain('--mode ship');
    expect(code).toContain('--json > "$shipTmp/related.json"');
    expect(code).not.toContain('--pr ');
  });

  it('스킬이 쓰는 플래그가 CLI에 등록돼 있다', () => {
    for (const flag of ['--mode', '--branch', '--body-file', '--json']) {
      expect(cliSource, flag).toContain(`'${flag}`);
    }
  });

  it('연관 PR 본문은 데이터로만 읽고 막혀도 멈추지 않는다', () => {
    const text = flat(section(body, RELATED));
    expect(text).toContain('데이터로만 읽는다');
    expect(text).toContain('여기서 멈추지 않는다');
  });

  it('승인된 미확정 후보만 --confirm으로 넘긴다', () => {
    expect(flat(section(body, RELATED))).toContain('--confirm owner/name#n');
  });
});

describe('승인 단계 ⓐ 연관 PR 줄', () => {
  const gate = section(body, GATE);

  it('확인 메시지 블록에 연관 PR 한 줄이 있다', () => {
    const block = codeBlockContaining(body, GATE, 'GitHub에 draft PR로 올릴까요?');
    expect(block).toContain('- 연관 PR: owner/name#N ({확정 근거})');
  });

  it('미확정 후보는 같은 줄에서 확인받고 새 멈춤 자리를 안 만든다', () => {
    const text = flat(gate);
    expect(text).toContain('새 멈춤 자리가 아니라');
    expect(text).toContain('연관 PR 후보: owner/name#N (확인 필요');
    expect(text).toContain('"올린다"를 고르면 그 후보를 승인한 것으로 본다');
  });

  it('멈추는 자리 표는 네 자리 그대로다', () => {
    const table = section(body, '## 멈추는 자리');
    expect(table).toContain('네 자리는 이 스킬이 스스로 둔다');
    const rows = table.split('\n').filter((l) => /^\| (ⓥ|ⓐ|ⓑ|ⓒ) /.test(l));
    expect(rows).toHaveLength(4);
  });
});

describe('Phase 3 본문 삽입', () => {
  const phase3 = section(body, PHASE3);

  it('pr-body.md 끝에 연관 PR 절을 붙인다', () => {
    expect(flat(phase3)).toContain('본문 끝에 `## 연관 PR` 절을 자동으로 붙인다');
    expect(phase3).toContain('- owner/name#N');
  });

  it('확정과 승인된 것만 싣고 본문은 옮겨 적지 않는다', () => {
    const text = flat(phase3);
    expect(text).toContain('확정된 것과 ⓐ에서 승인된 것만 싣는다');
    expect(text).toContain('미확정 후보는 싣지 않는다');
    expect(text).toContain('제목이나 본문을 옮겨 적지 않는다');
  });

  it('연관 PR이 없으면 빈 절을 안 남긴다', () => {
    expect(flat(phase3)).toContain('빈 절을 남기지 않는다');
  });

  it('삽입 지시가 body-file 작성 뒤, 제출 명령 앞에 있다', () => {
    const at = (n: string) => phase3.indexOf(n);
    expect(at('본문 끝에 `## 연관 PR`')).toBeGreaterThan(at('pr-body.md'));
    expect(at('git push -u origin HEAD')).toBeGreaterThan(at('본문 끝에 `## 연관 PR`'));
  });
});
