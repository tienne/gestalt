import process from 'node:process';
import { realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { ownsPackage } from './package-owner.mjs';

// npm exec prepends its package bin directory. Verify the owning package instead
// of accepting a same-named executable inherited from the user's PATH.
const expected = process.argv[2];
for (const entry of (process.env.PATH ?? '').split(delimiter)) {
  if (!entry) continue;
  const candidate = join(entry, 'gestalt');
  try {
    const bin = realpathSync(candidate);
    if (ownsPackage(bin, expected)) {
      process.stdout.write(JSON.stringify(bin));
      process.exit(0);
    }
  } catch {
    // Broken PATH entries and unrelated packages do not resolve this pin.
  }
}
process.exitCode = 1;
