// Compute units and binary sizes of the same counter, vault and escrow programs in TypeSOL, Anchor, native Rust and Pinocchio.
// Every implementation gets the same transactions; the resulting account data must match before any number is reported.
//
//   scripts/setup.sh && cargo-build-sbf && node run.ts          (see README)
import {
  AccountRole,
  type Address,
  type Instruction,
  type KeyPairSigner,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  createKeyPairSignerFromPrivateKeyBytes,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TYPESOL, build, toolchain } from "./typesol.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The Anchor twins are built in the TypeSOL sources (a TYPESOL_REPO checkout without them falls back to vendor/typesol).
const anchorSo = (name: string) =>
  [TYPESOL, path.join(HERE, "vendor/typesol")].map((r) => path.join(r, `bench/anchor/target/deploy/anchor_${name}.so`)).find((p) => existsSync(p))!;
const SYSTEM = address("11111111111111111111111111111111");
const ANCHOR_IDS: Record<string, Address> = {
  counter: address("EqGyjYr2RHtEV5zQXCPpZ8neqU9tMgmruvuJRW4Pz2aN"),
  vault: address("HVWmZ4JYMsvmLQoZMXDcjoat1GHHfC1GsgQjSjbGFGX"),
  escrow: address("aHbra6ogev5FhFznpsWa1obufi5NkUkHtkGw5hJNuPW"),
};
const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
type Name = "counter" | "vault" | "escrow";
const IMPLS = ["typesol", "anchor", "native", "pinocchio"] as const;
type Impl = (typeof IMPLS)[number];
const ROUNDS = 20;

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

/**
 * The .so of one implementation and the address to load it at. Every implementation runs at the Anchor twin's
 * address (each in its own VM): PDAs, and so the bump search in initialize/open, are then the same for all.
 */
function program(impl: Impl, name: Name): { so: string; id: Address } {
  const id = ANCHOR_IDS[name];
  switch (impl) {
    case "typesol": {
      const out = mkdtempSync(path.join(os.tmpdir(), "typesol-bench-"));
      return { so: build(path.join(TYPESOL, `examples/${name}.ts`), out, id).soPath, id };
    }
    case "anchor":
      return { so: anchorSo(name), id };
    default:
      return { so: path.join(HERE, `target/deploy/${impl}_${name}.so`), id };
  }
}

class Bench {
  readonly cu = new Map<string, bigint[]>();
  readonly svm: LiteSVM;
  readonly id: Address;
  constructor(svm: LiteSVM, id: Address) {
    this.svm = svm;
    this.id = id;
  }

  async send(label: string, payer: KeyPairSigner, data: Buffer, accounts: { address: Address; signer?: KeyPairSigner; writable?: boolean }[]) {
    const ix: Instruction = {
      programAddress: this.id,
      accounts: accounts.map((a) => ({
        address: a.address,
        role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
        ...(a.signer ? { signer: a.signer } : {}),
      })) as Instruction["accounts"],
      data: new Uint8Array(data),
    };
    const tx = await pipe(
      createTransactionMessage({ version: 0 }),
      (t) => setTransactionMessageFeePayerSigner(payer, t),
      (t) => this.svm.setTransactionMessageLifetimeUsingLatestBlockhash(t),
      (t) => appendTransactionMessageInstructions([ix], t),
      (t) => signTransactionMessageWithSigners(t),
    );
    const res = this.svm.sendTransaction(tx);
    this.svm.expireBlockhash();
    if (res instanceof FailedTransactionMetadata) return false;
    this.cu.set(label, [...(this.cu.get(label) ?? []), res.computeUnitsConsumed()]);
    return true;
  }

  async pda(seed: string, key: Address, ...more: Uint8Array[]) {
    const [a] = await getProgramDerivedAddress({ programAddress: this.id, seeds: [seed, getAddressEncoder().encode(key), ...more] });
    return a;
  }
}

// The same wallets in every implementation, so their account data can be compared byte for byte.
// Fixed keys keep the PDA bump search (part of initialize/open) the same from run to run, so published numbers are stable.
const user = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(1));
const other = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(2));

async function setup(impl: Impl, name: Name) {
  const { so, id } = program(impl, name);
  const svm = new LiteSVM(); // builtins, sysvars and the SPL programs (Token among them)
  svm.addProgramFromFile(id, so);
  svm.airdrop(user.address, lamports(100_000_000_000n));
  svm.airdrop(other.address, lamports(100_000_000_000n));
  return { b: new Bench(svm, id), user, other, size: statSync(so).size };
}

function must(ok: boolean, what: string) {
  if (!ok) throw new Error(what);
}

