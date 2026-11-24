import { execFile } from 'node:child_process'

type JiraConnection = {
  ok?: boolean
  result?: {
    activeSiteId?: string
    selectedSiteId?: string
    sites?: { id: string; siteUrl: string }[]
  }
}

export function jiraSiteFromConnection({ ok, result }: JiraConnection): string | undefined {
  if (!ok || !Array.isArray(result?.sites)) return undefined
  const selected = result.activeSiteId || result.selectedSiteId
  const site = selected ? result.sites.find((s) => s.id === selected) : result.sites.length === 1 ? result.sites[0] : undefined
  if (!site?.siteUrl) return undefined
  try {
    const url = new URL(site.siteUrl)
    if (url.protocol === 'https:' && !url.username && !url.password) return url.origin
  } catch {
    return undefined
  }
}

export function readJiraSite(): Promise<string | undefined> {
  const orca = process.env['ORCA_CLI_COMMAND'] || (process.platform === 'linux' ? 'orca-ide' : 'orca')
  return new Promise((resolve) => {
    execFile(orca, ['jira', 'connection', '--environment', 'local', '--json'], {
      timeout: 2500,
      maxBuffer: 128 * 1024,
      windowsHide: true
    }, (error, stdout) => {
      if (error) return resolve(undefined)
      try {
        resolve(jiraSiteFromConnection(JSON.parse(stdout)))
      } catch {
        resolve(undefined)
      }
    })
  })
}
