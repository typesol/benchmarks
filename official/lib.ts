// Shared harness for official.ts: one Ctx per (example, implementation), each in its own LiteSVM.
import { BorshCoder, type Idl } from "@anchor-lang/core";
import { getCreateAccountInstruction } from "@solana-program/system";
import { getMintDecoder, getTokenDecoder } from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import {
  AccountRole,
  type Address,
  type Instruction,
  type KeyPairSigner,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM, type TransactionMetadata } from "litesvm";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { TYPESOL } from "../typesol.ts";

// The ports' sources come from the TypeSOL sources (typesol.ts), or TYPESOL_PORTS; they mirror the upstream paths
// (basics/counter.ts, …).
export const PORTS = path.resolve(process.env.TYPESOL_PORTS ?? path.join(TYPESOL, "test/ports"));
/** Metaplex Token Metadata, as the ports' tests load it (test/programs next to test/ports). */
export const METADATA_SO = path.join(PORTS, "../programs/mpl_token_metadata.so");

export const IMPLS = ["typesol", "anchor", "native", "pinocchio"] as const;
export type Impl = (typeof IMPLS)[number];
export type Official = Exclude<Impl, "typesol">;
export const ROUNDS = 20;

export const SYSTEM = address("11111111111111111111111111111111");
export const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const METADATA = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export const RENT_SYSVAR = address("SysvarRent111111111111111111111111111111111");
export const SOL = 1_000_000_000n;

/** One program of an example: its address (the Anchor variant's declare_id), the TypeSOL port and each official build. */
export interface ProgramSpec {
  id: string;
  /** Path of the TypeSOL port, relative to the ports directory (test/ports of the TypeSOL repository). */
  port: string;
  /** File name of each official build inside official/deploy/<example>/<variant>/. */
  so: Record<Official, string>;
}

export interface Example {
  /** official/deploy/<name>, and the key in results.json. */
  name: string;
  /** Directory in solana-developers/program-examples. */
  source: string;
  programs: ProgramSpec[];
  /** Programs every VM loads besides the example's own (e.g. Metaplex Token Metadata). */
  extra?: { id: Address; so: string }[];
  /** The instructions reported, in order; each must be measured at least once in every implementation. */
  labels: string[];
  notes?: string;
  /** Drives the scenario and returns the normalized observable outcome, which must be the same in every implementation. */
  scenario(c: Ctx): Promise<unknown>;
}

export type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };
export type Result = TransactionMetadata | FailedTransactionMetadata;

/** A writable account meta; a KeyPairSigner also signs. */
export const w = (a: Address | KeyPairSigner): Meta => (typeof a === "string" ? { address: a, writable: true } : { address: a.address, signer: a, writable: true });
/** A read-only account meta; a KeyPairSigner also signs. */
export const r = (a: Address | KeyPairSigner): Meta => (typeof a === "string" ? { address: a } : { address: a.address, signer: a });

export class Ctx {
  readonly cu = new Map<string, bigint[]>();
  /** Hostile or edge calls: what each implementation did with them (reported, not compared). */
  readonly probes: Record<string, "refused" | "accepted"> = {};
  /** The error each refused probe failed with: "Custom(2006)" for a program error code, else the runtime's error name. */
  readonly probeErrors: Record<string, string> = {};
  readonly impl: Impl;
  readonly svm: LiteSVM;
  readonly ids: Address[];
  /** Coders from the TypeSOL ports' IDLs (one per program): Anchor-compatible instruction encodings. */
  readonly coders: BorshCoder[];
  constructor(impl: Impl, svm: LiteSVM, ids: Address[], coders: BorshCoder[]) {
    this.impl = impl;
    this.svm = svm;
    this.ids = ids;
    this.coders = coders;
  }

  /** The native and Pinocchio variants share their own (non-Anchor) encodings in most examples. */
  get nativeLike(): boolean {
    return this.impl === "native" || this.impl === "pinocchio";
  }

  get id(): Address {
    return this.ids[0];
  }

  /** A raw instruction to `program` (default: the example's first program). */
  ix(data: Uint8Array, accounts: Meta[], program: Address = this.id): Instruction {
    return {
      programAddress: program,
      accounts: accounts.map((a) => ({
        address: a.address,
        role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
        ...(a.signer ? { signer: a.signer } : {}),
      })) as Instruction["accounts"],
      data: new Uint8Array(data),
    };
  }

  /** An instruction encoded with the TypeSOL port's IDL (Anchor discriminator + Borsh arguments). */
  idl(name: string, args: Record<string, unknown>, accounts: Meta[], program = 0): Instruction {
    return this.ix(this.coders[program].instruction.encode(name, args), accounts, this.ids[program]);
  }

