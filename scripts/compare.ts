// Compare a fresh results.json with the committed one and fail on any difference in compute units, binary sizes or
// how a hostile call was handled. A clean run reproduces the committed numbers exactly, so a difference means either
// a regression (or improvement) in what was measured, or a results.json that was not updated with the change.
//
//   node scripts/compare.ts <baseline.json> <results.json> [--official]
//
// Without --official only what run.ts writes (programs) is compared; with it, the official examples too.
// The table of differences goes to stdout and, in GitHub Actions, to the job summary.
import { appendFileSync, readFileSync } from "node:fs";

type Entry = { cu: Record<string, Record<string, number>>; binaryKb: Record<string, number>; probes?: Record<string, Record<string, string | null>> };
type Results = { programs: Record<string, Entry>; official?: { programs: Record<string, Entry> } };

const [baseFile, newFile] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!baseFile || !newFile) throw new Error("usage: node scripts/compare.ts <baseline.json> <results.json> [--official]");
const official = process.argv.includes("--official");
const base = JSON.parse(readFileSync(baseFile, "utf8")) as Results;
const fresh = JSON.parse(readFileSync(newFile, "utf8")) as Results;

const rows: string[] = [];
const delta = (a: number, b: number) => (a === 0 ? "" : ` (${b > a ? "+" : ""}${(((b - a) / a) * 100).toFixed(1)}%)`);
function compare(section: string, a: Record<string, Entry> = {}, b: Record<string, Entry> = {}) {
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[name];
    const y = b[name];
    if (!x || !y) {
      rows.push(`| ${section} | ${name} | | ${x ? "reported" : "missing"} | ${y ? "reported" : "missing"} |`);
      continue;
    }
    for (const ix of new Set([...Object.keys(x.cu), ...Object.keys(y.cu)]))
      for (const impl of new Set([...Object.keys(x.cu[ix] ?? {}), ...Object.keys(y.cu[ix] ?? {})])) {
        const p = x.cu[ix]?.[impl];
        const q = y.cu[ix]?.[impl];
        if (p !== q) rows.push(`| ${section} | ${name}.${ix} | ${impl} | ${p ?? "–"} CU | ${q ?? "–"} CU${p && q ? delta(p, q) : ""} |`);
      }
    for (const impl of new Set([...Object.keys(x.binaryKb), ...Object.keys(y.binaryKb)])) {
      const p = x.binaryKb[impl];
      const q = y.binaryKb[impl];
      if (p !== q) rows.push(`| ${section} | ${name} binary | ${impl} | ${p ?? "–"} KB | ${q ?? "–"} KB${p && q ? delta(p, q) : ""} |`);
    }
    for (const probe of new Set([...Object.keys(x.probes ?? {}), ...Object.keys(y.probes ?? {})]))
      for (const impl of new Set([...Object.keys(x.probes?.[probe] ?? {}), ...Object.keys(y.probes?.[probe] ?? {})])) {
        const p = x.probes?.[probe]?.[impl] ?? null;
        const q = y.probes?.[probe]?.[impl] ?? null;
        if (p !== q) rows.push(`| ${section} | ${name}: ${probe} | ${impl} | ${p ?? "–"} | ${q ?? "–"} |`);
      }
  }
}
compare("run.ts", base.programs, fresh.programs);
if (official) compare("official", base.official?.programs, fresh.official?.programs);

const scope = official ? "run.ts and the official examples" : "run.ts";
const report = rows.length
  ? `### Benchmark numbers differ from results.json (${rows.length})\n\n| Suite | What | Implementation | Committed | This run |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n` +
    "Commit the new results.json with the change if this is intended.\n"
  : `### Benchmark numbers match results.json (${scope})\n`;
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
if (rows.length) process.exitCode = 1;
