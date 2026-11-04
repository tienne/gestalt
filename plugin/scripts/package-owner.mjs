import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The nearest manifest owns the bin; an unrelated parent must not vouch for it.
export function ownsPackage(bin, version) {
  try {
    let directory = dirname(bin);
    while (directory !== dirname(directory)) {
      const manifest = join(directory, 'package.json');
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        return pkg.name === '@tienne/gestalt' && pkg.version === version;
      }
      directory = dirname(directory);
    }
  } catch {
    return false;
  }
  return false;
}
