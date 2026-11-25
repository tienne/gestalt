import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { approvalOrigin, WEBAUTHN_RP_ID } from './webauthn-approval.js';

type Decision = 'approved' | 'rejected';

export interface GateOptions {
  gate: { id: string; type: string; repo: string; reason: string; refs: string[]; pr?: string };
  head?: string;
  decision: Decision;
  challenge: string;
  credentialIds: string[];
}

export interface ApprovalHandlers {
  gateOptions(gateId: string, decision: Decision): Promise<GateOptions>;
  decide(gateId: string, decision: Decision, assertion: unknown): Promise<unknown>;
  enroll?: {
    label: string;
    options(): { challenge: string; userId: string; userName: string };
    finish(registration: unknown): unknown;
  };
}

export interface ApprovalServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? ''))
    throw new HttpError(415, 'JSON 요청만 받아요');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, '요청이 너무 커요');
    chunks.push(chunk as Buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'JSON 객체가 아니에요');
  return value as Record<string, unknown>;
}

const decisionOf = (value: unknown): Decision => {
  if (value === 'approved' || value === 'rejected') return value;
  throw new HttpError(400, 'decision은 approved나 rejected예요');
};

function send(res: ServerResponse, status: number, body: string, type: string) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'content-security-policy':
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

const json = (res: ServerResponse, status: number, value: unknown) =>
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');

/**
 * 고정 localhost 포트에 승인 페이지를 띄운다. 127.0.0.1에만 붙고 Host와 Origin을 고정 주소로 확인해 다른 사이트나
 * DNS 재바인딩으로 들어온 요청을 거른다. 게이트를 닫는 근거는 이 확인이 아니라 Touch ID 서명이다
 */
export function startApprovalServer(opts: {
  port: number;
  handlers: ApprovalHandlers;
  idleMs?: number;
  onIdle?: () => void;
}): Promise<ApprovalServer> {
  const origin = approvalOrigin(opts.port);
  const host = `localhost:${opts.port}`;
  let idle: NodeJS.Timeout | undefined;
  const touch = () => {
    if (!opts.idleMs) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => opts.onIdle?.(), opts.idleMs);
    idle.unref();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', origin);
    // 떠 있는지 확인하는 요청은 Host를 안 보고 대기 시간도 늘리지 않는다. 게이트 정보가 없어 새도 괜찮다
    if (req.method === 'GET' && url.pathname === '/health')
      return json(res, 200, { ok: true, service: HEALTH_SERVICE });
    touch();
    if (req.headers.host !== host)
      throw new HttpError(421, `승인 페이지는 ${origin}으로만 열 수 있어요`);
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'GET') {
      if (parts[0] === 'gate' && parts.length === 2)
        return send(
          res,
          200,
          gatePage(parts[1]!, decisionOf(url.searchParams.get('decision'))),
          'text/html; charset=utf-8',
        );
      if (url.pathname === '/enroll' && opts.handlers.enroll)
        return send(res, 200, enrollPage(opts.handlers.enroll.label), 'text/html; charset=utf-8');
      throw new HttpError(404, '없는 주소예요');
    }
    if (req.method !== 'POST') throw new HttpError(405, '지원하지 않는 요청이에요');
    if (req.headers.origin !== origin)
      throw new HttpError(403, '승인 페이지에서 보낸 요청이 아니에요');
    const body = await readJson(req);
    if (parts[0] === 'api' && parts[1] === 'gate' && parts.length === 4) {
      const gateId = parts[2]!;
      const decision = decisionOf(body['decision']);
      if (parts[3] === 'options')
        return json(res, 200, await opts.handlers.gateOptions(gateId, decision));
      if (parts[3] === 'decide')
        return json(res, 200, await opts.handlers.decide(gateId, decision, body['assertion']));
    }
    const enroll = opts.handlers.enroll;
    if (enroll && url.pathname === '/api/enroll/options') return json(res, 200, enroll.options());
    if (enroll && url.pathname === '/api/enroll/finish')
      return json(res, 200, enroll.finish(body['registration']));
    throw new HttpError(404, '없는 주소예요');
  };

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 400;
      json(res, status, { error: error instanceof Error ? error.message : String(error) });
    });
  };
  const listen = (server: Server, address: string) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, address, () => {
        server.off('error', reject);
        resolve();
      });
    });
  const close = (server: Server) =>
    new Promise<void>((done) => {
      if (!server.listening) return done();
      server.close(() => done());
      server.closeAllConnections();
    });
  // 브라우저가 localhost를 IPv6로 먼저 풀어도 닿게 ::1에도 붙는다. IPv6가 없는 기기면 127.0.0.1만 쓴다
  const v4 = createServer(listener);
  const v6 = createServer(listener);
  return listen(v4, '127.0.0.1').then(async () => {
    await listen(v6, '::1').catch(() => undefined);
    touch();
    return {
      server: v4,
      port: opts.port,
      close: async () => {
        if (idle) clearTimeout(idle);
        await Promise.all([close(v4), close(v6)]);
      },
    };
  });
}

