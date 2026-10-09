// Turns the end-to-end coverage summary (pnpm test:e2e:coverage) into what CI shows:
// - coverage/e2e/badge.json: a shields.io endpoint badge, published to the badges branch on pushes to main
// - stdout: a Markdown table per folder, for the job summary
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const dir = path.resolve(process.argv[2] ?? "coverage/e2e");
const summary = JSON.parse(readFileSync(path.join(dir, "coverage-summary.json"), "utf8"));
const root = process.cwd();

const color = (pct) =>
  pct >= 90
    ? "brightgreen"
    : pct >= 80
      ? "green"
      : pct >= 70
        ? "yellowgreen"
        : pct >= 60
          ? "yellow"
          : pct >= 50
            ? "orange"
            : "red";

const total = summary.total;
writeFileSync(
  path.join(dir, "badge.json"),
  `${JSON.stringify({
    schemaVersion: 1,
    label: "e2e coverage",
    message: `${total.lines.pct.toFixed(1)}%`,
    color: color(total.lines.pct),
  })}\n`
);

// Folder totals, from the per-file entries
const folders = new Map();
for (const [file, entry] of Object.entries(summary)) {
  if (file === "total") continue;
  const folder = path.dirname(path.relative(root, file));
  const sum = folders.get(folder) ?? { lines: [0, 0], branches: [0, 0], functions: [0, 0] };
  for (const key of ["lines", "branches", "functions"]) {
    sum[key][0] += entry[key].covered;
    sum[key][1] += entry[key].total;
  }
  folders.set(folder, sum);
}
const pct = ([covered, all]) => (all === 0 ? "-" : `${((covered / all) * 100).toFixed(1)}%`);
const rows = [...folders.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([folder, sum]) => `| \`${folder}\` | ${pct(sum.lines)} | ${pct(sum.branches)} | ${pct(sum.functions)} |`);
process.stdout.write(
  [
    "### End-to-end coverage (bot and team hub)",
    "",
    "| Folder | Lines | Branches | Functions |",
    "| --- | --- | --- | --- |",
    ...rows,
    `| **Total** | **${total.lines.pct.toFixed(1)}%** | **${total.branches.pct.toFixed(1)}%** | **${total.functions.pct.toFixed(1)}%** |`,
    "",
  ].join("\n")
);
