import { describe, expect, it } from 'vitest'
import { buildCheckCommand, CHECK_NAMES } from '../src/broker/checks.js'
import { filterByCidr, inCidr, parseAnsibleHosts } from '../src/broker/hosts.js'

describe('buildCheckCommand', () => {
  it('builds commands only for predefined checks', () => {
    expect(buildCheckCommand('uptime')).toBe('uptime')
    expect(buildCheckCommand('dmesg', { lines: 20 })).toBe(
      'dmesg -T | tail -n 20'
    )
    expect(buildCheckCommand('dmesg')).toBe('dmesg -T | tail -n 50')
    expect(buildCheckCommand('journal', { unit: 'kubelet', lines: 10 })).toBe(
      'journalctl -u kubelet -n 10 --no-pager'
    )
    expect(buildCheckCommand('pci_devices')).toBe('lspci -nn')
    expect(buildCheckCommand('pci_devices', { vendor: '10de' })).toBe(
      'lspci -nn -d 10de:'
    )
    expect(CHECK_NAMES).toContain('pci_devices')
  })

  it('validates line counts and unit names to prevent command injection', () => {
    expect(() => buildCheckCommand('dmesg', { lines: 0 })).toThrow(/lines/)
    expect(() => buildCheckCommand('dmesg', { lines: 501 })).toThrow(/lines/)
    expect(() => buildCheckCommand('dmesg', { lines: 1.5 })).toThrow(/lines/)
    for (const unit of [
      'kubelet; rm -rf /',
      '$(id)',
      '-H',
      'a b',
      'x`id`',
      '',
    ]) {
      expect(() => buildCheckCommand('journal', { unit })).toThrow(/unit/)
    }
    expect(() => buildCheckCommand('service')).toThrow(/unit/)
    for (const vendor of ['10de; id', '10d', 'xyzw', '10de:']) {
      expect(() => buildCheckCommand('pci_devices', { vendor })).toThrow(
        /vendor/
      )
    }
  })

  it('ignores the unit argument for checks that do not need a unit', () => {
    expect(buildCheckCommand('uptime', { unit: 'x; id' })).toBe('uptime')
  })
})

describe('hosts', () => {
  it('computes CIDR membership', () => {
    expect(inCidr('192.168.10.11', '192.168.10.0/24')).toBe(true)
    expect(inCidr('192.168.11.11', '192.168.10.0/24')).toBe(false)
    expect(inCidr('192.168.11.11', '192.168.0.0/16')).toBe(true)
    expect(inCidr('8.8.8.8', '192.168.10.0/24')).toBe(false)
    expect(inCidr('192.168.10.256', '192.168.10.0/24')).toBe(false)
    expect(inCidr('web-01', '192.168.10.0/24')).toBe(false)
  })

  it('parses ansible debug output and filters by the allowed range', () => {
    const output = [
      'web-01 | SUCCESS => {    "ansible_host": "192.168.10.11",    "changed": false}',
      'db-01 | SUCCESS => {    "ansible_host": "192.168.10.21",    "changed": false}',
      'outside | SUCCESS => {    "ansible_host": "192.168.11.1",    "changed": false}',
      'broken | UNREACHABLE! => {}',
    ].join('\n')
    const hosts = parseAnsibleHosts(output)
    expect(hosts.size).toBe(3)
    expect([...filterByCidr(hosts, '192.168.10.0/24').keys()]).toEqual([
      'web-01',
      'db-01',
    ])
  })
})
