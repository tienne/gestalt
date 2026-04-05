// ─── Summary Provider Interface ──────────────────────────────────

export interface SummaryProvider {
  summarize(filePath: string, code: string): Promise<string | null>;
}
