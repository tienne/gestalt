export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 팀, 명단, 원격 공유, 질문에서 사람에게 그대로 보여줄 실패 */
export class PeerNetworkError extends Error {}
