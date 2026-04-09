import React from 'react';
import { render } from 'ink';
import { loadConfig } from '../../core/config.js';
import { TUIApp } from '../../tui/components/TUIApp.js';

export async function monitorCommand(sessionId?: string): Promise<void> {
  const config = loadConfig();
  const { waitUntilExit } = render(
    React.createElement(TUIApp, {
      dbPath: config.dbPath,
      initialSessionId: sessionId,
    }),
  );

  await waitUntilExit();
}
