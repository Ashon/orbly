import { readFileSync } from 'node:fs'

export function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const n = Number(part)
    if (n > 255) return undefined
    value = value * 256 + n
  }
  return value
}

/** Whether ip falls within cidr (e.g. 192.168.10.0/24) */
export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/')
  const bits = Number(bitsText)
  const ipValue = ipv4ToInt(ip)
  const baseValue = base ? ipv4ToInt(base) : undefined
  if (ipValue === undefined || baseValue === undefined) return false
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const size = 2 ** (32 - bits)
  return Math.floor(ipValue / size) === Math.floor(baseValue / size)
}

/**
 * Extracts each host's address from `ansible -m debug -a var=ansible_host -o`
 * output. Example: web-01 | SUCCESS => { "ansible_host": "192.168.10.11",
 * "changed": false}
 */
export function parseAnsibleHosts(output: string): Map<string, string> {
  const hosts = new Map<string, string>()
  for (const line of output.split('\n')) {
    const match = /^(\S+) \| SUCCESS => .*"ansible_host":\s*"([^"]+)"/.exec(
      line
    )
    if (match) hosts.set(match[1]!, match[2]!)
  }
  return hosts
}

/** Keeps only hosts within the allowed CIDR range. */
export function filterByCidr(
  hosts: Map<string, string>,
  cidr: string
): Map<string, string> {
  return new Map([...hosts].filter(([, ip]) => inCidr(ip, cidr)))
}

/**
 * Reads hosts.json ({ "web-01": "192.168.10.11" }) and filters it again by the
 * allowed CIDR range.
 */
export function loadHostMap(file: string, cidr: string): Map<string, string> {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const hosts = new Map<string, string>()
  for (const [name, ip] of Object.entries(raw)) {
    if (typeof ip === 'string') hosts.set(name, ip)
  }
  return filterByCidr(hosts, cidr)
}