async function counter(impl: Impl) {
  const { b, user, other, size } = await setup(impl, "counter");
  const c = await b.pda("counter", user.address);
  must(await b.send("initialize", user, disc("initialize"), [{ address: user.address, signer: user, writable: true }, { address: c, writable: true }, { address: SYSTEM }]), `${impl} initialize`);
  for (let i = 1n; i <= BigInt(ROUNDS); i++)
    must(await b.send("increment", user, Buffer.concat([disc("increment"), u64(i)]), [{ address: user.address, signer: user }, { address: c, writable: true }]), `${impl} increment`);
  // Someone else may not increment it; nor may anyone overflow it.
  must(!(await b.send("x", other, Buffer.concat([disc("increment"), u64(1n)]), [{ address: other.address, signer: other }, { address: c, writable: true }])), `${impl} accepted a stranger`);
  must(!(await b.send("x", user, Buffer.concat([disc("increment"), u64(2n ** 64n - 1n)]), [{ address: user.address, signer: user }, { address: c, writable: true }])), `${impl} overflowed`);
  const data = b.svm.getAccount(c);
  return { cu: b.cu, size, state: Buffer.from(data.exists ? data.data.subarray(0, 49) : []).toString("hex") };
}

async function vault(impl: Impl) {
  const { b, user, other, size } = await setup(impl, "vault");
  const v = await b.pda("vault", user.address);
  const owner = { address: user.address, signer: user, writable: true };
  must(await b.send("open", user, disc("open"), [owner, { address: v, writable: true }, { address: SYSTEM }]), `${impl} open`);
  for (let i = 1n; i <= BigInt(ROUNDS); i++) {
    must(await b.send("deposit", user, Buffer.concat([disc("deposit"), u64(i * 1_000_000n)]), [owner, { address: v, writable: true }, { address: SYSTEM }]), `${impl} deposit`);
    must(await b.send("withdraw", user, Buffer.concat([disc("withdraw"), u64(i * 400_000n)]), [owner, { address: v, writable: true }]), `${impl} withdraw`);
  }
  must(!(await b.send("x", user, Buffer.concat([disc("withdraw"), u64(10n ** 12n)]), [owner, { address: v, writable: true }])), `${impl} withdrew below rent`);
  must(!(await b.send("x", other, Buffer.concat([disc("withdraw"), u64(1n)]), [{ address: other.address, signer: other, writable: true }, { address: v, writable: true }])), `${impl} paid a stranger`);
  const before = b.svm.getAccount(v);
  const state = Buffer.from(before.exists ? before.data.subarray(0, 57) : []).toString("hex") + `/${before.exists ? before.lamports : 0}`;
  must(await b.send("shut", user, disc("shut"), [owner, { address: v, writable: true }]), `${impl} shut`);
  must(!b.svm.getAccount(v).exists || b.svm.getAccount(v).lamports === 0n, `${impl} vault survived shut`);
  return { cu: b.cu, size, state };
}

// SPL Token state written directly (LiteSVM setAccount): an initialized mint (82 bytes) and token accounts (165).
const key = (a: Address) => Buffer.from(getAddressEncoder().encode(a));
const fixed = async (n: number) => (await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(n))).address;
function putToken(svm: LiteSVM, at: Address, data: Buffer) {
  svm.setAccount({ address: at, data: new Uint8Array(data), executable: false, lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))), programAddress: TOKEN, space: BigInt(data.length) });
}
function mint(svm: LiteSVM, at: Address, authority: Address) {
  const d = Buffer.alloc(82);
  d.writeUInt32LE(1, 0);
  key(authority).copy(d, 4);
  d[44] = 6; // decimals
  d[45] = 1; // initialized
  putToken(svm, at, d);
}
function tokenAccount(svm: LiteSVM, at: Address, mintAddress: Address, owner: Address, amount: bigint) {
  const d = Buffer.alloc(165);
  key(mintAddress).copy(d, 0);
  key(owner).copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  d[108] = 1; // initialized
  putToken(svm, at, d);
}
const tokenAmount = (svm: LiteSVM, at: Address) => {
  const a = svm.getAccount(at);
  return a.exists ? Buffer.from(a.data).readBigUInt64LE(64) : -1n;
};

