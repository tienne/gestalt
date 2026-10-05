import type { VocabularyPack } from './types.js';

/**
 * 하네스와 MCP 레포. AI 클라이언트가 스킬을 읽고 스킬이 에이전트를 띄운 뒤 MCP 도구를 부른다.
 * 스킬은 화면 열, 에이전트는 게이트웨이 열에 선다. 웹과 하네스가 한 그림에 같이 서는 일은 드물어 같은 열을 나눠 쓴다.
 * 클라이언트는 서비스보다 왼쪽이라 열 순위가 음수다
 */
export const HARNESS_PACK = {
  id: 'harness',
  title: '하네스와 MCP',
  description: 'AI 클라이언트, 스킬, 에이전트, MCP 도구',
  requires: ['web-product'],
  drilldown: 'web-product',
  matchers: ['mcp-tool'],
  nodeKinds: {
    client: {
      renderClass: 'client',
      // HTTP 호출 클라이언트(external_service)와 칩이 겹치지 않게 AI를 붙인다
      short: 'AI 클라이언트',
      text: 'AI 클라이언트',
      about: 'Claude Code나 Codex처럼 스킬을 읽고 MCP 도구를 부르는 AI 앱이에요.',
      color: { light: '#a16207', dark: '#facc15' },
      icon: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 10l3 2.5L7 15M12.5 15h4.5"/>',
      lane: 'client',
      rank: -1,
    },
    skill: {
      renderClass: 'document',
      short: '스킬',
      text: '스킬',
      about: 'AI가 상황에 맞춰 읽고 따르는 작업 지시문이에요.',
      color: { light: '#c026d3', dark: '#e879f9' },
      icon: '<path d="M6 3.5h9.5l3 3v14H6z"/><path d="M15.5 3.5v3h3M9 11h6M9 14.5h6M9 18h3.5"/>',
      lane: 'skill',
      rank: 0,
      // 플러그인이 서비스이고 스킬 묶음이 기능 영역이다
      parents: ['feature', 'service'],
    },
    agent: {
      renderClass: 'actor',
      short: '에이전트',
      text: '에이전트',
      about: '스킬이 일을 맡기려고 띄우는 AI예요. 맡은 역할과 지시문이 따로 있어요.',
      color: { light: '#65a30d', dark: '#a3e635' },
      icon: '<rect x="4.5" y="7.5" width="15" height="12" rx="3"/><path d="M12 4v3.5M9 12.5h.01M15 12.5h.01M9.5 16h5"/>',
      lane: 'agent',
      rank: 1,
    },
  },
  displayKinds: {
    // 도구는 API와 같은 자리라 같은 초록 계열에서 한 톤 진하게 간다
    mcp_tool: {
      renderClass: 'service',
      short: 'MCP 도구',
      text: 'MCP 도구',
      about: 'AI가 MCP 서버에 보내는 명령이에요. 도구 하나가 action 여러 개를 받기도 해요.',
      color: { light: '#047857', dark: '#6ee7b7' },
      icon: '<rect x="3.5" y="8" width="17" height="11.5" rx="2"/><path d="M9 8V5.5h6V8M3.5 13h17M11 12v2.5h2V12"/>',
    },
  },
  lanes: {
    client: { title: 'AI 클라이언트', about: '스킬을 읽는 AI 클라이언트가 서는 칸이에요.' },
    skill: { title: '스킬', about: 'AI가 읽는 스킬이 서는 칸이에요.', stacked: true },
    agent: { title: '에이전트', about: '스킬이 띄우는 에이전트가 서는 칸이에요.' },
    tool: { title: 'MCP 도구', about: 'AI가 부르는 MCP 도구가 서는 칸이에요.' },
  },
  edgeKinds: {
    spawns: {
      text: '에이전트 실행',
      about: '스킬이나 에이전트가 다른 에이전트를 띄워 일을 맡기는 연결이에요.',
      ends: { from: ['skill', 'agent'], to: ['agent'] },
    },
    invokes: {
      text: '스킬 호출',
      about: '스킬이 다른 스킬을 부르는 연결이에요.',
      ends: { from: ['skill'], to: ['skill'] },
    },
  },
} as const satisfies VocabularyPack;