  async send(payer: KeyPairSigner, ixs: Instruction | Instruction[]): Promise<Result> {
    const list = Array.isArray(ixs) ? ixs : [ixs];
    const tx = await pipe(
      createTransactionMessage({ version: 0 }),
      (t) => setTransactionMessageFeePayerSigner(payer, t),
      (t) => this.svm.setTransactionMessageLifetimeUsingLatestBlockhash(t),
      (t) => appendTransactionMessageInstructions(list, t),
      (t) => signTransactionMessageWithSigners(t),
    );
    const res = this.svm.sendTransaction(tx);
    this.svm.expireBlockhash();
    return res;
  }

  /** Setup work (not measured); throws with the logs when it fails. */
  async run(payer: KeyPairSigner, ixs: Instruction | Instruction[], what = "setup"): Promise<TransactionMetadata> {
    const res = await this.send(payer, ixs);
    if (res instanceof FailedTransactionMetadata) throw new Error(`${this.impl}: ${what} failed: ${String(res.err())}\n${res.meta().logs().join("\n")}`);
    return res;
  }

  /** A measured call: the instruction is alone in its transaction, so the transaction's compute units are its own. */
  async call(label: string, payer: KeyPairSigner, ix: Instruction): Promise<TransactionMetadata> {
    const res = await this.run(payer, ix, label);
    this.cu.set(label, [...(this.cu.get(label) ?? []), res.computeUnitsConsumed()]);
    return res;
  }

  /**
   * A measured transaction of several instructions (e.g. a client-side System CreateAccount plus the program call):
   * the label covers the whole transaction. Used, for every implementation alike, where variants split the same work
   * differently between the client and the program.
   */
  async callTx(label: string, payer: KeyPairSigner, ixs: Instruction[]): Promise<TransactionMetadata> {
    const res = await this.run(payer, ixs, label);
    this.cu.set(label, [...(this.cu.get(label) ?? []), res.computeUnitsConsumed()]);
    return res;
  }

  /** A hostile or edge call: records whether this implementation refused it. Run after the outcome is captured. */
  async probe(what: string, payer: KeyPairSigner, ixs: Instruction | Instruction[]): Promise<boolean> {
    const res = await this.send(payer, ixs);
    const refused = res instanceof FailedTransactionMetadata;
    this.probes[what] = refused ? "refused" : "accepted";
    if (refused) {
      const text = String(res.err());
      const code = /code: (\d+)/.exec(text)?.[1];
      this.probeErrors[what] = code ? `Custom(${code})` : (/error: (\w+)/.exec(text)?.[1] ?? text);
    }
    return refused;
  }

  /** A deterministic keypair: the same address in every implementation's run. */
  async signer(n: number, fund = 0n): Promise<KeyPairSigner> {
    const bytes = new Uint8Array(32).fill(0x5a);
    new DataView(bytes.buffer).setUint32(0, n, true);
    const s = await createKeyPairSignerFromPrivateKeyBytes(bytes);
    if (fund > 0n) this.svm.airdrop(s.address, lamports(fund));
    return s;
  }

  async pda(seeds: (string | Address | Uint8Array)[], program: Address = this.id): Promise<[Address, number]> {
    const enc = getAddressEncoder();
    const bytes = seeds.map((s) => (s instanceof Uint8Array ? s : isAddress(s) ? enc.encode(s) : new TextEncoder().encode(s)));
    return getProgramDerivedAddress({ programAddress: program, seeds: bytes as Uint8Array[] });
  }

  account(a: Address): { exists: boolean; lamports: bigint; owner: string; data: Buffer } {
    const acc = this.svm.getAccount(a);
    return acc.exists
      ? { exists: true, lamports: acc.lamports, owner: acc.programAddress, data: Buffer.from(acc.data) }
      : { exists: false, lamports: 0n, owner: "", data: Buffer.alloc(0) };
  }

  balance(a: Address): bigint {
    return this.svm.getBalance(a) ?? 0n;
  }

  /** System CreateAccount of a keypair account owned by `owner` (default: the example's program), rent-exempt. */
  createAccount(payer: KeyPairSigner, account: KeyPairSigner, space: number, owner: Address = this.id): Instruction {
    return getCreateAccountInstruction({ payer, newAccount: account, lamports: this.svm.minimumBalanceForRentExemption(BigInt(space)), space, programAddress: owner });
  }

  rent(space: number | bigint): bigint {
    return this.svm.minimumBalanceForRentExemption(BigInt(space));
  }

  /** The associated token account of `owner` for `mint` under `tokenProgram`. */
  async ata(owner: Address, mint: Address, tokenProgram: Address = TOKEN): Promise<Address> {
    const [a] = await t22.findAssociatedTokenPda({ owner, mint, tokenProgram });
    return a;
  }

