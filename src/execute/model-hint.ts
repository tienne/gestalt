import type { AtomicTask, TaskModel } from '../core/types.js';

// ─── Model Hint Assignment ──────────────────────────────────────
//
// Passthrough 모드에서 Claude Code가 Agent tool로 sub-agent를 spawn할 때
// 사용할 model 힌트를 task 복잡도·의도에 따라 자동 할당한다.
//
//   복잡한 설계·분석 태스크  → "opus"
//   일반 구현 태스크         → "sonnet"
//   단순 rename·포맷 태스크   → "haiku"

/** 복잡한 설계·분석 의도를 나타내는 키워드 (opus 후보) */
const COMPLEX_KEYWORDS = [
  'design',
  'architect',
  'architecture',
  'analyze',
  'analysis',
  'investigate',
  'research',
  'refactor',
  'migrate',
  'migration',
  'security',
  'algorithm',
  'optimize',
  'optimization',
  'strategy',
  '설계',
  '분석',
  '아키텍처',
  '조사',
  '리팩터',
  '리팩토링',
  '마이그레이션',
  '보안',
  '알고리즘',
  '최적화',
];

/** 단순 기계적 작업을 나타내는 키워드 (haiku 후보) */
const TRIVIAL_KEYWORDS = [
  'rename',
  'format',
  'formatting',
  'lint',
  'typo',
  'comment',
  'rename file',
  'move file',
  'copy',
  'cleanup',
  'whitespace',
  '이름 변경',
  '리네임',
  '포맷',
  '포매팅',
  '오타',
  '주석',
  '정리',
];

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => text.includes(kw));
}

/**
 * 단일 task에 대한 model 힌트를 결정한다.
 * complexity와 title/description 키워드를 함께 고려한다.
 */
export function resolveTaskModel(task: AtomicTask): TaskModel {
  const text = `${task.title} ${task.description}`.toLowerCase();

  // 1) trivial 키워드 + low complexity → haiku
  if (matchesAny(text, TRIVIAL_KEYWORDS) && task.estimatedComplexity === 'low') {
    return 'haiku';
  }

  // 2) complex 키워드 또는 high complexity → opus
  if (matchesAny(text, COMPLEX_KEYWORDS) || task.estimatedComplexity === 'high') {
    return 'opus';
  }

  // 3) low complexity (키워드 없음) → haiku
  if (task.estimatedComplexity === 'low') {
    return 'haiku';
  }

  // 4) 일반 구현 (medium) → sonnet
  return 'sonnet';
}

/**
 * task 배열에 model 힌트를 채워 새 배열로 반환한다.
 * 이미 model이 지정된 task는 호출자 의도를 존중해 그대로 둔다.
 */
export function assignModelHints(tasks: AtomicTask[]): AtomicTask[] {
  return tasks.map((task) => (task.model ? task : { ...task, model: resolveTaskModel(task) }));
}
