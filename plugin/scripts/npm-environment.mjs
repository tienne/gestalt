import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import process from 'node:process';
import { dirname, join } from 'node:path';

// Registry settings may deliberately use a provider token. Preserve referenced
// names before filtering known credentials; native-build and network settings pass through.
export function npmEnvironment(source) {
  const env = { ...source };
  const find = (name) => Object.keys(env).find((key) => key.toLowerCase() === name);
  const get = (name) => {
    const key = find(name);
    return key === undefined ? undefined : env[key];
  };
  const referenced = new Set();
  // Match npm's optional references and escaped dollar signs in configuration.
  const envExpr = /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g;
  const collect = (text) => {
    for (const match of text.matchAll(envExpr)) {
      if (match[1].length % 2 === 0) referenced.add(match[2].toLowerCase());
    }
  };
  const expand = (path) =>
    path.replace(envExpr, (whole, escapes, key, optional) => {
      if (escapes.length % 2) return whole.slice((escapes.length + 1) / 2);
      const value = env[key] ?? (optional ? '' : '${' + key + '}');
      return escapes.slice(escapes.length / 2) + value;
    });
  const home = get('home') ?? get('userprofile') ?? homedir();
  const files = [
    get('npm_config_userconfig') ?? join(home, '.npmrc'),
    get('npm_config_globalconfig') ??
      join(get('npm_config_prefix') ?? dirname(dirname(process.execPath)), 'etc/npmrc'),
  ];
  for (const file of files) {
    try {
      const text = readFileSync(expand(file).replace(/^~(?=[/\\])/, home), 'utf8');
      collect(
        text
          .split('\n')
          .filter((line) => !/^\s*[#;]/.test(line))
          .join('\n'),
      );
    } catch {
      // Missing/unreadable npm settings are handled by npm itself.
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (/^npm_config_/i.test(key)) collect(value);
  }
  for (const key of Object.keys(env)) {
    if (/^npm_|^node_auth_token$/i.test(key) || referenced.has(key.toLowerCase())) continue;
    if (
      /^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|GEMINI_|CODEX_|XAI_|GROK_|GOOGLE_API_KEY$|AWS_ACCESS_KEY_ID$|AWS_SECRET_ACCESS_KEY$|AWS_SESSION_TOKEN$|GH_TOKEN$|GITHUB_TOKEN$)/i.test(
        key,
      ) ||
      /(_API_KEY|_SECRET|_SECRET_KEY|_CLIENT_SECRET|_PASSWORD|_ACCESS_TOKEN|_AUTH_TOKEN|_BOT_TOKEN)$|^HF_TOKEN$/i.test(
        key,
      )
    )
      delete env[key];
  }
  return env;
}
