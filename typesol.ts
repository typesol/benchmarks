// Where the TypeSOL side of every comparison comes from.
//
// By default: the compiler from npm (`@typesol/cli`, the exact version in package.json) and the TypeSOL programs (the
// examples, the ports of the official examples, the Anchor twins) from the TypeSOL repository at that version's tag,
// which `scripts/setup.sh` puts in vendor/typesol. So a result names one released compiler and the sources it compiled.
//
// TYPESOL_REPO=<checkout> measures unreleased work instead: that checkout's compiler (its dist/, built) and sources.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Compiler = typeof import("@typesol/cli/compiler");

export const FROM_CHECKOUT = process.env.TYPESOL_REPO !== undefined;
/** The TypeSOL sources: examples/, test/ports/, test/programs/, bench/anchor/. */
export const TYPESOL = path.resolve(process.env.TYPESOL_REPO ?? path.join(HERE, "vendor/typesol"));
export const { build } = (
  FROM_CHECKOUT ? await import(pathToFileURL(path.join(TYPESOL, "dist/compiler/index.js")).href) : await import("@typesol/cli/compiler")
) as Compiler;

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
/** What the numbers were measured with, recorded next to them. */
export function toolchain() {
  return {
    typesol: COMPILER,
    anchorLang: crate(path.join(TYPESOL, "bench/anchor/Cargo.lock"), "anchor-lang") ?? crate(path.join(HERE, "vendor/typesol/bench/anchor/Cargo.lock"), "anchor-lang"),
    pinocchio: crate(path.join(HERE, "Cargo.lock"), "pinocchio"),
    solanaProgram: crate(path.join(HERE, "Cargo.lock"), "solana-program"),
    cargoBuildSbf: firstLines("cargo-build-sbf --version"),
    node: process.version,
  };
}
