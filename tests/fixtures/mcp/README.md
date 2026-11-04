# MCP initialization evidence

`codex-cli-0.166.0-initialize.json` contains the `clientInfo` and `protocolVersion`
received by a local stdio MCP recorder from installed Codex CLI 0.166.0 on macOS
on 2026-11-04. It is a real initialize request projection, not an SDK test client.

The probe used a temporary `CODEX_HOME` with only the recorder MCP server and a
model provider pointing to the closed local endpoint `http://127.0.0.1:1/v1`.
`codex exec --ephemeral --skip-git-repo-check --json` started the MCP connection;
the process group was terminated immediately after recording initialization.
No model response, credentials, desktop, or IDE handshake was involved.

Do not infer other host names from executable strings. Add names only when their
actual initialize request is captured. Synthetic detection tests are separate.
