import { execFileSync } from 'node:child_process';

export type SshHostResolver = (alias: string) => string | null;

// `ssh -G`는 ~/.ssh/config를 풀어 실제 접속 설정을 찍기만 하고 접속하지 않는다
const defaultSshHost: SshHostResolver = (alias) => {
  try {
    const out = execFileSync('ssh', ['-G', alias], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    const m = /^hostname\s+(\S+)/m.exec(out);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
};

const SSH_REMOTE_RE = /^(ssh:\/\/)?([\w.-]+@)?([\w.-]+)([:/])(.+)$/;

/**
 * SSH 호스트 별칭(`git@github-work:owner/name.git`)을 실제 호스트로 바꾼 원격 주소.
 * 계정을 여럿 쓰는 사람은 별칭을 두는 게 흔한데, 주소에 github.com이 없다고 원격 없음으로 보면
 * 레포 간 참조 검사를 통째로 건너뛴다. 별칭이 아니거나 못 풀면 받은 주소를 그대로 돌려준다.
 */
export function resolveRemoteUrl(url: string, sshHost: SshHostResolver = defaultSshHost): string {
  if (/github\.com/i.test(url) || /^[a-z]+:\/\/(?!.*@)/i.test(url) || /^https?:/i.test(url)) {
    return url;
  }
  const m = SSH_REMOTE_RE.exec(url);
  if (!m || (!m[1] && !m[2])) return url;
  const host = sshHost(m[3]!);
  if (!host || host === m[3]) return url;
  return `${m[1] ?? ''}${m[2] ?? ''}${host}${m[4]}${m[5]}`;
}
