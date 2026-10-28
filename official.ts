// Compute units and binary sizes of the official solana-developers/program-examples programs (Anchor, native Rust,
// Pinocchio; built unmodified by official/build.sh) next to the TypeSOL ports of their Anchor versions.
// Each implementation is driven with its own instruction encoding through the same scenario (official/examples/*.ts);
// the observable outcome (decoded account fields, balances, which accounts exist) must be the same in all four before
// any number of that program is reported.
//
//   official/build.sh && node official.ts [example ...]          (see README)
import { BorshCoder, type Idl } from "@anchor-lang/core";
import { address } from "@solana/kit";
import { LiteSVM } from "litesvm";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Ctx, type Example, IMPLS, type Impl, PORTS, canon } from "./official/lib.ts";
import { build, toolchain } from "./typesol.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY = path.join(HERE, "official/deploy");
export const SOURCE = "solana-developers/program-examples@de09019 (MIT)";

// Not compared: basics/realloc and tokens/pda-mint-authority, whose native and Pinocchio versions do something else than
// the Anchor version (see README).
const NAMES = [
  "account-data",
  "checking-accounts",
  "close-account",
  "counter",
  "create-account",
  "cross-program-invocation",
  "favorites",
  "pda-rent-payer",
  "processing-instructions",
  "program-derived-addresses",
  "transfer-sol",
  "create-token",
  "escrow",
  "transfer-tokens",
  "default-account-state",
  "mint-close-authority",
  "non-transferable",
];

// The TypeSOL builds, once per program: the .so and the IDL coder (also used for the Anchor variant's encodings).
const typesolBuilds = new Map<string, { so: string; coder: BorshCoder }>();
function typesolBuild(port: string, id: string) {
  const k = `${port}@${id}`;
  if (!typesolBuilds.has(k)) {
    const out = mkdtempSync(path.join(os.tmpdir(), "typesol-official-"));
    const res = build(path.join(PORTS, port), out, id);
    typesolBuilds.set(k, { so: res.soPath, coder: new BorshCoder(res.idl as unknown as Idl) });
  }
  return typesolBuilds.get(k)!;
}

async function runOne(ex: Example, impl: Impl) {
  const svm = new LiteSVM(); // builtins, sysvars, SPL Token, Token-2022 and the associated token account program
  for (const e of ex.extra ?? []) svm.addProgramFromFile(e.id, e.so);
  const ids = ex.programs.map((p) => address(p.id));
  const coders: BorshCoder[] = [];
  let size = 0;
  for (const p of ex.programs) {
    const t = typesolBuild(p.port, p.id);
    coders.push(t.coder);
    const so = impl === "typesol" ? t.so : path.join(DEPLOY, ex.name, impl, p.so[impl]);
    if (!existsSync(so)) throw new Error(`missing ${so}: run official/build.sh`);
    svm.addProgramFromFile(address(p.id), so);
    size += statSync(so).size;
  }
  const c = new Ctx(impl, svm, ids, coders);
  const outcome = await ex.scenario(c);
  for (const l of ex.labels) if (!c.cu.get(l)?.length) throw new Error(`${impl}: ${l} was never measured`);
  return { cu: c.cu, size, outcome: canon(outcome), probes: c.probes };
}

type Entry = { cu: Record<string, Record<string, number>>; binaryKb: Record<string, number>; notes?: string };
const mean = (xs: bigint[]) => Math.round(Number(xs.reduce((a, b) => a + b, 0n)) / xs.length);
const only = process.argv.slice(2);
const programs: Record<string, Entry> = {};
const refused: string[] = [];

for (const name of NAMES) {
  if (only.length && !only.includes(name)) continue;
  const ex = (await import(pathToFileURL(path.join(HERE, `official/examples/${name}.ts`)).href)).default as Example;
  const results = new Map<Impl, Awaited<ReturnType<typeof runOne>>>();
  try {
    for (const impl of IMPLS) results.set(impl, await runOne(ex, impl));
  } catch (e) {
    refused.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
    console.error(`\n${name}: NOT REPORTED, a scenario failed\n${(e as Error).message}`);
    continue;
  }
  const outcomes = new Set([...results.values()].map((r) => r.outcome));
  if (outcomes.size !== 1) {
    refused.push(`${name}: the implementations disagree on the outcome`);
    console.error(`\n${name}: NOT REPORTED, the implementations disagree on the outcome\n${[...results].map(([k, r]) => `${k.padEnd(10)} ${r.outcome}`).join("\n")}`);
    continue;
  }
  // Hostile/edge calls whose handling differs between implementations go into the notes.
  const probeNotes: string[] = [];
  const probeNames = [...new Set([...results.values()].flatMap((r) => Object.keys(r.probes)))];
  for (const p of probeNames) {
    const by = (v: string) => IMPLS.filter((i) => results.get(i)!.probes[p] === v);
    const accepted = by("accepted");
    if (accepted.length && accepted.length < IMPLS.length) probeNotes.push(`${p}: accepted by ${accepted.join(", ")}; refused by ${by("refused").join(", ")}.`);
  }
  console.log(`\n${name} (${ex.source}; same outcome in all ${IMPLS.length}; mean compute units per call)`);
  console.log(["instruction".padEnd(40), ...IMPLS.map((i) => i.padStart(10))].join(" "));
  for (const l of ex.labels) console.log([l.padEnd(40), ...IMPLS.map((i) => String(mean(results.get(i)!.cu.get(l)!)).padStart(10))].join(" "));
  console.log(["binary (KB)".padEnd(40), ...IMPLS.map((i) => (results.get(i)!.size / 1024).toFixed(1).padStart(10))].join(" "));
  for (const p of probeNames) console.log(`  ${p}: ${IMPLS.map((i) => `${i} ${results.get(i)!.probes[p] ?? "-"}`).join(", ")}`);
  const notes = [ex.notes, ...probeNotes].filter(Boolean).join(" ");
  programs[name] = {
    source: ex.source,
    cu: Object.fromEntries(ex.labels.map((l) => [l, Object.fromEntries(IMPLS.map((i) => [i, mean(results.get(i)!.cu.get(l)!)]))])),
    binaryKb: Object.fromEntries(IMPLS.map((i) => [i, Number((results.get(i)!.size / 1024).toFixed(1))])),
    ...(notes ? { notes } : {}),
    // Every hostile/edge call and how each implementation handled it ("refused" / "accepted").
    ...(probeNames.length ? { probes: Object.fromEntries(probeNames.map((p) => [p, Object.fromEntries(IMPLS.map((i) => [i, results.get(i)!.probes[p] ?? null]))])) } : {}),
  };
}

if (refused.length) console.error(`\nnot reported:\n  ${refused.join("\n  ")}`);
// Merged into results.json next to what run.ts writes (generated, rounds, programs), which is kept as it is.
// A partial run (example names on the command line) only replaces the programs it ran.
// OFFICIAL_DRY_RUN=1 prints the tables without touching results.json.
const file = path.join(HERE, "results.json");
if (process.env.OFFICIAL_DRY_RUN) process.exit(process.exitCode ?? 0);
const report = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const keep = only.length ? (report.official?.programs ?? {}) : {};
report.official = { source: SOURCE, toolchain: toolchain(), generated: new Date().toISOString(), programs: { ...keep, ...programs } };
// Keep the program order of NAMES.
report.official.programs = Object.fromEntries(NAMES.filter((n) => n in report.official.programs).map((n) => [n, report.official.programs[n]]));
writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
if (refused.length) process.exitCode = 1;
