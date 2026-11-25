import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../core/config.js';
import {
  approvalServerRunning,
  approvalStoreId,
  HttpError,
  startApprovalServer,
  type ApprovalHandlers,
} from '../../conductor/approval-server.js';
import { InputError } from '../../conductor/input-error.js';
import { resolveStateDir } from '../../conductor/state-dir.js';
import {
  addWebAuthnApprover,
  approvalOrigin,
  APPROVAL_PORT,
  verifyWebAuthnRegistration,
} from '../../conductor/webauthn-approval.js';
import { touchIdGateDecide, touchIdGateOptions, type ConductorCommonOptions } from './conductor.js';

const fail = (error: unknown): never => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
};

const portOf = (value: string | undefined) => {
  const port = value === undefined ? APPROVAL_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('--port는 1024~65535 사이 숫자예요');
  return port;
};

/** 게이트를 찾지 못했거나 서명이 안 맞는 것처럼 요청 쪽 문제(InputError)만 400으로 돌려주고 나머지는 500으로 감춘다 */
async function asInput<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InputError) throw new HttpError(400, error.message);
    throw error;
  }
}

/** 승인자는 터미널을 안 보므로 다시 시도하거나 봇 채팅에 알리는 길만 안내한다. 원인은 approval-server.log에 남는다 */
export const APPROVER_SERVER_ERROR =
  '승인 서버가 요청을 처리하지 못했어요. 잠시 뒤 다시 시도하고 계속되면 운영 봇 채팅에 알려 주세요';

const NONCE_TTL_MS = 2 * 60_000;
const MAX_NONCES = 64;

/**
 * 게이트 승인 페이지의 요청을 받는다. options마다 nonce를 발급해 메모리에만 두고 decide에서 한 번만 쓴다.
 * 그래서 이 서버가 연 페이지에서 받은 서명만 게이트를 닫는다
 */
export function approvalGateHandlers(
  opts: ConductorCommonOptions,
  port: number,
): Omit<ApprovalHandlers, 'enroll'> {
  const origin = approvalOrigin(port);
  const issued = new Map<string, { gateId: string; decision: string; expiresAt: number }>();
  return {
    gateOptions: async (gateId, decision) => {
      const now = Date.now();
      for (const [nonce, entry] of issued) if (entry.expiresAt <= now) issued.delete(nonce);
      while (issued.size >= MAX_NONCES) issued.delete(issued.keys().next().value!);
      const nonce = randomBytes(32).toString('base64url');
      const options = await asInput(() => touchIdGateOptions(opts, gateId, decision, nonce));
      issued.set(nonce, { gateId, decision, expiresAt: now + NONCE_TTL_MS });
      return options;
    },
    decide: async (gateId, decision, assertion, nonce) => {
      const entry = typeof nonce === 'string' ? issued.get(nonce) : undefined;
      if (typeof nonce === 'string') issued.delete(nonce);
      if (
        !entry ||
        entry.gateId !== gateId ||
        entry.decision !== decision ||
        entry.expiresAt <= Date.now()
      )
        throw new HttpError(400, '승인 요청이 만료됐어요. 승인 페이지를 새로 열어 주세요');
      return asInput(() =>
        touchIdGateDecide(opts, gateId, decision, assertion, { nonce: nonce as string, origin }),
      );
    },
  };
}

