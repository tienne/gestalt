import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClientType } from '../../execute/rule-writer.js';

const CONFIG_FILENAME = 'gestalt.json';

export function setupCommand(options: { client?: ClientType } = {}): void {
  const filePath = resolve(CONFIG_FILENAME);

  if (existsSync(filePath)) {
    console.log('이미 설정이 존재합니다: ' + filePath);
    return;
  }

  const config = {
    $schema: './node_modules/@tienne/gestalt/schemas/gestalt.schema.json',
    ...(options.client ? { client: options.client } : {}),
    notifications: false,
    interview: {
      resolutionThreshold: 0.8,
      maxRounds: 10,
    },
  };

  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log('gestalt.json 생성 완료: ' + filePath);
}
