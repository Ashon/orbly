/**
 * Slack's Web API. GovSlack workspaces use https://slack-gov.com/api/ instead.
 */
export const DEFAULT_SLACK_API_URL = 'https://slack.com/api/'

/**
 * https, or http only for a server on this computer (a local Slack stand-in for
 * end-to-end tests)
 */
export function isSecureOrLocalUrl(value: string): boolean {
  return (
    /^https:\/\//.test(value) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(value)
  )
}

/** The Web API base with the trailing slash the Slack clients expect */
export function slackApiBase(url: string | undefined): string {
  return url ? `${url.replace(/\/+$/, '')}/` : DEFAULT_SLACK_API_URL
}

/**
 * Where the workspace's private files are served, the only place the hub
 * fetches files from: files.slack.com for slack.com, files.<host> for GovSlack,
 * and a local stand-in's own address.
 */
export function slackFilesOrigin(
  apiUrl: string = DEFAULT_SLACK_API_URL
): string {
  const url = new URL(apiUrl)
  return url.protocol === 'https:'
    ? `https://files.${url.hostname}`
    : url.origin
}
