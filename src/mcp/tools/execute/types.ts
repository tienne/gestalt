import type { PassthroughExecuteEngine } from '../../../execute/passthrough-engine.js';
import type { ExecuteInput } from '../../schemas.js';
import type { IHostAdapter } from '../../host-adapter.js';

export type ExecuteHandler = (
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  adapter: IHostAdapter,
) => Promise<string> | string;
