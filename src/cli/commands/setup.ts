import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG_FILENAME = 'gestalt.json';

export function setupCommand(): void {
  const filePath = resolve(CONFIG_FILENAME);

  if (existsSync(filePath)) {
    console.log('이미 설정이 존재합니다: ' + filePath);
    return;
  }

  const config = {
    $schema: './node_modules/@tienne/gestalt/schemas/gestalt.schema.json',
    interview: {
      ambiguityThreshold: 0.2,
      maxRounds: 10,
    },
  };

  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log('gestalt.json 생성 완료: ' + filePath);
}
