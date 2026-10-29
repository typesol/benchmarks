// Keep every released compiler's results: results/<version>.json, a copy of results.json as it was committed for
// that @typesol/cli version. results.json stays the latest (what the README, the site and the report read).
//
//   node scripts/archive.ts            copy results.json to results/<version>.json (after a release's run)
//   node scripts/archive.ts --check    fail unless results/<version>.json is that copy (CI)
//
// Only results measured with a published compiler are archived: run.ts and official.ts must both name the same
// `@typesol/cli@<version>` (a TYPESOL_REPO checkout is not a release).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const text = readFileSync(path.join(HERE, "results.json"), "utf8");
const r = JSON.parse(text) as { toolchain?: { typesol?: string }; official?: { toolchain?: { typesol?: string } } };
const run = r.toolchain?.typesol;
const official = r.official?.toolchain?.typesol;
const version = /^@typesol\/cli@(\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(run ?? "")?.[1];
if (!version || official !== run) throw new Error(`results.json is not from one published compiler (run.ts: ${run}, official.ts: ${official})`);
const file = path.join(HERE, "results", `${version}.json`);
if (process.argv.includes("--check")) {
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) {
    console.error(`results/${version}.json is missing or differs from results.json: run node scripts/archive.ts and commit it`);
    process.exit(1);
  }
  console.log(`results/${version}.json matches results.json`);
} else {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(`results/${version}.json written`);
}
