import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  ROOT,
  SPAWN_REF_ONE,
  buildAgents,
  renderAgent,
  rewritePaths,
  spawnedNames,
} from '../../../scripts/build-claude-agents.js';

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
      'plugin/review-agents/security-reviewer/AGENT.md',
      agentMd('security-reviewer', 'frontier'),
      exists,
    );

    expect(content).toContain('name: security-reviewer\n');
    expect(content).toContain('description: "보안 리뷰"\n');
    expect(content).toContain('tools: Read, Grep, Glob, Bash\n');
    expect(content).toContain('model: opus\n');
    expect(content).not.toContain('omitClaudeMd');
    expect(content).toContain('원본은 plugin/review-agents/security-reviewer/AGENT.md');
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

  it('표에 없는 역할 에이전트는 셸 없이 읽기 도구만 받는다', () => {
    const { content } = renderAgent(
      'plugin/role-agents/code-review-writer/AGENT.md',
      agentMd('code-review-writer', 'standard'),
      exists,
    );

    expect(content).toContain('tools: Read, Grep, Glob\n');
  });

  it('한 줄 설명이 없는 에이전트는 뽑지 않고 멈춘다', () => {
    expect(() =>
      renderAgent('plugin/role-agents/x/AGENT.md', agentMd('x', 'standard'), exists),
    ).toThrow('SHORT_DESCRIPTIONS');
  });
});

describe('buildAgents', () => {
  it('스킬이 띄우는 에이전트와 리뷰어만 뽑는다', () => {
    const names = buildAgents().map((a) => a.name);

    for (const spawned of spawnedNames()) expect(names).toContain(spawned);
    expect(names).toContain('quality-reviewer');
    expect(names).not.toContain('designer');
    expect(names).not.toContain('product-planner');
  });
});

const toolsOf = (content: string) => /^tools: (.+)$/m.exec(content)![1]!.split(', ');

describe('생성된 에이전트의 도구', () => {
  const agents = new Map(buildAgents().map((a) => [a.name, toolsOf(a.content)]));
  const reviewers = readdirSync(join(ROOT, 'plugin/review-agents'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name);

  it('리뷰어는 정확히 읽기 도구와 Bash만 받는다', () => {
    for (const name of reviewers)
      expect(agents.get(name)).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
  });

  it('글만 다루는 에이전트는 읽기 도구만 받는다', () => {
    for (const name of ['slack-messenger', 'jira-writer', 'explainer', 'humanize-monolith']) {
      expect(agents.get(name)).toEqual(['Read', 'Grep', 'Glob']);
    }
  });

  it('Write는 파일을 직접 쓰는 presentation-designer와 video-summarizer, lens-reader만 받는다', () => {
    const writers = [...agents].filter(([, tools]) => tools.includes('Write')).map(([n]) => n);
    expect(writers.sort()).toEqual(['lens-reader', 'presentation-designer', 'video-summarizer']);
  });

  it('MCP 도구는 ges_agent로 윤문 지침을 받는 에이전트에만 열린다', () => {
    const withMcp = [...agents]
      .filter(([, tools]) => tools.some((t) => t.startsWith('mcp__')))
      .map(([n]) => n)
      .sort();
    expect(withMcp).toEqual(['change-context-writer', 'impact-writer', 'presentation-writer']);
  });

  it('WebFetch는 어느 에이전트에도 열리지 않는다', () => {
    for (const tools of agents.values()) expect(tools).not.toContain('WebFetch');
  });
});

describe('스킬의 gestalt: 호출부', () => {
  it('model을 같은 줄이나 다음 줄에 넘긴다', () => {
    const missing: string[] = [];
    for (const entry of readdirSync(join(ROOT, 'plugin/skills'), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const file = join(entry.parentPath, entry.name);
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (!SPAWN_REF_ONE.test(line)) return;
        if (line.includes('model:') || lines[i + 1]?.trim().startsWith('model:')) return;
        missing.push(`${file}:${i + 1}`);
      });
    }
    expect(missing).toEqual([]);
  });
});

describe('buildAgents 오류', () => {
  const fixture = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'claude-agents-'));
    mkdirSync(join(root, 'plugin/skills'), { recursive: true });
    mkdirSync(join(root, 'plugin/review-agents'), { recursive: true });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };
  const spawn = (name: string) => `subagent_type: "gestalt:${name}",\n`;
  const run = (files: Record<string, string>) => () => {
    const root = fixture(files);
    try {
      buildAgents(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('원본이 없으면 멈춘다', () => {
    expect(run({ 'plugin/skills/a.md': spawn('ghost') })).toThrow('원본 AGENT.md가 없다');
  });

  it('같은 이름의 원본이 두 곳에 있으면 멈춘다', () => {
    expect(
      run({
        'plugin/skills/a.md': spawn('explainer'),
        'plugin/role-agents/explainer/AGENT.md': agentMd('explainer', 'standard'),
        'plugin/agents/explainer/AGENT.md': agentMd('explainer', 'standard'),
      }),
    ).toThrow('원본이 여러 곳에 있다');
  });

  it('뽑은 에이전트들의 frontmatter name이 겹치면 멈춘다', () => {
    expect(
      run({
        'plugin/skills/a.md': spawn('explainer'),
        'plugin/role-agents/explainer/AGENT.md': agentMd('security-reviewer', 'standard'),
        'plugin/review-agents/security-reviewer/AGENT.md': agentMd('security-reviewer', 'standard'),
      }),
    ).toThrow('에이전트 이름이 겹친다');
  });

  it('표에 남은 미사용 항목이 있으면 멈춘다', () => {
    expect(
      run({
        'plugin/skills/a.md': spawn('explainer'),
        'plugin/role-agents/explainer/AGENT.md': agentMd('explainer', 'standard'),
      }),
    ).toThrow('뽑지 않는 에이전트가 표에 남아 있다');
  });
});
