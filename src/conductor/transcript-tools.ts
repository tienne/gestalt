/**
 * 트랜스크립트 리더가 알아보는 tool 이름 표.
 *
 * Claude Code가 tool 이름을 바꾸면 여기만 고친다(`Task`가 `Agent`로 바뀐 것처럼).
 * 리더와 생존 판단, 작업 내용 탭이 전부 이 표를 쓴다.
 */

/** 서브에이전트를 띄우는 tool. 옛 이름은 `Task`다 */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);

/** 에이전트 todo를 고치거나 읽는 tool. 성공한 결과만 목록에 반영한다 */
export const TASK_TOOLS: ReadonlySet<string> = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
]);

/** 목록 전체를 한 번에 바꾸는 옛 todo tool */
export const TODO_TOOLS: ReadonlySet<string> = new Set(['TodoWrite']);

/** 파일을 고치는 tool. `activity.file`은 이 tool의 대상 경로만 싣는다 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
]);

/** 명령을 돌리는 tool. 백그라운드 gate 멈춤 감지가 본다 */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash']);

/** 백그라운드로 띄운 서브에이전트의 tool 결과 status. 끝났다는 뜻이 아니다 */
export const LAUNCHED_STATUSES: ReadonlySet<string> = new Set([
  'async_launched',
  'teammate_spawned',
]);
