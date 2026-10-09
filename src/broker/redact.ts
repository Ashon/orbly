/**
 * Redacts common secret formats mixed into tool output. Answers go to public
 * channels, so this is the last line of defense. Access restrictions (file deny
 * rules, RBAC) are the primary defense; this reduces what slips past them.
 */
const PATTERNS: [RegExp, string][] = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[REDACTED PRIVATE KEY]',
  ],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED SLACK TOKEN]'],
  [/\bxapp-\d-[A-Za-z0-9-]{10,}/g, '[REDACTED SLACK APP TOKEN]'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, '[REDACTED ANTHROPIC KEY]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED API KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED GITHUB TOKEN]'],
  // fine-grained PAT (github_pat_<22 chars>_<59 chars>)
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED GITHUB TOKEN]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[REDACTED GITLAB TOKEN]'],
  [/\bATATT[A-Za-z0-9_=-]{20,}/g, '[REDACTED ATLASSIAN TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    '[REDACTED JWT]',
  ],
  [
    /((?:client-key-data|client-certificate-data|token|password|passwd|secret)\s*[:=]\s*)["']?[^\s"']{8,}["']?/gi,
    '$1[REDACTED]',
  ],
]

export function redactSecrets(text: string): string {
  return PATTERNS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    text
  )
}