/** 등록 코드 비교. 길이가 다르면 timingSafeEqual이 던지므로 먼저 본다 */
function sameCode(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given.replace(/[\s-]/g, ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Touch ID 승인 페이지를 띄운다. 운영 봇은 --detach로 불러 바로 돌아오고 서버는 요청이 끊기면 스스로 내려간다
 */
export async function conductorApprovalServeCommand(
  opts: ConductorCommonOptions & { port?: string; idleSec?: string; detach?: boolean },
): Promise<void> {
  try {
    const port = portOf(opts.port);
    const origin = approvalOrigin(port);
    const stateDir = resolveStateDir(opts.stateDir, loadConfig().conductor);
    const store = approvalStoreId(stateDir);
    if (await approvalServerRunning(port, store))
      return console.log(JSON.stringify({ running: true, started: false, origin }));
    if (opts.detach) {
      const args = process.argv.slice(1).filter((a) => a !== '--detach');
      const logPath = join(stateDir, 'approval-server.log');
      const logFd = openSync(logPath, 'a', 0o600);
      let exited: number | null | undefined;
      const child = spawn(process.execPath, [...process.execArgv, ...args], {
        detached: true,
        stdio: ['ignore', 'ignore', logFd],
      });
      closeSync(logFd);
      child.once('exit', (code) => (exited = code));
      child.unref();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (await approvalServerRunning(port, store))
          return console.log(JSON.stringify({ running: true, started: true, origin }));
        if (exited !== undefined)
          throw new Error(
            `승인 서버가 종료 코드 ${exited}로 바로 내려갔어요. ${logPath}를 확인해 주세요`,
          );
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(
        `승인 서버가 ${origin}에서 뜨지 않았어요. 포트를 다른 프로그램이 쓰는지 ${logPath}에서 확인해 주세요`,
      );
    }
    const idleSec = opts.idleSec === undefined ? 900 : Number(opts.idleSec);
    if (!Number.isInteger(idleSec) || idleSec < 0) throw new Error('--idle-sec은 0 이상 정수예요');
    const server = await startApprovalServer({
      port,
      store,
      handlers: approvalGateHandlers({ stateDir }, port),
      idleMs: idleSec * 1000,
      serverErrorMessage: APPROVER_SERVER_ERROR,
      onIdle: () => void server.close().then(() => process.exit(0)),
    });
    console.error(`Touch ID 승인 페이지를 ${origin}에 띄웠어요`);
  } catch (error) {
    fail(error);
  }
}

/**
 * 승인자 패스키를 처음 한 번 등록한다. 운영자 터미널에서 부르면 기본 브라우저에 등록 페이지를 열고 Touch ID로 만든
 * 공개키를 bot-policy.json에 넣은 뒤 서버를 닫는다.
 * 등록 창이 열린 동안 같은 PC의 다른 프로세스도 이 주소에 요청할 수 있다. 그래서 터미널 stderr에만 찍은 등록 코드를
 * 페이지에 옮겨 적어야 하고 finish는 한 번만 받는다
 */
export async function conductorApproverEnrollCommand(
  opts: ConductorCommonOptions & {
    repo: string;
    type: string;
    id: string;
    port?: string;
    replace?: boolean;
    open?: boolean;
  },
): Promise<void> {
  try {
    const port = portOf(opts.port);
    const origin = approvalOrigin(port);
    if (opts.type !== 'merge' && opts.type !== 'gate') throw new Error('--type은 merge나 gate예요');
    const type = opts.type;
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(opts.repo))
      throw new Error('--repo는 owner/name 꼴이에요');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(opts.id))
      throw new Error('--id는 영문, 숫자, 점, 밑줄, 하이픈으로 64자까지예요');
    if (await approvalServerRunning(port))
      throw new Error(
        `승인 서버가 ${origin}에 떠 있어요. 15분 동안 요청이 없으면 스스로 내려가요. 바로 끄려면 \`lsof -nP -iTCP:${port} -sTCP:LISTEN\`로 pid를 확인해 종료한 뒤 다시 등록해 주세요`,
      );
    const stateDir = resolveStateDir(opts.stateDir, loadConfig().conductor);
    const challenge = randomBytes(32).toString('base64url');
    const userId = randomBytes(16).toString('base64url');
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
    let attempted = false;
    let done: (message: string) => void = () => {};
    let stop: (error: Error) => void = () => {};
    const finished = new Promise<string>((resolve, reject) => {
      done = resolve;
      stop = reject;
    });
    const label = `${opts.repo} ${type === 'merge' ? '머지' : '게이트'} 승인자 ${opts.id}`;
    const server = await startApprovalServer({
      port,
      handlers: {
        gateOptions: () => Promise.reject(new Error('등록 중에는 게이트를 다루지 않아요')),
        decide: () => Promise.reject(new Error('등록 중에는 게이트를 다루지 않아요')),
        enroll: {
          label,
          options: () => ({ challenge, userId, userName: `${opts.id}@${opts.repo}` }),
          finish: async (registration, given) => {
            if (attempted)
              throw new HttpError(
                409,
                '이미 등록을 시도했어요. 터미널에서 명령을 다시 실행해 주세요',
              );
            attempted = true;
            try {
              if (!sameCode(code, given))
                throw new InputError('등록 코드가 맞지 않아 등록을 중단했어요');
              const credential = verifyWebAuthnRegistration(registration, challenge, origin);
              await addWebAuthnApprover(
                stateDir,
                type,
                opts.repo,
                opts.id,
                credential,
                opts.replace,
              );
            } catch (error) {
              const failed = error instanceof Error ? error : new Error(String(error));
              stop(failed);
              if (error instanceof InputError) throw new HttpError(400, error.message);
              throw error;
            }
            const message = `${label}를 등록했어요`;
            done(message);
            return { message };
          },
        },
      },
    });
    const url = `${origin}/enroll`;
    if (opts.open !== false) execFile('open', [url], () => {});
    console.error(
      `기본 브라우저에서 ${url}을 열어 등록 코드 ${code.slice(0, 4)}-${code.slice(4)}을 넣고 Touch ID로 등록해 주세요`,
    );
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('5분 안에 등록하지 않아 등록을 중단했어요')),
        5 * 60_000,
      ).unref(),
    );
    try {
      console.log(
        JSON.stringify({ enrolled: true, message: await Promise.race([finished, timeout]) }),
      );
    } finally {
      // 등록 응답이 브라우저에 닿을 틈을 두고 닫는다
      await new Promise((r) => setTimeout(r, 300));
      await server.close();
    }
  } catch (error) {
    fail(error);
  }
}
