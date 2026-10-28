// Layout experiment: the same Profile account and transactions on three programs.
//   fixed  — TypeSOL today (FixedString / FixedVec / Option at fixed offsets)
//   anchor-layout — what TypeSOL would emit for Anchor's Borsh-packed layout (hand-written C, profile_anchor.c)
//   anchor — Anchor 1.0.2 itself
// The anchor-layout and Anchor accounts must be byte-identical after every step; the fixed one must hold the same values.
import {
  AccountRole,
  type Address,
  type Instruction,
  type KeyPairSigner,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
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
import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID = address("EaiwmXTVEwU6sh1wAizeXHmPkHS4s6HaHr4EX3vZ6kJq");
const SYSTEM = address("11111111111111111111111111111111");
const IMPLS = {
  "typesol (fixed)": path.join(HERE, "profile_fixed.so"),
  "pinocchio (fixed)": path.join(HERE, "rust/target/deploy/pinocchio_profile_fixed.so"),
  "anchor zero-copy": path.join(HERE, "anchor/target/deploy/anchor_profile_zc.so"),
  "typesol (anchor layout)": path.join(HERE, "profile_anchor.so"),
  "typesol (@layout borsh)": path.join(HERE, "profile_borsh.so"),
  "pinocchio (borsh)": path.join(HERE, "rust/target/deploy/pinocchio_profile_borsh.so"),
  "native (borsh)": path.join(HERE, "rust/target/deploy/native_profile.so"),
  anchor: path.join(HERE, "anchor/target/deploy/anchor_profile.so"),
} as const;
const FIXED = ["typesol (fixed)", "pinocchio (fixed)", "anchor zero-copy"] as const;
const isFixed = (i: string) => (FIXED as readonly string[]).includes(i);
type Impl = keyof typeof IMPLS;

const disc = (n: string) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const str = (s: string) => {
  const b = Buffer.from(s);
  const l = Buffer.alloc(4);
  l.writeUInt32LE(b.length);
  return Buffer.concat([l, b]);
};

/** The decoded values of either layout. */
function decode(impl: string, d: Uint8Array) {
  const b = Buffer.from(d);
  const owner = b.subarray(8, 40).toString("hex");
  if (isFixed(impl)) {
    // owner 32 | bump 1 | name u32+32 | tags u32+8*8 | badge u8+u64 | score | updated
    const nameLen = b.readUInt32LE(41);
    const name = b.subarray(45, 45 + nameLen).toString();
    const tagsLen = b.readUInt32LE(77);
    const tags = Array.from({ length: tagsLen }, (_, i) => b.readBigUInt64LE(81 + 8 * i));
    const badge = b[145] ? b.readBigUInt64LE(146) : null;
    return { owner, bump: b[40], name, tags, badge, score: b.readBigUInt64LE(154), updated: b.readBigInt64LE(162) };
  }
  let at = 41;
  const nameLen = b.readUInt32LE(at);
  const name = b.subarray(at + 4, at + 4 + nameLen).toString();
  at += 4 + nameLen;
  const tagsLen = b.readUInt32LE(at);
  const tags = Array.from({ length: tagsLen }, (_, i) => b.readBigUInt64LE(at + 4 + 8 * i));
  at += 4 + 8 * tagsLen;
  const badge = b[at] ? b.readBigUInt64LE(at + 1) : null;
  at += b[at] ? 9 : 1;
  return { owner, bump: b[40], name, tags, badge, score: b.readBigUInt64LE(at), updated: b.readBigInt64LE(at + 8) };
}

/** One step of the scenario: instruction name, data after the discriminator, and whether it is read-only. */
type Step = { label: string; ix: string; data: Buffer; read?: boolean };
const longName = "alexander-the-great-of-macedon"; // 30 bytes
const scenario: Step[] = [
  { label: "create", ix: "create", data: str("alice") },
  { label: "bump (empty lists)", ix: "bump", data: u64(5n) },
  { label: "addTag #1", ix: "add_tag", data: u64(10n) },
  { label: "addTag #2", ix: "add_tag", data: u64(20n) },
  { label: "addTag #3", ix: "add_tag", data: u64(30n) },
  { label: "bump (3 tags)", ix: "bump", data: u64(1n) },
  { label: "setBadge Some", ix: "set_badge", data: Buffer.concat([Buffer.from([1]), u64(7n)]) },
  { label: "rename longer", ix: "rename", data: str(longName) },
  { label: "bump (long name)", ix: "bump", data: u64(1n) },
  { label: "rename shorter", ix: "rename", data: str("al") },
  { label: "setBadge None", ix: "set_badge", data: Buffer.from([0]) },
  ...[40n, 50n, 60n, 70n, 80n].map((t, i) => ({ label: `addTag #${4 + i}`, ix: "add_tag", data: u64(t) })),
  { label: "bump (8 tags)", ix: "bump", data: u64(1n) },
  { label: "rename (8 tags)", ix: "rename", data: str(longName) },
  { label: "total (8 tags)", ix: "total", data: Buffer.alloc(0), read: true },
];

async function run(impl: Impl, owner: KeyPairSigner, svm: LiteSVM) {
  svm.addProgramFromFile(ID, IMPLS[impl]);
  svm.airdrop(owner.address, lamports(10_000_000_000n));
  const [profile] = await getProgramDerivedAddress({ programAddress: ID, seeds: ["profile", getAddressEncoder().encode(owner.address)] });
  const out: { label: string; cu: number; data: Uint8Array; ret?: bigint }[] = [];
  for (const s of scenario) {
    const accounts =
      s.ix === "create"
        ? [
            { address: owner.address, role: AccountRole.WRITABLE_SIGNER, signer: owner },
            { address: profile, role: AccountRole.WRITABLE },
            { address: SYSTEM, role: AccountRole.READONLY },
          ]
        : s.read
          ? [{ address: profile, role: AccountRole.READONLY }]
          : [
              { address: owner.address, role: AccountRole.READONLY_SIGNER, signer: owner },
              { address: profile, role: AccountRole.WRITABLE },
            ];
    const ix = { programAddress: ID, accounts, data: new Uint8Array(Buffer.concat([disc(s.ix), s.data])) } as unknown as Instruction;
    const tx = await pipe(
      createTransactionMessage({ version: 0 }),
      (t) => setTransactionMessageFeePayerSigner(owner, t),
      (t) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(t),
      (t) => appendTransactionMessageInstructions([ix], t),
      (t) => signTransactionMessageWithSigners(t),
    );
    const res = svm.sendTransaction(tx);
    svm.expireBlockhash();
    if (res instanceof FailedTransactionMetadata) throw new Error(`${impl} ${s.label}: ${res.err()} ${res.meta().logs().join("\n")}`);
    const acct = svm.getAccount(profile);
    if (!acct.exists) throw new Error("no profile");
    const rd = res.returnData().data();
    out.push({ label: s.label, cu: Number(res.computeUnitsConsumed()), data: acct.data, ret: rd.length ? Buffer.from(rd).readBigUInt64LE(0) : undefined });
  }
  return out;
}

const owner = await generateKeyPairSigner();
const results = {} as Record<Impl, Awaited<ReturnType<typeof run>>>;
for (const impl of Object.keys(IMPLS) as Impl[]) results[impl] = await run(impl, owner, new LiteSVM());

// Checks: within each layout the account bytes are identical after every step; across all, values and return data.
const impls = Object.keys(IMPLS) as Impl[];
const j = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
for (const [i, s] of scenario.entries()) {
  const ref = { fixed: results["typesol (fixed)"][i]!, borsh: results.anchor[i]! };
  for (const k of impls) {
    const r = results[k][i]!;
    const same = isFixed(k) ? ref.fixed : ref.borsh;
    if (Buffer.compare(Buffer.from(r.data), Buffer.from(same.data)) !== 0) throw new Error(`${s.label}: ${k} bytes differ from its layout's reference`);
    if (j(decode(k, r.data)) !== j(decode("anchor", ref.borsh.data))) throw new Error(`${s.label}: ${k} values differ`);
    if (r.ret !== ref.borsh.ret) throw new Error(`${s.label}: ${k} return data differs`);
  }
}

const short: Record<Impl, string> = {
  "typesol (fixed)": "TS fixed",
  "pinocchio (fixed)": "Pino fixed",
  "anchor zero-copy": "Anchor ZC",
  "typesol (anchor layout)": "TS hand-C",
  "typesol (@layout borsh)": "TS borsh",
  "pinocchio (borsh)": "Pino borsh",
  "native (borsh)": "Native",
  anchor: "Anchor",
};
const rows = scenario.map((s, i) => ({ step: s.label, ...Object.fromEntries(impls.map((k) => [k, results[k][i]!.cu])) }));
console.log("step".padEnd(20), ...impls.map((k) => short[k].padStart(11)));
for (const r of rows) console.log(r.step.padEnd(20), ...impls.map((k) => String((r as Record<string, unknown>)[k]).padStart(11)));
const kb = (f: string) => (statSync(f).size / 1024).toFixed(1);
console.log("binary KB".padEnd(20), ...impls.map((k) => kb(IMPLS[k]).padStart(11)));
console.log("checks: bytes identical within each layout after every step; values and return data equal across all");
writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ generated: new Date().toISOString(), rows, binaryKb: Object.fromEntries(impls.map((k) => [k, Number(kb(IMPLS[k]))])) }, null, 2));
