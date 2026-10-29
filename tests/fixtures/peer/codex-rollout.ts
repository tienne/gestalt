import { FAKE_HOME, FAKE_SECRETS } from './transcript.js';

/**
 * peer 테스트용 Codex rollout. codex-cli 0.147.0의 `codex exec` 기록에서 줄 종류와 키 구조만
 * 가져오고 내용은 전부 바꿨다. 실제 기록에는 시스템 프롬프트와 AGENTS.md 원문, 계정 정보가 들어
 * 있어서 복사하지 않는다.
 *
 * 나가면 안 되는 본문에는 `LEAK_` 표식을 심는다. 테스트는 출력 어디에도 `LEAK_`가 없는지 본다.
 *
 * 기록에서 본 건 session_meta, world_state, turn_context, message, custom_tool_call(과 그 결과),
 * event_msg의 user_message, agent_message, task_started, task_complete, token_count,
 * thread_settings_applied다. 아래 줄은 기록에 없어서 바이너리에 있는 이름으로 만들어 넣었고 필드는
 * 추정이다. reasoning 계열(`reasoning`, `agent_reasoning`, `agent_reasoning_raw_content`)은
 * 허용 목록 밖이라 안 나가야 한다. `function_call`, `function_call_output`, `local_shell_call`은
 * 허용 목록 안이라 가리기를 타야 한다.
 */

const at = (n: number): string => `2026-10-30T00:53:${String(n).padStart(2, '0')}.000Z`;
const line = (n: number, type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: at(n), type, payload });

const turn = '01a1885d-870e-7d52-8feb-4f1c0b507fff';
const cwd = `${FAKE_HOME}/work/probe`;

export const CODEX_PROMPT = `파일 ${FAKE_HOME}/work/probe/note.txt 읽어 줘. 토큰은 ${FAKE_SECRETS.ghp}`;

