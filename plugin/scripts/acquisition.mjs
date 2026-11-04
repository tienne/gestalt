import { spawn } from 'node:child_process';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';

// One cancellation scope spans npm resolution, version verification and cwd cleanup.
// A child's own signal/timeout is a failed attempt, never a user's cancellation.
export function createAcquisition({ cwd, env }) {
  let current;
  let signal;
  const cancel = (received) => {
    signal = received;
    current?.cancel(received);
  };
  const terminate = () => cancel('SIGTERM');
  const hangup = () => cancel('SIGHUP');
  const interrupt = () => cancel('SIGINT');
  process.on('SIGTERM', terminate);
  process.on('SIGHUP', hangup);
  process.on('SIGINT', interrupt);

  return {
    get signal() {
      return signal;
    },
    run(command, args, timeoutMs) {
      return new Promise((resolveResult) => {
        const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let bytes = 0;
        let failed = false;
        let interruptTimer;
        let killTimer;
        let drainTimer;
        const stop = (received) => {
          clearTimeout(interruptTimer);
          child.kill(received);
          // Give npm a chance to forward cancellation first. KILL targets only this
          // direct child; descendants can survive if npm cannot relay the signal.
          killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000);
        };
        const active = {
          cancel(received) {
            if (received === 'SIGINT') {
              // Do not duplicate group INT. Any surviving child gets TERM after grace.
              interruptTimer ??= setTimeout(() => stop('SIGTERM'), 2000);
            } else stop(received);
          },
        };
        current = active;
        const deadline = setTimeout(() => {
          failed = true;
          stop('SIGTERM');
        }, timeoutMs);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 64 * 1024) {
            failed = true;
            stop('SIGTERM');
          } else stdout += chunk;
        });
        child.stderr.resume();
        child.once('error', () => {
          failed = true;
        });
        child.once('exit', () => {
          clearTimeout(deadline);
          clearTimeout(interruptTimer);
          clearTimeout(killTimer);
          if (current === active) current = undefined;
          // Descendants can inherit both pipes after npm exits. Drain briefly, then
          // release both handles so they cannot keep resolution open indefinitely.
          drainTimer = setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
          }, 1000);
        });
        child.once('close', (status) => {
          clearTimeout(deadline);
          clearTimeout(interruptTimer);
          clearTimeout(killTimer);
          clearTimeout(drainTimer);
          if (current === active) current = undefined;
          resolveResult({ status: failed ? null : status, stdout });
        });
        if (signal) active.cancel(signal);
      });
    },
    dispose() {
      process.off('SIGTERM', terminate);
      process.off('SIGHUP', hangup);
      process.off('SIGINT', interrupt);
    },
  };
}
