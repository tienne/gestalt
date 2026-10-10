import { describe, it, expect } from 'vitest';
import { agentBlocksWithoutModel } from '../../../scripts/verify-rule-refs.js';

const FENCE = '`'.repeat(3);

const md = (...lines: string[]) => lines.join('\n');

describe('agentBlocksWithoutModel', () => {
  it('model 줄이 있는 블록은 통과한다', () => {
    const src = md(
      FENCE,
      'Agent {',
      '  subagent_type: "Explore",',
      '  model: "<tierModels.frugal>",',
      '  prompt: "읽기만 한다"',
      '}',
      FENCE,
    );

    expect(agentBlocksWithoutModel(src)).toEqual([]);
  });

  it('model 줄이 없는 블록은 시작 줄 번호를 돌려준다', () => {
    const src = md(
      '# 제목',
      '',
      FENCE,
      'Agent {',
      '  subagent_type: "Explore",',
      '  prompt: "읽기만 한다"',
      '}',
      FENCE,
    );

    expect(agentBlocksWithoutModel(src)).toEqual([4]);
  });

  it('코드펜스 밖의 Agent 블록은 보지 않는다', () => {
    const src = md('Agent {', '  prompt: "본문 예시"', '}');

    expect(agentBlocksWithoutModel(src)).toEqual([]);
  });

  it('줄 중간에 Agent가 붙은 블록은 Agent 블록이 아니다', () => {
    const src = md(
      FENCE + 'mermaid',
      'stateDiagram-v2',
      'state RoleAgent {',
      '  A --> B',
      '}',
      FENCE,
    );

    expect(agentBlocksWithoutModel(src)).toEqual([]);
  });

  it('들여쓴 블록도 같은 들여쓰기의 닫는 중괄호까지 본다', () => {
    const src = md(
      '1. 단계',
      '',
      `   ${FENCE}`,
      '   Agent {',
      '     subagent_type: "Explore",',
      '     prompt: "읽기만 한다"',
      '   }',
      `   ${FENCE}`,
    );

    expect(agentBlocksWithoutModel(src)).toEqual([4]);
  });

  it('프롬프트 안의 한 줄 중괄호에서 블록이 끝나지 않는다', () => {
    const src = md(
      FENCE,
      'Agent {',
      '  subagent_type: "Explore",',
      '  prompt: "',
      '    아래 JSON만 돌려준다.',
      '    { files: [{ path, kind }] }',
      '  ",',
      '  model: "<tierModels.frugal>"',
      '}',
      FENCE,
    );

    expect(agentBlocksWithoutModel(src)).toEqual([]);
  });

  it('닫는 중괄호 뒤의 model 줄은 블록 것으로 치지 않는다', () => {
    const src = md(
      FENCE,
      'Agent {',
      '  prompt: "읽기만 한다"',
      '}',
      'model: "<tierModels.frugal>"',
      FENCE,
    );

    expect(agentBlocksWithoutModel(src)).toEqual([2]);
  });

  it('한 문서의 여러 블록을 따로 판정한다', () => {
    const src = md(
      FENCE,
      'Agent {',
      '  model: "<tierModels.standard>",',
      '}',
      FENCE,
      '',
      FENCE,
      'Agent {',
      '  prompt: "읽기만 한다"',
      '}',
      FENCE,
    );

    expect(agentBlocksWithoutModel(src)).toEqual([8]);
  });
});
