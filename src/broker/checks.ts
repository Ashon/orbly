/**
 * SSH 로 실행할 수 있는 점검 목록. 모두 읽기 전용이고, 인자는 정해진 형식만 받는다.
 * 모델은 점검 이름과 인자만 고를 수 있고 임의 명령은 실행할 수 없다.
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
    description: "가동 시간과 load average",
    command: () => "uptime",
  },
  dmesg: {
    description: "커널 로그(dmesg -T) 최근 N줄",
    command: ({ lines }) => `dmesg -T | tail -n ${lines}`,
  },
  memory: {
    description: "메모리 사용량 (free -h)",
    command: () => "free -h",
  },
  disk: {
    description: "파일시스템 사용량 (df -h, 가상 파일시스템 제외)",
    command: () => "df -h -x tmpfs -x devtmpfs -x overlay -x squashfs",
  },
  top: {
    description: "CPU 사용 상위 프로세스 (top 한 번)",
    command: () => "top -b -n 1 | head -n 25",
  },
  pci_devices: {
    description: "PCI 장치 목록 (lspci -nn, vendor 를 주면 그 벤더만)",
    command: ({ vendor }) => (vendor ? `lspci -nn -d ${vendor}:` : "lspci -nn"),
  },
  failed_units: {
    description: "실패 상태인 systemd 유닛",
    command: () => "systemctl --failed --no-pager",
  },
  service: {
    description: "systemd 유닛 상태 (unit 필요, 예: kubelet)",
    needsUnit: true,
    command: ({ unit }) => `systemctl status ${unit} --no-pager -l | head -n 40`,
  },
  journal: {
    description: "systemd 유닛 로그 최근 N줄 (unit 필요)",
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

/** 점검 이름과 인자를 검증해서 원격 명령 문자열을 만든다. */
export function buildCheckCommand(name: CheckName, args: CheckArgs = {}): string {
  const def: CheckDef = CHECKS[name];
  if (!def) throw new Error(`알 수 없는 점검입니다: ${String(name)}`);

  const lines = args.lines ?? DEFAULT_LINES;
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LINES) {
    throw new Error(`lines 는 1-${MAX_LINES} 사이 정수여야 합니다.`);
  }
  if (def.needsUnit) {
    if (!args.unit || !UNIT_PATTERN.test(args.unit)) {
      throw new Error(
        "unit 은 영문/숫자로 시작하는 systemd 유닛 이름이어야 합니다. (예: kubelet)"
      );
    }
  }
  if (args.vendor !== undefined && !VENDOR_PATTERN.test(args.vendor)) {
    throw new Error("vendor 는 16진수 4자리 PCI 벤더 ID 여야 합니다. (예: 10de)");
  }
  return def.command({
    lines,
    unit: def.needsUnit ? args.unit : undefined,
    vendor: args.vendor,
  });
}
