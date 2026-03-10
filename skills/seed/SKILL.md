---
name: seed
version: "1.0.0"
description: "Generate a Seed specification from a completed interview"
triggers:
  - "generate seed"
  - "create spec"
  - "build seed"
inputs:
  sessionId:
    type: string
    required: true
    description: "The interview session ID to generate a seed from"
  force:
    type: boolean
    required: false
    description: "Force generation even if ambiguity threshold is not met"
outputs:
  - seed
---

# Seed Generation Skill

This skill transforms completed interview data into a structured project specification (Seed).

## Output Structure

- **Goal**: Clear project objective
- **Constraints**: Technical and business constraints
- **Acceptance Criteria**: Measurable success conditions
- **Ontology Schema**: Entity-relationship model
- **Gestalt Analysis**: Findings from each principle applied

## Requirements

- Interview session must be in `completed` status
- Ambiguity score must be ≤ 0.2 (unless `force` is true)