export function codexLines(): string[] {
  return [
    line(0, 'session_meta', {
      session_id: '01a1885d-8687-7033-a0b2-e3a17555a249',
      id: '01a1885d-8687-7033-a0b2-e3a17555a249',
      timestamp: at(0),
      cwd,
      originator: 'codex_exec',
      cli_version: '0.147.0',
      source: 'exec',
      thread_source: 'user',
      model_provider: 'openai',
      base_instructions: { text: 'LEAK_SYSTEM_PROMPT You are Codex.' },
      history_mode: 'legacy',
      context_window: 258400,
    }),
    line(1, 'event_msg', {
      type: 'task_started',
      turn_id: turn,
      started_at: 1793289193,
      model_context_window: 258400,
      collaboration_mode_kind: 'default',
    }),
    line(2, 'response_item', {
      type: 'message',
      id: 'msg_dev',
      role: 'developer',
      content: [{ type: 'input_text', text: 'LEAK_DEVELOPER_INSTRUCTIONS' }],
    }),
    line(3, 'response_item', {
      type: 'message',
      id: 'msg_ctx',
      role: 'user',
      content: [
        { type: 'input_text', text: `# AGENTS.md instructions for ${cwd}\nLEAK_AGENTS_MD_BLOCK` },
        {
          type: 'input_text',
          text: `<environment_context>\n  <cwd>${cwd}</cwd>\nLEAK_ENV_CONTEXT`,
        },
      ],
    }),
    line(4, 'world_state', {
      full: true,
      state: { agents_md: { directory: cwd, text: 'LEAK_AGENTS_MD_WORLD' }, skills: [] },
    }),
    line(5, 'turn_context', {
      turn_id: turn,
      cwd,
      current_date: '2026-10-30',
      timezone: 'Asia/Seoul',
      approval_policy: 'never',
      sandbox_policy: { type: 'read-only' },
      model: 'LEAK_TURN_CONTEXT_MODEL',
    }),
    // 실제 기록은 user_message와 같은 글자를 한 번 더 남긴다. 다른 글자를 심어 이 줄을 안 쓰는지 본다
    line(6, 'response_item', {
      type: 'message',
      id: 'msg_prompt',
      role: 'user',
      content: [{ type: 'input_text', text: 'LEAK_PROMPT_ITEM' }],
    }),
    line(7, 'event_msg', {
      type: 'user_message',
      message: CODEX_PROMPT,
      images: [],
      local_images: [],
    }),
    line(8, 'response_item', {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'LEAK_REASONING_SUMMARY' }],
      content: [{ type: 'reasoning_text', text: 'LEAK_REASONING_RAW' }],
      encrypted_content: 'LEAK_ENCRYPTED',
    }),
    line(9, 'event_msg', { type: 'agent_reasoning', text: 'LEAK_AGENT_REASONING' }),
    line(10, 'event_msg', {
      type: 'agent_reasoning_raw_content',
      text: 'LEAK_AGENT_REASONING_RAW',
    }),
    line(11, 'event_msg', {
      type: 'agent_message',
      message: '파일을 읽고 짧게 정리할게요.',
      phase: 'commentary',
      memory_citation: null,
    }),
    line(12, 'response_item', {
      type: 'message',
      id: 'msg_asst',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'LEAK_ASSISTANT_ITEM' }],
    }),
    line(13, 'response_item', {
      type: 'custom_tool_call',
      id: 'ctc_1',
      status: 'completed',
      call_id: 'call_exec',
      name: 'exec',
      input: `const r = await tools.exec_command({"cmd":"API_TOKEN=${FAKE_SECRETS.tokenValue} cat note.txt","workdir":"${cwd}"}); text(r.output);\n`,
    }),
    line(14, 'response_item', {
      type: 'custom_tool_call_output',
      id: 'ctco_1',
      call_id: 'call_exec',
      output: [
        { type: 'input_text', text: 'Script completed\nOutput:\n' },
        { type: 'input_text', text: `hello file ${FAKE_SECRETS.aws} at ${FAKE_HOME}/x\n` },
      ],
    }),
    line(15, 'response_item', {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_fn',
      name: 'shell',
      arguments: JSON.stringify({ command: ['ls', cwd], password: FAKE_SECRETS.keyOnlyValue }),
    }),
    line(16, 'response_item', {
      type: 'function_call_output',
      call_id: 'call_fn',
      output: { content: 'note.txt', success: false },
    }),
    line(16, 'response_item', {
      type: 'local_shell_call',
      call_id: 'call_sh',
      status: 'completed',
      action: {
        type: 'exec',
        command: ['bash', '-lc', `PASSWORD=${FAKE_SECRETS.passwordValue} ls`],
      },
    }),
    line(17, 'event_msg', {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 1, reasoning_output_tokens: 0 } },
    }),
    line(18, 'event_msg', {
      type: 'agent_message',
      message: '파일에는 hello file이라고 적혀 있어요.',
      phase: 'final_answer',
      memory_citation: null,
    }),
    line(19, 'event_msg', {
      type: 'task_complete',
      turn_id: turn,
      last_agent_message: 'LEAK_TASK_COMPLETE',
    }),
    line(20, 'event_msg', {
      type: 'thread_settings_applied',
      thread_settings: { model: 'LEAK_THREAD_SETTINGS' },
    }),
    // 모르는 종류 셋. 줄 종류, event_msg 종류, response_item 종류 하나씩
    line(21, 'brand_new_kind', { text: 'LEAK_UNKNOWN_LINE' }),
    line(22, 'event_msg', { type: 'brand_new_event', text: 'LEAK_UNKNOWN_EVENT' }),
    line(23, 'response_item', { type: 'brand_new_item', text: 'LEAK_UNKNOWN_ITEM' }),
  ];
}

export const CODEX_UNKNOWN_LINES = 3;

export function codexText(): string {
  return codexLines().join('\n') + '\n';
}
