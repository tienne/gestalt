import type { PassthroughExecuteEngine } from '../../../execute/passthrough-engine.js';
import type { ExecuteInput } from '../../schemas.js';
import type { ClientType } from '../../../execute/rule-writer.js';

export type ExecuteHandler = (
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  client: ClientType,
) => Promise<string> | string;
