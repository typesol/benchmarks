// Where the TypeSOL side of every comparison comes from.
//
// By default: the compiler from npm (`@typesol/cli`, the exact version in package.json) and the TypeSOL programs (the
// examples, the ports of the official examples, the Anchor twins) from the TypeSOL repository at that version's tag,
// which `scripts/setup.sh` puts in vendor/typesol. So a result names one released compiler and the sources it compiled.
//
// TYPESOL_REPO=<checkout> measures unreleased work instead: that checkout's compiler (its dist/, built) and sources.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Compiler = typeof import("@typesol/cli/compiler");

/** The Anchor twins in a TypeSOL checkout: test/anchor-twins since 0.25.1, bench/anchor before. */
export const twinsOf = (root: string) => [path.join(root, "test/anchor-twins"), path.join(root, "bench/anchor")].find((d) => existsSync(d)) ?? path.join(root, "test/anchor-twins");
export const FROM_CHECKOUT = process.env.TYPESOL_REPO !== undefined;
/** The TypeSOL sources: examples/, test/ports/, test/programs/, test/anchor-twins/ (bench/anchor/ up to 0.25.0). */
export const TYPESOL = path.resolve(process.env.TYPESOL_REPO ?? path.join(HERE, "vendor/typesol"));
const compiler = (
  FROM_CHECKOUT ? await import(pathToFileURL(path.join(TYPESOL, "dist/compiler/index.js")).href) : await import("@typesol/cli/compiler")
) as Compiler;
/** How the TypeSOL programs were compiled, from the first build's manifest (the same for every program of a run). */
let compiled: { clang: string; sbpf: string; profile: boolean; runtimeSha256: string | null } | null = null;
export const build: Compiler["build"] = (...args) => {
  const res = compiler.build(...args);
  const m = res.manifest;
  compiled ??= { clang: m.clang, sbpf: m.sbpf, profile: m.profile, runtimeSha256: m.sources["<runtime>/typesol_rt.h"] ?? null };
  return res;
};

const version = (pkg: string) => (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
/** What compiled the TypeSOL programs, recorded with the results. */
export const COMPILER = FROM_CHECKOUT
  ? `checkout ${version(path.join(TYPESOL, "package.json"))}+ (TYPESOL_REPO)`
  : `@typesol/cli@${version(createRequire(import.meta.url).resolve("@typesol/cli/package.json"))}`;

const crate = (lock: string, name: string): string | null => {
  try {
    return readFileSync(lock, "utf8").match(new RegExp(`name = "${name}"\\nversion = "([^"]+)"`))?.[1] ?? null;
  } catch {
    return null;
  }
};
const firstLines = (cmd: string): string | null => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").join(", ");
  } catch {
    return null;
  }
};
const sha256 = (file: string): string | null => {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};
/** What the numbers were measured with, recorded next to them. */
export function toolchain() {
  return {
    typesol: COMPILER,
    // The commit of the TypeSOL sources (the tag's commit for a released version).
    typesolCommit: firstLines(`git -C "${TYPESOL}" rev-parse HEAD`),
    // The C toolchain, SBPF version and runtime header the TypeSOL programs were built with (TypeSOL always compiles
    // at -O2; the flags are fixed per compiler version). A getter: read when results.json is written, after the builds.
    get typesolBuild() {
      return compiled;
    },
    anchorLang: crate(path.join(twinsOf(TYPESOL), "Cargo.lock"), "anchor-lang") ?? crate(path.join(twinsOf(path.join(HERE, "vendor/typesol")), "Cargo.lock"), "anchor-lang"),
    pinocchio: crate(path.join(HERE, "Cargo.lock"), "pinocchio"),
    // Metaplex Token Metadata, which the token ports call (scripts/setup.sh dumps it from mainnet-beta).
    tokenMetadataSha256: sha256(path.join(TYPESOL, "test/programs/mpl_token_metadata.so")),
    solanaProgram: crate(path.join(HERE, "Cargo.lock"), "solana-program"),
    cargoBuildSbf: firstLines("cargo-build-sbf --version"),
    node: process.version,
  };
}
