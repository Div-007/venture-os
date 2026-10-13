// Runs every live check against the local Venture OS dev servers and prints one summary.
//   node tooling/sales-qa/run-all.mjs [--no-shots]
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const steps = [
  ["API flow (every role)", "flow.mjs", []],
  ["Claude connector flow", "mcp-flow.mjs", []],
  ["Click-through, desktop", "ui-flow.mjs", []],
  ["Click-through, phone", "ui-flow.mjs", ["--phone"]],
  ["WhatsApp consent (Claude logs, person confirms)", "consent-flow.mjs", []],
  ...(process.argv.includes("--no-shots") ? [] : [["Screenshots, all pages", "shots.mjs", []]]),
];
const summary = [];
for (const [label, script, args] of steps) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(process.execPath, [join(here, script), ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 15 * 60_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output.split("\n").filter((line) => /^(FAIL|PASS)|checks passed|check\(s\) failed|shots:|\| [a-z-]+ \|/.test(line) && !/^PASS/.test(line)).join("\n") + "\n");
  summary.push(`${result.status === 0 ? "ok  " : "FAIL"}  ${label}`);
}
// The checks create and delete QA leads; this removes them for good with their drafts, sends, notices and reminders, so the dev
// dashboard (and everyone's daily send cap) shows only real work. Runs from the Venture OS repo root (two folders up).
const vso = join(here, "..", "..");
process.stdout.write("\n=== Clean up QA records ===\n");
const purge = spawnSync(process.execPath, ["--env-file=.env", "node_modules/tsx/dist/cli.mjs", "apps/api/scripts/clean-sales-dev.ts", "--qa", "--no-backup"], { cwd: vso, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 5 * 60_000 });
process.stdout.write(`${purge.stdout ?? ""}${(purge.stderr ?? "").split("\n").filter((line) => line && !/warning/i.test(line)).join("\n")}\n`);
summary.push(`${purge.status === 0 ? "ok  " : "FAIL"}  Clean up QA records`);
console.log(`\n${summary.join("\n")}`);
process.exit(summary.some((line) => line.startsWith("FAIL")) ? 1 : 0);
