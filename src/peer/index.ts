export { PeerDaemon } from './daemon.js';
export type { PeerDaemonOptions } from './daemon.js';
export { request, DaemonUnavailableError, DAEMON_NOT_RUNNING } from './client.js';
export {
  claudeConfigDir,
  cwdSlug,
  findSessionByPid,
  locateTranscript,
  readSessionFile,
} from './locate.js';
export type { LocateResult, SessionRecord } from './locate.js';
export { peerRoot, socketPath, statePath } from './paths.js';
export { redactText, redactValue, truncateBytes, isToolsLevel, REDACTED } from './redact.js';
export type { ToolsLevel } from './redact.js';
export { TranscriptTail } from './tail.js';
export { TranscriptTransformer, stripSystemReminders } from './transform.js';
export type { PeerEvent } from './transform.js';
export { PeerState } from './state.js';
export type { DaemonStatus, PeerRequest, PeerResponse, ShareInfo } from './protocol.js';
