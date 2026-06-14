import { loadConfig } from '../../core/config.js';
import { EventStore } from '../../events/store.js';

export function usageReportCommand(): void {
  const config = loadConfig();
  const eventStore = new EventStore(config.dbPath);

  try {
    const counts = eventStore.getEventCountsByType();
    const entries = Object.entries(counts).sort((a, b) => b[1]! - a[1]!);
    const total = entries.reduce((sum, [, count]) => sum + count!, 0);

    if (entries.length === 0) {
      console.log('📊 Gestalt Usage Report');
      console.log('──────────────────────');
      console.log('No events recorded yet.');
      return;
    }

    const maxCount = entries[0]![1]!;
    const BAR_MAX = 20;

    console.log('📊 Gestalt Usage Report');
    console.log('──────────────────────');

    for (const [eventType, count] of entries) {
      const barLen = maxCount > 0 ? Math.round((count! / maxCount) * BAR_MAX) : 0;
      const bar = '█'.repeat(barLen);
      const label = eventType.padEnd(30, ' ');
      const countStr = String(count!).padStart(6, ' ');
      console.log(`${label}  ${countStr}  ${bar}`);
    }

    console.log('──────────────────────');
    console.log(`Total events: ${total}`);
  } finally {
    eventStore.close();
  }
}
