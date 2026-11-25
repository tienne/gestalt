# /gestalt-execute

Turn a Spec into a validated ExecutionPlan and run it.

## Arguments

- `spec_id`: spec id (optional — uses the active spec)

- `--conductor`: submit the validated plan to the registered Conductor instead of implementing locally.

## Workflow

Read `skills/execute/SKILL.md` in this plugin and follow it.

Planning walks figure-ground → closure → proximity → continuity, then the plan
runs task by task with evaluation between steps.

## Notes

- With `--conductor`, `--plan <plan-id>` selects a finalized plan and `--session <execute-session-id>` resumes planning.

- Gestalt returns prompts and structured context. You perform the file edits and command execution.
- Requires an existing Spec. Given only a problem statement, use `/gestalt-solve`.
