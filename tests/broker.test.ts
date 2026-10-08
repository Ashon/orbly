import { describe, expect, it } from "vitest";
import { buildCheckCommand, CHECK_NAMES } from "../src/broker/checks.js";
import { filterByCidr, inCidr, parseAnsibleHosts } from "../src/broker/hosts.js";

describe("buildCheckCommand", () => {
  it("정해진 점검만 명령으로 만든다", () => {
    expect(buildCheckCommand("uptime")).toBe("uptime");
    expect(buildCheckCommand("dmesg", { lines: 20 })).toBe("dmesg -T | tail -n 20");
    expect(buildCheckCommand("dmesg")).toBe("dmesg -T | tail -n 50");
    expect(buildCheckCommand("journal", { unit: "kubelet", lines: 10 })).toBe(
      "journalctl -u kubelet -n 10 --no-pager"
    );
    expect(buildCheckCommand("pci_devices")).toBe("lspci -nn");
    expect(buildCheckCommand("pci_devices", { vendor: "10de" })).toBe(
      "lspci -nn -d 10de:"
    );
    expect(CHECK_NAMES).toContain("pci_devices");
  });

  it("줄 수와 유닛 이름을 검증해서 명령 주입을 막는다", () => {
    expect(() => buildCheckCommand("dmesg", { lines: 0 })).toThrow(/lines/);
    expect(() => buildCheckCommand("dmesg", { lines: 501 })).toThrow(/lines/);
    expect(() => buildCheckCommand("dmesg", { lines: 1.5 })).toThrow(/lines/);
    for (const unit of ["kubelet; rm -rf /", "$(id)", "-H", "a b", "x`id`", ""]) {
      expect(() => buildCheckCommand("journal", { unit })).toThrow(/unit/);
    }
    expect(() => buildCheckCommand("service")).toThrow(/unit/);
    for (const vendor of ["10de; id", "10d", "xyzw", "10de:"]) {
      expect(() => buildCheckCommand("pci_devices", { vendor })).toThrow(/vendor/);
    }
  });

  it("유닛이 필요 없는 점검은 unit 인자를 무시한다", () => {
    expect(buildCheckCommand("uptime", { unit: "x; id" })).toBe("uptime");
  });
});

describe("hosts", () => {
  it("CIDR 포함 여부를 계산한다", () => {
    expect(inCidr("192.168.10.11", "192.168.10.0/24")).toBe(true);
    expect(inCidr("192.168.11.11", "192.168.10.0/24")).toBe(false);
    expect(inCidr("192.168.11.11", "192.168.0.0/16")).toBe(true);
    expect(inCidr("8.8.8.8", "192.168.10.0/24")).toBe(false);
    expect(inCidr("192.168.10.256", "192.168.10.0/24")).toBe(false);
    expect(inCidr("web-01", "192.168.10.0/24")).toBe(false);
  });

  it("ansible debug 출력을 파싱하고 허용 대역으로 거른다", () => {
    const output = [
      'web-01 | SUCCESS => {    "ansible_host": "192.168.10.11",    "changed": false}',
      'db-01 | SUCCESS => {    "ansible_host": "192.168.10.21",    "changed": false}',
      'outside | SUCCESS => {    "ansible_host": "192.168.11.1",    "changed": false}',
      "broken | UNREACHABLE! => {}",
    ].join("\n");
    const hosts = parseAnsibleHosts(output);
    expect(hosts.size).toBe(3);
    expect([...filterByCidr(hosts, "192.168.10.0/24").keys()]).toEqual([
      "web-01",
      "db-01",
    ]);
  });
});
