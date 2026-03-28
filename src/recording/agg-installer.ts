import { execSync, spawnSync } from 'node:child_process';

export class AggInstaller {
  isInstalled(): boolean {
    try {
      execSync('which agg', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  async ensureInstalled(): Promise<void> {
    if (this.isInstalled()) return;

    console.log('📦 agg is not installed. Installing...');

    const hasCargo = this.hasCommand('cargo');
    const hasNpm = this.hasCommand('npm');

    if (hasCargo) {
      console.log('  → cargo install agg');
      const result = spawnSync('cargo', ['install', 'agg'], { stdio: 'inherit' });
      if (result.status !== 0) {
        throw new Error('Failed to install agg via cargo. Please install manually: https://github.com/asciinema/agg');
      }
    } else if (hasNpm) {
      console.log('  → npm install -g @asciinema/agg');
      const result = spawnSync('npm', ['install', '-g', '@asciinema/agg'], { stdio: 'inherit' });
      if (result.status !== 0) {
        throw new Error(
          'Failed to install agg via npm. Please install manually: https://github.com/asciinema/agg',
        );
      }
    } else {
      throw new Error(
        'Neither cargo nor npm is available. Please install agg manually: https://github.com/asciinema/agg',
      );
    }

    if (!this.isInstalled()) {
      throw new Error('agg installation failed. Please install it manually: https://github.com/asciinema/agg');
    }
    console.log('✅ agg installed successfully.\n');
  }

  private hasCommand(cmd: string): boolean {
    try {
      execSync(`which ${cmd}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}
