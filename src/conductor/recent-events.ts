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
  /** waiting의 대기 기한(ISO). 시각은 문장에 넣지 않고 그리는 쪽이 자기 시간대로 적는다 */
  until?: string;
}

export const RECENT_EVENTS_LIMIT = 50;

/** 이벤트 로그 끝에서 이만큼만 읽는다. status를 부를 때마다 읽으니 최근 50개가 들어갈 만큼만 잡는다 */
export const TAIL_BYTES = 128 * 1024;
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
    // 중간부터 읽을 때는 앞 바이트 하나를 더 읽는다. 그 바이트가 줄바꿈이면 첫 조각은 빈 문자열이고
    // 아니면 잘린 줄이라 어느 쪽이든 버린다
    const start = size > bytes ? size - bytes - 1 : 0;
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf-8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    closeSync(fd);
  }
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
        const until = r.wait?.until;
        return {
          ...base,
          type: 'waiting',
          summary: oneLine(r.wait?.reason ?? r.summary, SUMMARY_MAX),
          ...(until ? { until } : {}),
        };
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
  const lines = readTailLines(join(dir, EVENTS_FILE), TAIL_BYTES);
  // 끝에서부터 읽어 limit개가 차면 멈춘다. 앞쪽 줄까지 JSON.parse하지 않는다
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]!;
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
  return out.reverse();
}
