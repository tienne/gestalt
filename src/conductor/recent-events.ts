import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { oneLine } from './intake.js';
import { EVENTS_FILE } from './store.js';
import type { ConductorEvent, ConductorSnapshot } from './types.js';

/**
 * 바깥 도구(오르카 터미널 화면)가 이벤트 로그를 보여 줄 때 쓰는 한 줄.
 * summary에는 주문 제목이나 게이트 사유처럼 바깥에서 온 글이 들어가니 그리는 쪽이 이스케이프한다
 */
export interface RecentEvent {
  at: string;
  type: 'checkpoint' | 'report' | 'waiting' | 'bypass' | 'gate-opened' | 'gate-resolved';
  orderId?: string;
  summary: string;
}

export const RECENT_EVENTS_LIMIT = 50;

/** 이벤트 로그 끝에서 이만큼만 읽는다. 로그가 길어져도 status가 전체를 두 번 읽지 않게 한다 */
const TAIL_BYTES = 512 * 1024;
const SUMMARY_MAX = 160;

function readTailLines(path: string, bytes: number): string[] {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf-8').split('\n');
    // 중간부터 읽었으면 첫 줄은 잘린 줄이다
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    closeSync(fd);
  }
}

/** 사람이 읽는 줄이라 대기 기한은 이 맥의 HH:MM으로 줄인다. 못 읽는 값은 그대로 둔다 */
function clock(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function summarize(e: ConductorEvent, s: Readonly<ConductorSnapshot>): RecentEvent | undefined {
  switch (e.type) {
    case 'checkpoint-saved': {
      const c = e.checkpoint;
      const phase = c.phase ? ` → ${c.phase}` : '';
      const round = c.round ? ` r${c.round}` : '';
      return {
        at: e.at,
        type: 'checkpoint',
        orderId: c.orderId,
        summary: oneLine(`${c.skill}${phase}${round}`, SUMMARY_MAX),
      };
    }
    case 'report-applied': {
      const r = e.report;
      if (!r) return undefined;
      const orderId = s.workers[r.workerId]?.orderId;
      const base = { at: e.at, ...(orderId ? { orderId } : {}) };
      if (r.status === 'waiting') {
        const reason = r.wait?.reason ?? r.summary;
        const until = r.wait?.until ? ` · ~${clock(r.wait.until)}` : '';
        return { ...base, type: 'waiting', summary: oneLine(`${reason}${until}`, SUMMARY_MAX) };
      }
      const skill = r.skill ? ` · ${r.skill}` : '';
      return {
        ...base,
        type: 'report',
        summary: oneLine(`${r.status}${skill} · ${r.summary}`, SUMMARY_MAX),
      };
    }
    case 'bypass': {
      const b = e.record;
      const step = b.step ? ` (${b.step})` : '';
      return {
        at: e.at,
        type: 'bypass',
        ...(b.orderId ? { orderId: b.orderId } : {}),
        summary: oneLine(`${b.need}${step} · ${b.action}`, SUMMARY_MAX),
      };
    }
    case 'gate-opened': {
      const g = e.gate;
      return {
        at: e.at,
        type: 'gate-opened',
        ...(g.orderId ? { orderId: g.orderId } : {}),
        summary: oneLine(`${g.type} · ${g.reason}`, SUMMARY_MAX),
      };
    }
    case 'gate-resolved': {
      const g = s.gates[e.gateId];
      return {
        at: e.at,
        type: 'gate-resolved',
        ...(g?.orderId ? { orderId: g.orderId } : {}),
        summary: oneLine(`${g?.type ?? e.gateId} · ${e.decision}`, SUMMARY_MAX),
      };
    }
    default:
      return undefined;
  }
}

/**
 * 이벤트 로그 끝에서 사람이 볼 만한 이벤트를 골라 오래된 것부터 limit개 돌려준다.
 * 지운 주문의 이벤트는 뺀다. 저장 형식은 건드리지 않고 읽기만 한다
 */
export function readRecentEvents(
  dir: string,
  snapshot: Readonly<ConductorSnapshot>,
  limit = RECENT_EVENTS_LIMIT,
): RecentEvent[] {
  const out: RecentEvent[] = [];
  for (const line of readTailLines(join(dir, EVENTS_FILE), TAIL_BYTES)) {
    if (!line.trim()) continue;
    let event: ConductorEvent;
    try {
      event = JSON.parse(line) as ConductorEvent;
    } catch {
      continue;
    }
    const item = summarize(event, snapshot);
    if (!item) continue;
    if (item.orderId && snapshot.removedOrders[item.orderId]) continue;
    out.push(item);
  }
  return out.slice(-limit);
}
