import { readFileSync } from "node:fs";

export function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    value = value * 256 + n;
  }
  return value;
}

/** ip 가 cidr(예: 192.168.10.0/24) 안에 있는지 */
export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  const ipValue = ipv4ToInt(ip);
  const baseValue = base ? ipv4ToInt(base) : undefined;
  if (ipValue === undefined || baseValue === undefined) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(ipValue / size) === Math.floor(baseValue / size);
}

/**
 * `ansible -m debug -a var=ansible_host -o` 출력에서 호스트별 주소를 뽑는다.
 * 예: web-01 | SUCCESS => {    "ansible_host": "192.168.10.11",    "changed": false}
 */
export function parseAnsibleHosts(output: string): Map<string, string> {
  const hosts = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^(\S+) \| SUCCESS => .*"ansible_host":\s*"([^"]+)"/.exec(line);
    if (match) hosts.set(match[1]!, match[2]!);
  }
  return hosts;
}

/** 허용 대역 안의 호스트만 남긴다. */
export function filterByCidr(
  hosts: Map<string, string>,
  cidr: string
): Map<string, string> {
  return new Map([...hosts].filter(([, ip]) => inCidr(ip, cidr)));
}

/** hosts.json ({ "web-01": "192.168.10.11" }) 을 읽고 허용 대역으로 다시 거른다. */
export function loadHostMap(file: string, cidr: string): Map<string, string> {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const hosts = new Map<string, string>();
  for (const [name, ip] of Object.entries(raw)) {
    if (typeof ip === "string") hosts.set(name, ip);
  }
  return filterByCidr(hosts, cidr);
}
