import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../../core/config.js';
import {
  approvalServerRunning,
  startApprovalServer,
  type ApprovalHandlers,
} from '../../conductor/approval-server.js';
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

const gateHandlers = (opts: ConductorCommonOptions): Omit<ApprovalHandlers, 'enroll'> => ({
  gateOptions: (gateId, decision) => touchIdGateOptions(opts, gateId, decision),
  decide: (gateId, decision, assertion) => touchIdGateDecide(opts, gateId, decision, assertion),
});

/**
 * Touch ID 승인 페이지를 띄운다. 운영 봇은 --detach로 불러 바로 돌아오고 서버는 요청이 끊기면 스스로 내려간다
 */
export async function conductorApprovalServeCommand(
  opts: ConductorCommonOptions & { port?: string; idleSec?: string; detach?: boolean },
): Promise<void> {
  try {
    const port = portOf(opts.port);
    const origin = approvalOrigin(port);
    if (await approvalServerRunning(port))
      return console.log(JSON.stringify({ running: true, started: false, origin }));
    if (opts.detach) {
      const args = process.argv.slice(1).filter((a) => a !== '--detach');
      spawn(process.execPath, [...process.execArgv, ...args], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (await approvalServerRunning(port))
          return console.log(JSON.stringify({ running: true, started: true, origin }));
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(
        `승인 서버가 ${origin}에서 뜨지 않았어요. 포트를 다른 프로그램이 쓰는지 확인해 주세요`,
      );
    }
    const idleSec = opts.idleSec === undefined ? 900 : Number(opts.idleSec);
    if (!Number.isInteger(idleSec) || idleSec < 0) throw new Error('--idle-sec은 0 이상 정수예요');
    const stateDir = resolveStateDir(opts.stateDir, loadConfig().conductor);
    const server = await startApprovalServer({
      port,
      handlers: gateHandlers({ stateDir }),
      idleMs: idleSec * 1000,
      onIdle: () => void server.close().then(() => process.exit(0)),
    });
    console.error(`Touch ID 승인 페이지를 ${origin}에 띄웠어요`);
  } catch (error) {
    fail(error);
  }
}

/**
 * 승인자 패스키를 처음 한 번 등록한다. 운영자 터미널에서 부르면 기본 브라우저에 등록 페이지를 열고 Touch ID로 만든
 * 공개키를 bot-policy.json에 넣은 뒤 서버를 닫는다
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
      throw new Error(`승인 서버가 ${origin}에 떠 있어요. 끈 뒤 다시 등록해 주세요`);
    const stateDir = resolveStateDir(opts.stateDir, loadConfig().conductor);
    const challenge = randomBytes(32).toString('base64url');
    const userId = randomBytes(16).toString('base64url');
    let done: (message: string) => void = () => {};
    const finished = new Promise<string>((resolve) => (done = resolve));
    const label = `${opts.repo} ${type === 'merge' ? '머지' : '게이트'} 승인자 ${opts.id}`;
    const server = await startApprovalServer({
      port,
      handlers: {
        gateOptions: () => Promise.reject(new Error('등록 중에는 게이트를 다루지 않아요')),
        decide: () => Promise.reject(new Error('등록 중에는 게이트를 다루지 않아요')),
        enroll: {
          label,
          options: () => ({ challenge, userId, userName: `${opts.id}@${opts.repo}` }),
          finish: (registration) => {
            const credential = verifyWebAuthnRegistration(registration, challenge, origin);
            addWebAuthnApprover(stateDir, type, opts.repo, opts.id, credential, opts.replace);
            const message = `${label}를 등록했어요`;
            done(message);
            return { message };
          },
        },
      },
    });
    const url = `${origin}/enroll`;
    if (opts.open !== false) execFile('open', [url], () => {});
    console.error(`기본 브라우저에서 ${url}을 열어 Touch ID로 등록해 주세요`);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('5분 안에 등록하지 않아 닫았어요')), 5 * 60_000).unref(),
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
