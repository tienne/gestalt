import { z } from 'zod';
import { findSessionSocket, writeInbox, type InboxResult } from '../peer/inbox.js';
import { claudeConfigDir, findSessionInAncestors, type AncestorLookup } from '../peer/locate.js';
import { templateIdSchema } from './blocks.js';
import { LANG_TAG_PATTERN } from './schema-base.js';
import { isValidSlug } from './store.js';

/**
 * 뷰어 버튼이 serve에 보내는 요청과 그 요청을 serve를 띄운 Claude Code 세션의 인박스에 넣는 길.
 *
 * 뷰어는 LLM을 부르지 않는다. 세션에 "이 명령을 실행하라"는 글을 넣을 뿐이다. 그 글은 서버가 정해 둔
 * 틀과 검사를 통과한 값으로만 조립한다. 브라우저가 보낸 글자를 그대로 세션에 옮기지 않는다.
 */

const slugSchema = z.string().max(64).refine(isValidSlug, 'slug 꼴이 아니다');
const langSchema = z.string().max(35).regex(LANG_TAG_PATTERN);
// 구간은 초 단위 두 수다. 명령에는 Math.floor, Math.ceil을 거친 정수만 들어간다
const rangeSchema = z
  .tuple([z.number().finite().min(0).max(1e7), z.number().finite().min(0).max(1e7)])
  .refine(([from, to]) => from < to, '구간 끝이 시작보다 뒤여야 한다');

/** 본문에 정해 둔 필드 말고는 받지 않는다(strict). 자유 입력 칸은 없다 */
export const sessionRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('report'),
      slug: slugSchema,
      difficulty: z.enum(['easy', 'normal']),
      lang: langSchema.optional(),
      range: rangeSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('template'),
      slug: slugSchema,
      template: templateIdSchema,
      lang: langSchema.optional(),
    })
    .strict(),
]);

export type SessionRequest = z.infer<typeof sessionRequestSchema>;

/**
 * 세션에서 돌릴 명령. viewer-logic.ts의 reportCommand, templateCommand와 같은 글자를 내야 한다.
 * 복사 모드로 떨어졌을 때 뷰어가 보여 주는 명령과 세션에 넣은 명령이 달라지면 안 되어서 테스트가 둘을 맞춰 본다
 */
export function requestCommand(req: SessionRequest, lens: boolean): string {
  let cmd = `${lens ? '/gestalt:lens' : '/gestalt:video-digest'} slug=${req.slug}`;
  if (req.action === 'report') {
    cmd += ` difficulty=${req.difficulty}`;
    if (req.range) cmd += ` range=${Math.floor(req.range[0])}-${Math.ceil(req.range[1])}`;
  } else {
    cmd += ` templates=${req.template}`;
  }
  return req.lang ? `${cmd} reportLang=${req.lang}` : cmd;
}

/** 세션에 넣는 글. 인박스 글이 슬래시 명령으로 바로 도는지는 확인하지 못해서 모델이 스킬을 부르도록 틀 문장을 붙인다 */
export function frameSessionRequest(req: SessionRequest, lens: boolean): string {
  return [
    '<digest-request from="viewer">',
    requestCommand(req, lens),
    '</digest-request>',
    'gestalt digest serve 뷰어에서 사용자가 버튼을 눌러 보낸 요청이다. 위 명령 한 줄을 그대로 실행해 리포트를 만든다. 뷰어 serve가 이미 떠 있으니 렌더까지만 하고 serve를 새로 띄우지 않는다. 다 만들면 뷰어에 바로 들어간다고 알린다.',
  ].join('\n');
}

/**
 * maybeWritten은 소켓에 붙은 뒤 실패해 실제로 들어갔을 수 있다는 뜻이다. 다시 보내면 겹쳐서 넣음으로 친다.
 * no_session은 넣을 세션이나 소켓을 못 찾은 것이고 send_failed는 소켓에 쓰다 실패한 것이다
 */
export type SendResult =
  | { ok: true; maybeWritten?: true }
  | { ok: false; code: 'no_session' | 'send_failed'; reason: string };

export interface SendDeps extends AncestorLookup {
  /** 부모를 따라 올라가기 시작할 pid. 기본은 serve 자신이다 */
  startPid?: number;
  configDir?: string;
  write?: (socketPath: string, text: string) => Promise<InboxResult>;
}

/**
 * serve를 띄운 Claude Code 세션을 부모 pid 체인에서 찾아 인박스 소켓에 글을 넣는다. 세션은 `/clear`나
 * 재시작으로 바뀔 수 있어서 요청마다 다시 찾는다. 쓰는 길은 peer 데몬의 발췌 넣기와 같다
 */
export async function sendToSession(text: string, deps: SendDeps = {}): Promise<SendResult> {
  const configDir = deps.configDir ?? claudeConfigDir(deps.env);
  const session = findSessionInAncestors(deps.startPid ?? process.pid, configDir, deps);
  if (!session) {
    return { ok: false, code: 'no_session', reason: 'serve를 띄운 Claude Code 세션을 못 찾았어요' };
  }
  const found = findSessionSocket(session.sessionId, [configDir]);
  if (!found.ok) return { ok: false, code: 'no_session', reason: found.reason };
  const result = await (deps.write ?? writeInbox)(found.path, text);
  if (result.ok) return { ok: true };
  if (result.maybeWritten) return { ok: true, maybeWritten: true };
  return { ok: false, code: 'send_failed', reason: result.reason };
}