async function escrow(impl: Impl) {
  const { b, user: maker, other: taker, size } = await setup(impl, "escrow");
  const [mintA, mintB, makerA, makerB, takerA, takerB] = await Promise.all([11, 12, 13, 14, 15, 16].map(fixed));
  mint(b.svm, mintA, maker.address);
  mint(b.svm, mintB, taker.address);
  tokenAccount(b.svm, makerA, mintA, maker.address, 1_000_000n);
  tokenAccount(b.svm, makerB, mintB, maker.address, 0n);
  tokenAccount(b.svm, takerA, mintA, taker.address, 0n);
  tokenAccount(b.svm, takerB, mintB, taker.address, 1_000_000n);
  const w = (a: Address) => ({ address: a, writable: true });
  const makerW = { address: maker.address, signer: maker, writable: true };
  const takerW = { address: taker.address, signer: taker, writable: true };

  // Each offer escrows mint A into a fresh vault (a token account the offer PDA owns), then is taken (odd seeds) or refunded.
  async function open(seed: bigint, amountA: bigint, wantB: bigint) {
    const offer = await b.pda("offer", maker.address, u64(seed));
    const vault = await fixed(Number(40n + seed));
    tokenAccount(b.svm, vault, mintA, offer, 0n);
    const args = Buffer.concat([disc("make"), u64(seed), u64(amountA), u64(wantB), key(mintB)]);
    must(await b.send("make", maker, args, [makerW, w(offer), w(makerA), w(vault), { address: SYSTEM }, { address: TOKEN }]), `${impl} make`);
    return { offer, vault };
  }
  const takeAccounts = (o: { offer: Address; vault: Address }, makerAddress = maker.address) => [takerW, w(makerAddress), w(o.offer), w(takerA), w(takerB), w(makerB), w(o.vault), { address: TOKEN }];
  for (let seed = 1n; seed <= BigInt(ROUNDS); seed++) {
    const o = await open(seed, seed * 1_000n, seed * 300n);
    if (seed % 2n) {
      // A stranger posing as the maker, or a zero-amount offer, is refused.
      must(!(await b.send("x", taker, disc("take"), takeAccounts(o, taker.address))), `${impl} paid a fake maker`);
      must(await b.send("take", taker, disc("take"), takeAccounts(o)), `${impl} take`);
    } else must(await b.send("refund", maker, disc("refund"), [makerW, w(o.offer), w(makerA), w(o.vault), { address: TOKEN }]), `${impl} refund`);
    must(!b.svm.getAccount(o.offer).exists && !b.svm.getAccount(o.vault).exists, `${impl} left the offer or vault open`);
  }
  must(!(await b.send("x", maker, Buffer.concat([disc("make"), u64(999n), u64(0n), u64(1n), key(mintB)]), [makerW, w(await b.pda("offer", maker.address, u64(999n))), w(makerA), w(await fixed(250)), { address: SYSTEM }, { address: TOKEN }])), `${impl} made an empty offer`);
  // One offer left open: its account data is part of the compared state.
  const last = await open(100n, 4_242n, 77n);
  const offerData = b.svm.getAccount(last.offer);
  const balances = [makerA, makerB, takerA, takerB, last.vault].map((a) => tokenAmount(b.svm, a)).join(",");
  return { cu: b.cu, size, state: Buffer.from(offerData.exists ? offerData.data.subarray(0, 161) : []).toString("hex") + `/${balances}` };
}

const mean = (xs: bigint[]) => Math.round(Number(xs.reduce((a, b) => a + b, 0n)) / xs.length);
// Written to results.json, with what compiled the TypeSOL side.
const report: {
  generated: string;
  toolchain: ReturnType<typeof toolchain>;
  rounds: number;
  programs: Record<string, { cu: Record<string, Record<string, number>>; binaryKb: Record<string, number> }>;
} = {
  generated: new Date().toISOString(),
  toolchain: toolchain(),
  rounds: ROUNDS,
  programs: {},
};
for (const [name, run, labels] of [
  ["counter", counter, ["initialize", "increment"]],
  ["vault", vault, ["open", "deposit", "withdraw", "shut"]],
  ["escrow", escrow, ["make", "take", "refund"]],
] as const) {
  const results = new Map<Impl, Awaited<ReturnType<typeof counter>>>();
  for (const impl of IMPLS) results.set(impl, await run(impl));
  const states = new Set([...results.values()].map((r) => r.state));
  if (states.size !== 1) throw new Error(`${name}: implementations disagree on the final account state\n${[...results].map(([k, r]) => `${k} ${r.state}`).join("\n")}`);
  console.log(`\n${name} (same final state in all ${IMPLS.length}; mean compute units per call over ${ROUNDS} rounds)`);
  console.log(["instruction".padEnd(12), ...IMPLS.map((i) => i.padStart(10))].join(" "));
  for (const l of labels) console.log([l.padEnd(12), ...IMPLS.map((i) => String(mean(results.get(i)!.cu.get(l)!)).padStart(10))].join(" "));
  console.log(["binary (KB)".padEnd(12), ...IMPLS.map((i) => (results.get(i)!.size / 1024).toFixed(1).padStart(10))].join(" "));
  report.programs[name] = {
    cu: Object.fromEntries(labels.map((l) => [l, Object.fromEntries(IMPLS.map((i) => [i, mean(results.get(i)!.cu.get(l)!)]))])),
    binaryKb: Object.fromEntries(IMPLS.map((i) => [i, Number((results.get(i)!.size / 1024).toFixed(1))])),
  };
}
// Other top-level keys (the official-examples suite that official.ts merges in) are kept.
const resultsFile = path.join(HERE, "results.json");
const previous = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, "utf8")) : {};
writeFileSync(resultsFile, JSON.stringify({ ...previous, ...report }, null, 2) + "\n");
