---
name: interview
version: "1.0.0"
description: "Gestalt-driven interview to clarify project requirements"
triggers:
  - "interview"
  - "clarify requirements"
  - "start interview"
inputs:
  topic:
    type: string
    required: true
    description: "The topic or feature to interview about"
  cwd:
    type: string
    required: false
    description: "Working directory for brownfield detection"
outputs:
  - session
  - ambiguityScore
---

# Interview Skill

This skill conducts a Gestalt psychology-driven interview to transform vague requirements into clear specifications.

## Process

1. **Start**: Create a session, detect project type (greenfield/brownfield), ask the first question
2. **Iterate**: Ask questions guided by Gestalt principles (Closure → Proximity → Similarity → Figure-Ground)
3. **Score**: Continuously assess ambiguity across multiple dimensions
4. **Complete**: When ambiguity score ≤ 0.2, the interview is ready for seed generation

## Gestalt Principles Applied

- **Closure**: Fill missing requirements
- **Proximity**: Group related features
- **Similarity**: Identify patterns
- **Figure-Ground**: Separate MVP from nice-to-have
- **Continuity**: Detect contradictions
