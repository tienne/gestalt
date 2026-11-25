# /gestalt-spec

Turn a finished interview into a validated Spec.

## Arguments

- `session_id`: interview session id (optional — uses the active session)

- `--conductor`: submit the validated plan to the registered Conductor instead of implementing locally.

## Workflow

Read `skills/spec/SKILL.md` in this plugin and follow it.

## Notes

- With `--conductor`, `--spec <spec-id>` selects an existing Spec and `--plan <plan-id>` selects a finalized plan.

- Requires a completed interview. Starting from a raw problem, run `/gestalt-interview` first.
