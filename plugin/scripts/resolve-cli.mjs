import process from 'node:process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

// npm exec prepends its package bin directory. Verify the owning package instead
// of accepting a same-named executable inherited from the user's PATH.
const expected = process.argv[2];
for (const entry of (process.env.PATH ?? '').split(delimiter)) {
  if (!entry) continue;
  const candidate = join(entry, 'gestalt');
  try {
    const bin = realpathSync(candidate);
    let directory = dirname(bin);
    while (directory !== dirname(directory)) {
      const manifest = join(directory, 'package.json');
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        if (pkg.name === '@tienne/gestalt' && pkg.version === expected) {
          process.stdout.write(JSON.stringify(bin));
          process.exit(0);
        }
        break;
      }
      directory = dirname(directory);
    }
  } catch {
    // Broken PATH entries and unrelated packages do not resolve this pin.
  }
}
process.exitCode = 1;