  /** A new keypair mint of `tokenProgram` (setup, not measured). */
  async createMint(payer: KeyPairSigner, mint: KeyPairSigner, o: { tokenProgram?: Address; decimals?: number; authority?: Address; freeze?: Address } = {}) {
    const tokenProgram = o.tokenProgram ?? TOKEN;
    await this.run(payer, [
      this.createAccount(payer, mint, 82, tokenProgram),
      t22.getInitializeMint2Instruction(
        { mint: mint.address, decimals: o.decimals ?? 6, mintAuthority: o.authority ?? payer.address, freezeAuthority: o.freeze ?? null },
        { programAddress: tokenProgram as never },
      ),
    ]);
    return mint.address;
  }

  /** Create `owner`'s ATA for `mint` (idempotent) and mint `amount` into it with `authority` (setup, not measured). */
  async fundAta(payer: KeyPairSigner, owner: Address, mint: Address, amount: bigint, o: { tokenProgram?: Address; authority?: KeyPairSigner } = {}) {
    const tokenProgram = o.tokenProgram ?? TOKEN;
    const ata = await this.ata(owner, mint, tokenProgram);
    const ixs: Instruction[] = [t22.getCreateAssociatedTokenIdempotentInstruction({ payer, ata, owner, mint, tokenProgram })];
    if (amount > 0n) ixs.push(t22.getMintToInstruction({ mint, token: ata, mintAuthority: o.authority ?? payer, amount }, { programAddress: tokenProgram as never }));
    await this.run(payer, ixs);
    return ata;
  }

  mint(a: Address) {
    const acc = this.account(a);
    if (!acc.exists) return null;
    const m = getMintDecoder().decode(acc.data.subarray(0, 82));
    return {
      owner: acc.owner,
      supply: m.supply,
      decimals: m.decimals,
      mintAuthority: m.mintAuthority.__option === "Some" ? m.mintAuthority.value : null,
      freezeAuthority: m.freezeAuthority.__option === "Some" ? m.freezeAuthority.value : null,
    };
  }

  token(a: Address) {
    const acc = this.account(a);
    if (!acc.exists) return null;
    const t = getTokenDecoder().decode(acc.data.subarray(0, 165));
    return { owner: acc.owner, mint: t.mint, authority: t.owner, amount: t.amount, state: t.state };
  }
}

const isAddress = (s: unknown): s is Address => typeof s === "string" && s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);

export const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
export const accountDisc = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);

/** Little Borsh writer for the official encodings. */
export const b = {
  u8: (n: number) => Buffer.from([n]),
  bool: (v: boolean) => Buffer.from([v ? 1 : 0]),
  u16: (n: number) => {
    const x = Buffer.alloc(2);
    x.writeUInt16LE(n);
    return x;
  },
  u32: (n: number) => {
    const x = Buffer.alloc(4);
    x.writeUInt32LE(n);
    return x;
  },
  u64: (n: bigint | number) => {
    const x = Buffer.alloc(8);
    x.writeBigUInt64LE(BigInt(n));
    return x;
  },
  str: (s: string) => {
    const x = Buffer.from(s, "utf8");
    return Buffer.concat([b.u32(x.length), x]);
  },
  key: (a: Address) => Buffer.from(getAddressEncoder().encode(a)),
  vec: (items: Buffer[]) => Buffer.concat([b.u32(items.length), ...items]),
  cat: (...parts: Buffer[]) => Buffer.concat(parts),
};

/** Little Borsh reader for decoding official account layouts. */
export class Reader {
  off = 0;
  readonly d: Buffer;
  constructor(d: Buffer) {
    this.d = d;
  }
  skip(n: number) {
    this.off += n;
    return this;
  }
  u8() {
    return this.d[this.off++];
  }
  bool() {
    return this.u8() !== 0;
  }
  u16() {
    const v = this.d.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }
  u32() {
    const v = this.d.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }
  u64() {
    const v = this.d.readBigUInt64LE(this.off);
    this.off += 8;
    return v;
  }
  key(): Address {
    const v = getAddressDecoder().decode(this.d.subarray(this.off, this.off + 32));
    this.off += 32;
    return v;
  }
  str() {
    const n = this.u32();
    const v = this.d.subarray(this.off, this.off + n).toString("utf8");
    this.off += n;
    return v;
  }
  /** TypeSOL FixedString<cap>: u32 length + cap bytes. */
  fixed(cap: number) {
    const n = this.u32();
    const v = this.d.subarray(this.off, this.off + n).toString("utf8");
    this.off += cap;
    return v;
  }
}

/** JSON with bigints, for comparing outcomes. */
export const canon = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

export function must(ok: boolean, what: string): asserts ok {
  if (!ok) throw new Error(what);
}

export { BorshCoder, type Idl };
