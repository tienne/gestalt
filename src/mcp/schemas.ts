import { z } from 'zod';

// ─── Interview Tool ─────────────────────────────────────────────
export const interviewInputSchema = z.object({
  action: z.enum(['start', 'respond', 'score', 'complete']),
  topic: z.string().optional(),
  sessionId: z.string().optional(),
  response: z.string().optional(),
  cwd: z.string().optional(),
});

export type InterviewInput = z.infer<typeof interviewInputSchema>;

// ─── Seed Tool ──────────────────────────────────────────────────
export const seedInputSchema = z.object({
  sessionId: z.string(),
  force: z.boolean().optional().default(false),
});

export type SeedInput = z.infer<typeof seedInputSchema>;

// ─── Status Tool ────────────────────────────────────────────────
export const statusInputSchema = z.object({
  sessionId: z.string().optional(),
});

export type StatusInput = z.infer<typeof statusInputSchema>;