const HEALTH_SERVICE = 'gestalt-approval';

/** 서버가 이미 떠 있는지 본다. 다른 프로그램이 포트를 잡았으면 false라 그대로 띄우다 실패한다 */
export async function approvalServerRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(800),
    });
    const body = (await res.json()) as { ok?: unknown; service?: unknown };
    return res.ok && body.ok === true && body.service === HEALTH_SERVICE;
  } catch {
    return false;
  }
}

const SHARED_SCRIPT = `
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error || res.statusText);
  return value;
}
const out = (text, ok) => { const el = document.getElementById('out'); el.textContent = text; el.className = ok ? 'ok' : 'err'; };
`;

const STYLE = `
body { font: 15px -apple-system, system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 20px; color: #1d1d1f; }
h1 { font-size: 20px; } dt { color: #6e6e73; margin-top: 10px; } dd { margin: 2px 0 0; word-break: break-all; }
button { font-size: 16px; padding: 10px 18px; border-radius: 8px; border: 0; background: #0071e3; color: #fff; margin-top: 20px; }
button.reject { background: #d70015; } .ok { color: #1a7f37; } .err { color: #d70015; } pre { white-space: pre-wrap; }
`;

function gatePage(gateId: string, decision: Decision): string {
  const label = decision === 'approved' ? '승인' : '거절';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>게이트 ${label}</title><style>${STYLE}</style></head>
<body><h1>컨덕터 게이트 ${label}</h1><dl id="gate"><dt>게이트</dt><dd></dd></dl>
<button id="go" class="${decision === 'rejected' ? 'reject' : ''}" disabled>Touch ID로 ${label}</button><pre id="out"></pre>
<script>${SHARED_SCRIPT}
const gateId = ${JSON.stringify(gateId)}; const decision = ${JSON.stringify(decision)};
let options;
function row(dl, k, v) { if (!v) return; const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); }
(async () => {
  try {
    options = await post('/api/gate/' + encodeURIComponent(gateId) + '/options', { decision });
    const dl = document.getElementById('gate'); dl.replaceChildren();
    const g = options.gate;
    row(dl, '게이트', g.id); row(dl, '유형', g.type); row(dl, '레포', g.repo); row(dl, '사유', g.reason);
    row(dl, '근거', (g.refs || []).join(', ')); row(dl, 'PR', g.pr); row(dl, 'HEAD', options.head);
    document.getElementById('go').disabled = false;
  } catch (e) { out(e.message, false); }
})();
document.getElementById('go').onclick = async () => {
  try {
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: fromB64url(options.challenge), rpId: ${JSON.stringify(WEBAUTHN_RP_ID)}, userVerification: 'required', timeout: 120000,
      allowCredentials: options.credentialIds.map((id) => ({ type: 'public-key', id: fromB64url(id), transports: ['internal'] })),
    } });
    const r = cred.response;
    const result = await post('/api/gate/' + encodeURIComponent(gateId) + '/decide', { decision, assertion: {
      credentialId: b64url(cred.rawId), clientDataJSON: b64url(r.clientDataJSON),
      authenticatorData: b64url(r.authenticatorData), signature: b64url(r.signature) } });
    out((result.alreadyResolved ? '이미 닫힌 게이트예요. ' : '${label}했어요. ') + (result.itemReport || ''), true);
    document.getElementById('go').disabled = true;
  } catch (e) { out(e.message, false); }
};
</script></body></html>`;
}

function enrollPage(label: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Touch ID 승인자 등록</title><style>${STYLE}</style></head>
<body><h1>Touch ID 승인자 등록</h1><p id="label"></p><button id="go">Touch ID로 등록</button><pre id="out"></pre>
<script>${SHARED_SCRIPT}
document.getElementById('label').textContent = ${JSON.stringify(label)};
document.getElementById('go').onclick = async () => {
  try {
    const o = await post('/api/enroll/options', {});
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: fromB64url(o.challenge), rp: { id: ${JSON.stringify(WEBAUTHN_RP_ID)}, name: 'Gestalt 컨덕터' },
      user: { id: fromB64url(o.userId), name: o.userName, displayName: o.userName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], attestation: 'none', timeout: 120000,
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    } });
    const r = cred.response;
    const pub = r.getPublicKey && r.getPublicKey();
    if (!pub) throw new Error('이 브라우저는 공개키를 꺼내 주지 않아요. Safari나 Chrome 최신 버전으로 열어 주세요');
    const result = await post('/api/enroll/finish', { registration: {
      credentialId: b64url(cred.rawId), clientDataJSON: b64url(r.clientDataJSON),
      publicKey: b64url(pub), algorithm: r.getPublicKeyAlgorithm() } });
    out('등록했어요. ' + result.message + ' 이 창은 닫아도 돼요.', true);
    document.getElementById('go').disabled = true;
  } catch (e) { out(e.message, false); }
};
</script></body></html>`;
}
