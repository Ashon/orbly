/**
 * Checks that can be run over SSH. All are read-only, and arguments must match fixed formats.
 * The model can only pick a check name and arguments; it cannot run arbitrary commands.
 */
export interface CheckArgs {
  lines?: number;
  unit?: string;
  vendor?: string;
}

interface CheckDef {
  description: string;
  needsUnit?: boolean;
  command(args: { lines: number; unit?: string; vendor?: string }): string;
}

export const CHECKS = {
  uptime: {
    description: "Uptime and load average",
    command: () => "uptime",
  },
  dmesg: {
    description: "Last N lines of the kernel log (dmesg -T)",
    command: ({ lines }) => `dmesg -T | tail -n ${lines}`,
  },
  memory: {
    description: "Memory usage (free -h)",
    command: () => "free -h",
  },
  disk: {
    description: "Filesystem usage (df -h, excluding virtual filesystems)",
    command: () => "df -h -x tmpfs -x devtmpfs -x overlay -x squashfs",
  },
  top: {
    description: "Top CPU-consuming processes (a single top run)",
    command: () => "top -b -n 1 | head -n 25",
  },
  pci_devices: {
    description: "PCI devices (lspci -nn; only that vendor if vendor is given)",
    command: ({ vendor }) => (vendor ? `lspci -nn -d ${vendor}:` : "lspci -nn"),
  },
  failed_units: {
    description: "systemd units in the failed state",
    command: () => "systemctl --failed --no-pager",
  },
  service: {
    description: "systemd unit status (requires unit, e.g. kubelet)",
    needsUnit: true,
    command: ({ unit }) => `systemctl status ${unit} --no-pager -l | head -n 40`,
  },
  journal: {
    description: "Last N lines of a systemd unit log (requires unit)",
    needsUnit: true,
    command: ({ unit, lines }) => `journalctl -u ${unit} -n ${lines} --no-pager`,
  },
} satisfies Record<string, CheckDef>;

export type CheckName = keyof typeof CHECKS;
export const CHECK_NAMES = Object.keys(CHECKS) as [CheckName, ...CheckName[]];

const DEFAULT_LINES = 50;
const MAX_LINES = 500;
const UNIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,99}$/;
const VENDOR_PATTERN = /^[0-9A-Fa-f]{4}$/;

/** Validates the check name and arguments and builds the remote command string. */
export function buildCheckCommand(name: CheckName, args: CheckArgs = {}): string {
  const def: CheckDef = CHECKS[name];
  if (!def) throw new Error(`Unknown check: ${String(name)}`);

  const lines = args.lines ?? DEFAULT_LINES;
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LINES) {
    throw new Error(`lines must be an integer between 1 and ${MAX_LINES}.`);
  }
  if (def.needsUnit) {
    if (!args.unit || !UNIT_PATTERN.test(args.unit)) {
      throw new Error(
        "unit must be a systemd unit name that starts with a letter or digit (e.g. kubelet)."
      );
    }
  }
  if (args.vendor !== undefined && !VENDOR_PATTERN.test(args.vendor)) {
    throw new Error("vendor must be a 4-digit hex PCI vendor ID (e.g. 10de).");
  }
  return def.command({
    lines,
    unit: def.needsUnit ? args.unit : undefined,
    vendor: args.vendor,
  });
}
