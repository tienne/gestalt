---
name: mock-skill
version: "1.0.0"
description: "A mock skill for testing"
triggers:
  - "test"
inputs:
  param1:
    type: string
    required: true
    description: "A required parameter"
  param2:
    type: number
    required: false
    description: "An optional parameter"
outputs:
  - result
---

# Mock Skill

This is a mock skill used for testing the skill parser and registry.
