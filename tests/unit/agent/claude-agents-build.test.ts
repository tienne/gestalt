import { describe, it, expect } from 'vitest';
import { renderAgent, rewritePaths } from '../../../scripts/build-claude-agents.js';

const FILES = new Set([
  'plugin/role-agents/_shared/references/ai-tell-quick-rules.md',
  'plugin/role-agents/slack-messenger/references/voice-sample.md',
  'plugin/role-agents/presentation-designer/templates',
  'plugin/skills/_shared/untrusted-input.md',
]);
const exists = (p: string) => FILES.has(p);

describe('rewritePaths', () => {
  it('에이전트 디렉토리 기준 상대 경로를 플러그인 루트 기준으로 바꾼다', () => {
    const { body } = rewritePaths(
      '룰북은 `../_shared/references/ai-tell-quick-rules.md`이고 [샘플](./references/voice-sample.md)도 본다.',
      'plugin/role-agents/slack-messenger',
      exists,
    );

    expect(body).toBe(
      '룰북은 `${CLAUDE_PLUGIN_ROOT}/plugin/role-agents/_shared/references/ai-tell-quick-rules.md`이고 [샘플](${CLAUDE_PLUGIN_ROOT}/plugin/role-agents/slack-messenger/references/voice-sample.md)도 본다.',
    );
  });

  it('리뷰 에이전트에서 두 단계 위로 올라가는 경로도 푼다', () => {
    const { body } = rewritePaths(
      '규칙은 `../../skills/_shared/untrusted-input.md`에 있다.',
      'plugin/review-agents/harness-reviewer',
      exists,
    );

    expect(body).toBe(
      '규칙은 `${CLAUDE_PLUGIN_ROOT}/plugin/skills/_shared/untrusted-input.md`에 있다.',
    );
  });

  it('plugin/ 기준으로 적힌 role-agents 경로도 푼다', () => {
    const { body } = rewritePaths(
      '템플릿이 `role-agents/presentation-designer/templates/`에 있다.',
      'plugin/role-agents/presentation-designer',
      exists,
    );

    expect(body).toBe(
      '템플릿이 `${CLAUDE_PLUGIN_ROOT}/plugin/role-agents/presentation-designer/templates/`에 있다.',
    );
  });

  it('문장 끝 마침표는 경로에 넣지 않는다', () => {
    const { body } = rewritePaths(
      '먼저 ../_shared/references/ai-tell-quick-rules.md.',
      'plugin/role-agents/slack-messenger',
      exists,
    );

    expect(body).toBe(
      '먼저 ${CLAUDE_PLUGIN_ROOT}/plugin/role-agents/_shared/references/ai-tell-quick-rules.md.',
    );
  });

  it('없는 파일과 점만 있는 산문, 다른 레포 예시는 그대로 둔다', () => {
    const src = [
      '`../../` 개수를 그대로 둔 자리',
      '`references/missing.md`',
      'acme의 `skills/setup/SKILL.md:18`',
      '`.claude/skills/<skill-name>/references/`',
    ].join('\n');

    const { body, rewrites } = rewritePaths(src, 'plugin/role-agents/harness-architect', exists);

    expect(body).toBe(src);
    expect(rewrites).toEqual([]);
  });

  it('이미 바꾼 본문을 다시 돌려도 그대로다', () => {
    const once = rewritePaths(
      '`../_shared/references/ai-tell-quick-rules.md`',
      'plugin/role-agents/jira-writer',
      exists,
    ).body;

    expect(rewritePaths(once, 'plugin/role-agents/jira-writer', exists).body).toBe(once);
  });
});

const agentMd = (name: string, tier: string) =>
  `---\nname: ${name}\ntier: ${tier}\npipeline: review\ndescription: "설명: 따옴표 \\"포함\\""\n---\n\n본문\n`;

describe('renderAgent', () => {
  it('리뷰어는 셸까지 열고 tier를 기본 모델로 옮긴다', () => {
    const { content } = renderAgent(
      'plugin/review-agents/x-reviewer/AGENT.md',
      agentMd('x-reviewer', 'frontier'),
      exists,
    );

    expect(content).toContain('name: x-reviewer\n');
    expect(content).toContain('description: "설명: 따옴표 \\"포함\\""\n');
    expect(content).toContain('tools: Read, Grep, Glob, Bash\n');
    expect(content).toContain('model: opus\n');
    expect(content).not.toContain('omitClaudeMd');
    expect(content).toContain('원본은 plugin/review-agents/x-reviewer/AGENT.md');
  });

  it('글만 다루는 에이전트는 셸을 빼고 CLAUDE.md 없이 띄운다', () => {
    const { content } = renderAgent(
      'plugin/role-agents/slack-messenger/AGENT.md',
      agentMd('slack-messenger', 'standard'),
      exists,
    );

    expect(content).toContain('tools: Read, Grep, Glob\n');
    expect(content).toContain('model: sonnet\n');
    expect(content).toContain('omitClaudeMd: true\n');
  });
});
