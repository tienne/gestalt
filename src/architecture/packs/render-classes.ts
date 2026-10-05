import type { KindLook, RenderClass } from './types.js';

/**
 * 렌더 분류마다 기본 모양. 범용 component가 이 모양을 그대로 받는다.
 * 새 팩 kind는 classLook으로 여기 색과 아이콘을 빌리고 칩 글자만 바꿔 쓴다
 */
export const RENDER_CLASS_LOOKS: Readonly<Record<RenderClass, KindLook>> = {
  actor: {
    renderClass: 'actor',
    short: '사람',
    text: '사람이나 역할',
    color: { light: '#b45309', dark: '#fbbf24' },
    icon: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  },
  client: {
    renderClass: 'client',
    short: '클라이언트',
    text: '사람이 쓰는 앱이나 도구',
    color: { light: '#4f46e5', dark: '#818cf8' },
    icon: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18"/>',
  },
  service: {
    renderClass: 'service',
    short: '서비스',
    text: '요청을 받아 처리하는 서비스',
    color: { light: '#2563eb', dark: '#60a5fa' },
    icon: '<path d="M12 3.5l8.5 4.3L12 12 3.5 7.8z"/><path d="M3.5 12.2L12 16.5l8.5-4.3"/><path d="M3.5 16.4L12 20.7l8.5-4.3"/>',
  },
  gateway: {
    renderClass: 'gateway',
    short: '관문',
    text: '요청이 먼저 지나는 관문',
    color: { light: '#475569', dark: '#94a3b8' },
    icon: '<path d="M12 3l7.5 3v5.5c0 4.4-3.1 8-7.5 9.5-4.4-1.5-7.5-5.1-7.5-9.5V6z"/>',
  },
  store: {
    renderClass: 'store',
    short: '저장소',
    text: '데이터를 담아두는 곳',
    color: { light: '#dc2626', dark: '#f87171' },
    icon: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  },
  queue: {
    renderClass: 'queue',
    short: '큐',
    text: '메시지를 쌓아두고 넘기는 곳',
    color: { light: '#0f766e', dark: '#5eead4' },
    icon: '<rect x="3" y="7" width="4" height="10" rx="1"/><rect x="10" y="7" width="4" height="10" rx="1"/><rect x="17" y="7" width="4" height="10" rx="1"/>',
  },
  external: {
    renderClass: 'external',
    short: '외부',
    text: '우리가 운영하지 않는 바깥 시스템',
    color: { light: '#57534e', dark: '#a8a29e' },
    icon: '<path d="M7 18.5a4.5 4.5 0 0 1-.7-8.95A6 6 0 0 1 17.8 8.6a4.95 4.95 0 0 1-.8 9.9z"/>',
  },
  infra: {
    renderClass: 'infra',
    short: '인프라',
    text: '서비스가 올라가는 기반',
    color: { light: '#9333ea', dark: '#c084fc' },
    icon: '<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M8 7h.01M8 17h.01"/>',
  },
  step: {
    renderClass: 'step',
    short: '단계',
    text: '일이 진행되는 한 단계',
    color: { light: '#0891b2', dark: '#22d3ee' },
    icon: '<rect x="3.5" y="6" width="17" height="12" rx="3"/><path d="M9 12h6M13 9.5l2.5 2.5-2.5 2.5"/>',
  },
  state: {
    renderClass: 'state',
    short: '상태',
    text: '무언가가 머무는 상태',
    color: { light: '#65a30d', dark: '#a3e635' },
    icon: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  },
  document: {
    renderClass: 'document',
    short: '문서',
    text: '문서나 기록',
    color: { light: '#c026d3', dark: '#e879f9' },
    icon: '<path d="M6 3.5h9l3.5 3.5v13.5H6z"/><path d="M15 3.5V7h3.5M9 12h6M9 15.5h6"/>',
  },
};

/** 분류의 색과 아이콘을 빌리고 칩 글자와 설명만 팩 것으로 바꾼다 */
export function classLook(renderClass: RenderClass, short: string, text: string): KindLook {
  return { ...RENDER_CLASS_LOOKS[renderClass], short, text };
}

/** component 노드의 표시 종류 키. CSS 클래스와 아이콘 id에 그대로 들어간다 */
export function componentDisplayKind(renderClass: RenderClass): `cx_${RenderClass}` {
  return `cx_${renderClass}`;
}
