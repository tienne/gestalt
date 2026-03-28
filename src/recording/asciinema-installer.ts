import { execSync, spawnSync } from 'node:child_process';
import { platform } from 'node:os';

export class AsciinemaInstaller {
  isInstalled(): boolean {
    try {
      execSync('which asciinema', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  async ensureInstalled(): Promise<void> {
    if (this.isInstalled()) return;

    const os = platform();
    console.log('📦 asciinema is not installed. Installing...');

    if (os === 'darwin') {
      this.ensureBrewAvailable();
      console.log('  → brew install asciinema');
      const result = spawnSync('brew', ['install', 'asciinema'], { stdio: 'inherit' });
      if (result.status !== 0) {
        throw new Error('Failed to install asciinema via brew. Please install manually: brew install asciinema');
      }
    } else if (os === 'linux') {
      console.log('  → pip3 install asciinema');
      const result = spawnSync('pip3', ['install', 'asciinema'], { stdio: 'inherit' });
      if (result.status !== 0) {
        throw new Error('Failed to install asciinema via pip3. Please install manually: pip3 install asciinema');
      }
    } else {
      throw new Error(
        `Unsupported platform for automatic asciinema installation: ${os}. Please install asciinema manually: https://docs.asciinema.org/manual/cli/installation/`,
      );
    }

    if (!this.isInstalled()) {
      throw new Error(
        'asciinema installation failed. Please install it manually: https://docs.asciinema.org/manual/cli/installation/',
      );
    }
    console.log('✅ asciinema installed successfully.\n');
  }

  private ensureBrewAvailable(): void {
    try {
      execSync('which brew', { stdio: 'pipe' });
    } catch {
      throw new Error(
        'Homebrew is not installed. Please install it first: https://brew.sh, then run: brew install asciinema',
      );
    }
  }
}
