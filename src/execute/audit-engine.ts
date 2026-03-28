import type { Spec, AuditResult } from '../core/types.js';

export interface AuditContext {
  systemPrompt: string;
  auditPrompt: string;
}

/**
 * Passthrough AuditEngine.
 * 코드베이스를 분석하여 Spec ACs와의 gap을 식별한다.
 * LLM 없이 동작하며, caller가 auditPrompt를 사용해 분석 후 결과를 제출한다.
 */
export class AuditEngine {
  buildAuditContext(spec: Spec, codebaseSnapshot: string): AuditContext {
    const systemPrompt = `You are a senior software engineer auditing a codebase against a project specification.
Your task is to determine which Acceptance Criteria (ACs) are fully implemented, partially implemented, or missing entirely.
Be precise: only classify an AC as "implemented" if you can see clear evidence in the code. Be conservative.`;

    const acList = spec.acceptanceCriteria
      .map((ac, i) => `AC[${i}]: ${ac}`)
      .join('\n');

    const auditPrompt = `Audit the following codebase snapshot against the project specification.

## Spec Goal
${spec.goal}

## Acceptance Criteria
${acList}

## Codebase Snapshot
${codebaseSnapshot}

Classify each AC index as one of:
- "implemented": Clear evidence in the code that this AC is satisfied
- "partial": Some implementation exists but incomplete or missing edge cases
- "missing": No implementation found

Respond with ONLY a JSON object:
{
  "implementedACs": [0, 2],
  "partialACs": [1, 4],
  "missingACs": [3, 5],
  "gapAnalysis": "Summary of what's missing and the most critical gaps to address"
}`;

    return { systemPrompt, auditPrompt };
  }

  buildAuditResult(
    raw: { implementedACs: number[]; partialACs: number[]; missingACs: number[]; gapAnalysis: string },
  ): AuditResult {
    return {
      implementedACs: raw.implementedACs,
      partialACs: raw.partialACs,
      missingACs: raw.missingACs,
      gapAnalysis: raw.gapAnalysis,
      auditedAt: new Date().toISOString(),
    };
  }
}
