import { beforeEach, describe, expect, it, vi } from 'vitest';

const locate = vi.hoisted(() => ({
  findSessionInAncestors: vi.fn(),
  findSessionByPid: vi.fn(),
  findSessionSocket: vi.fn(),
  sendToSession: vi.fn(),
}));

vi.mock('../../../src/peer/locate.js', () => ({
  claudeConfigDir: () => '/config',
  findSessionByPid: locate.findSessionByPid,
  findSessionInAncestors: locate.findSessionInAncestors,
}));
vi.mock('../../../src/peer/inbox.js', () => ({ findSessionSocket: locate.findSessionSocket }));
vi.mock('../../../src/digest/session-request.js', () => ({
  sendToSession: locate.sendToSession,
}));

const { defaultLiveSessionBridge } = await import('../../../src/architecture/live-session.js');

describe('defaultLiveSessionBridge alive 캐시', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const record = { pid: 42, sessionId: 's-1' };
    locate.findSessionInAncestors.mockReturnValue(record);
    locate.findSessionByPid.mockReturnValue(record);
    locate.findSessionSocket.mockReturnValue({ ok: true });
  });

  it('짧은 시간 안의 status는 세션과 소켓을 다시 훑지 않는다', () => {
    let t = 1_000;
    const bridge = defaultLiveSessionBridge(() => t);
    expect(bridge.alive()).toBe(true);
    expect(bridge.alive()).toBe(true);
    expect(locate.findSessionSocket).toHaveBeenCalledTimes(1);
    t += 3_000;
    expect(bridge.alive()).toBe(true);
    expect(locate.findSessionSocket).toHaveBeenCalledTimes(2);
  });

  it('보내기가 no_session으로 실패하면 기억한 결과를 버리고 바로 다시 찾는다', async () => {
    const bridge = defaultLiveSessionBridge(() => 1_000);
    expect(bridge.alive()).toBe(true);
    locate.findSessionSocket.mockReturnValue({ ok: false });
    locate.sendToSession.mockResolvedValue({ ok: false, code: 'no_session', reason: '없음' });
    expect(await bridge.send('질문')).toMatchObject({ ok: false, code: 'no_session' });
    expect(bridge.alive()).toBe(false);
  });

  it('send_failed는 기억한 결과를 그대로 둔다', async () => {
    const bridge = defaultLiveSessionBridge(() => 1_000);
    expect(bridge.alive()).toBe(true);
    locate.sendToSession.mockResolvedValue({ ok: false, code: 'send_failed', reason: '실패' });
    await bridge.send('질문');
    expect(bridge.alive()).toBe(true);
    expect(locate.findSessionSocket).toHaveBeenCalledTimes(1);
  });
});
