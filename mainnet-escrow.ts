// The official escrow on mainnet-beta, in all four implementations: the same make_offer / take_offer / refund_offer
// calls (same mints, amounts and accounts) against each deployed program, each instruction alone in its transaction,
// with the compute units read back from the confirmed transaction.
//
//   node mainnet-escrow.ts            # setup (once) + one make→take and one make→refund per implementation
//
// Keys live outside this repository, in KEYS_DIR (default ~/.config/typesol/mainnet): funder.json pays and is the maker,
// taker.json is created and funded from it. RPC_URL is a mainnet-beta RPC endpoint (never printed). Results go to
// results/mainnet-escrow.json (signatures and compute units only).
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import * as tk from "@solana-program/token-2022";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ATA_PROGRAM, SYSTEM, TOKEN, b, disc } from "./official/lib.ts";
import { getProgramDerivedAddress, getAddressEncoder } from "@solana/kit";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYS = process.env.KEYS_DIR ?? path.join(os.homedir(), ".config/typesol/mainnet");
const OUT = path.join(HERE, "results/mainnet-escrow.json");

const rpcUrl = (() => {
  const url = process.env.RPC_URL;
  if (!url) throw new Error("set RPC_URL to a mainnet-beta RPC endpoint");
  return url;
})();
const rpc = createSolanaRpc(rpcUrl);

const keypair = async (name: string) => createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(path.join(KEYS, name), "utf8"))));
const pubkeyOf = async (name: string) => (await keypair(name)).address;

const IMPLS = ["typesol", "anchor", "native", "pinocchio"] as const;
type Impl = (typeof IMPLS)[number];

type State = { mintA?: Address; mintB?: Address; nextId?: number; runs: Run[] };
type Run = { impl: Impl; program: Address; id: number; label: string; signature: string; cu: number };
const state: State = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { runs: [] };
const save = () => writeFileSync(OUT, JSON.stringify(state, null, 2) + "\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send one transaction and wait until it is confirmed; returns the signature and its compute units. */
async function send(payer: KeyPairSigner, ixs: Instruction[], what: string): Promise<{ signature: string; cu: number }> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const tx = await pipe(
      createTransactionMessage({ version: 0 }),
      (t) => setTransactionMessageFeePayerSigner(payer, t),
      (t) => setTransactionMessageLifetimeUsingBlockhash(blockhash, t),
      (t) => appendTransactionMessageInstructions(ixs, t),
      (t) => signTransactionMessageWithSigners(t),
    );
    const signature = getSignatureFromTransaction(tx);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" }).send();
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const { value } = await rpc.getSignatureStatuses([signature]).send();
      const s = value[0];
      if (s?.err) throw new Error(`${what} failed: ${JSON.stringify(s.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v))} (${signature})`);
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
        for (let j = 0; j < 20; j++) {
          const t = await rpc.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send();
          if (t) return { signature, cu: Number(t.meta?.computeUnitsConsumed ?? -1) };
          await sleep(1000);
        }
        return { signature, cu: -1 };
      }
    }
    console.log(`${what}: not confirmed, retrying (${attempt})`);
  }
  throw new Error(`${what}: not confirmed`);
}

const ata = async (owner: Address, mint: Address) => (await tk.findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN }))[0];
const w = (a: Address | KeyPairSigner) => (typeof a === "string" ? { address: a, role: 1 } : { address: a.address, role: 3, signer: a });
const r = (a: Address | KeyPairSigner) => (typeof a === "string" ? { address: a, role: 0 } : { address: a.address, role: 2, signer: a });
const ix = (program: Address, data: Uint8Array, accounts: ReturnType<typeof w>[]): Instruction =>
  ({ programAddress: program, accounts, data: new Uint8Array(data) }) as unknown as Instruction;

const maker = await keypair("funder.json");
if (!existsSync(path.join(KEYS, "taker.json"))) {
  const t = await generateKeyPairSigner(true);
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", t.keyPair.privateKey)).slice(-32);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", t.keyPair.publicKey));
  writeFileSync(path.join(KEYS, "taker.json"), JSON.stringify([...bytes, ...pub]), { mode: 0o600 });
}
const taker = await keypair("taker.json");
const programs = Object.fromEntries(await Promise.all(IMPLS.map(async (i) => [i, await pubkeyOf(`escrow-${i}.json`)]))) as Record<Impl, Address>;

// Setup, once: fund the taker, two mints (A minted to the maker, B to the taker) and the four token accounts.
if (!state.mintA || !state.mintB) {
  const mintA = await generateKeyPairSigner();
  const mintB = await generateKeyPairSigner();
  const rent = await rpc.getMinimumBalanceForRentExemption(82n).send();
  await send(maker, [getTransferSolInstruction({ source: maker, destination: taker.address, amount: 30_000_000n })], "fund taker");
  for (const [mint, auth] of [
    [mintA, maker],
    [mintB, taker],
  ] as const) {
    await send(
      maker,
      [
        getCreateAccountInstruction({ payer: maker, newAccount: mint, lamports: rent, space: 82, programAddress: TOKEN }),
        tk.getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: auth.address, freezeAuthority: null }, { programAddress: TOKEN as never }),
      ],
      "create mint",
    );
  }
  const ixs: Instruction[] = [];
  for (const [owner, mint] of [
    [maker.address, mintA.address],
    [maker.address, mintB.address],
    [taker.address, mintA.address],
    [taker.address, mintB.address],
  ] as const)
    ixs.push(tk.getCreateAssociatedTokenIdempotentInstruction({ payer: maker, ata: await ata(owner, mint), owner, mint, tokenProgram: TOKEN }));
  ixs.push(tk.getMintToInstruction({ mint: mintA.address, token: await ata(maker.address, mintA.address), mintAuthority: maker, amount: 1_000_000_000n }, { programAddress: TOKEN as never }));
  ixs.push(tk.getMintToInstruction({ mint: mintB.address, token: await ata(taker.address, mintB.address), mintAuthority: taker, amount: 1_000_000_000n }, { programAddress: TOKEN as never }));
  await send(maker, ixs, "token accounts");
  state.mintA = mintA.address;
  state.mintB = mintB.address;
  state.nextId = 1;
  save();
}
const mintA = state.mintA!;
const mintB = state.mintB!;
const makerA = await ata(maker.address, mintA);
const makerB = await ata(maker.address, mintB);
const takerA = await ata(taker.address, mintA);
const takerB = await ata(taker.address, mintB);

const offerOf = async (program: Address, id: number) =>
  getProgramDerivedAddress({ programAddress: program, seeds: [new TextEncoder().encode("offer"), getAddressEncoder().encode(maker.address), b.u64(id)] });

// The encodings and account orders of benchmarks/official/examples/escrow.ts.
async function make(impl: Impl, id: number, amountA: bigint, wantB: bigint) {
  const program = programs[impl];
  const [offer, bump] = await offerOf(program, id);
  const vault = await ata(offer, mintA);
  if (impl === "native" || impl === "pinocchio") {
    const data = impl === "native" ? b.cat(b.u8(0), b.u64(id), b.u64(amountA), b.u64(wantB)) : b.cat(b.u8(0), b.u64(id), b.u64(amountA), b.u64(wantB), b.u8(bump));
    return { offer, vault, ix: ix(program, data, [w(offer), r(mintA), r(mintB), w(makerA), w(vault), w(maker), w(maker), r(TOKEN), r(ATA_PROGRAM), r(SYSTEM)]) };
  }
  const data = b.cat(disc("make_offer"), b.u64(id), b.u64(amountA), b.u64(wantB));
  return { offer, vault, ix: ix(program, data, [w(maker), r(mintA), r(mintB), w(makerA), w(offer), w(vault), r(ATA_PROGRAM), r(TOKEN), r(SYSTEM)]) };
}
function take(impl: Impl, o: { offer: Address; vault: Address }) {
  const program = programs[impl];
  if (impl === "native" || impl === "pinocchio")
    return ix(program, b.u8(1), [w(o.offer), r(mintA), r(mintB), w(makerB), w(takerA), w(takerB), w(o.vault), r(maker.address), w(taker), w(taker), r(TOKEN), r(ATA_PROGRAM), r(SYSTEM)]);
  return ix(program, disc("take_offer"), [w(taker), w(maker.address), r(mintA), r(mintB), w(takerA), w(takerB), w(makerB), w(o.offer), w(o.vault), r(ATA_PROGRAM), r(TOKEN), r(SYSTEM)]);
}
function refund(impl: Impl, o: { offer: Address; vault: Address }) {
  const program = programs[impl];
  if (impl === "native" || impl === "pinocchio") {
    const accounts = [w(o.offer), r(mintA), w(makerA), w(o.vault), w(maker), r(TOKEN)];
    if (impl === "native") accounts.push(r(SYSTEM));
    return ix(program, b.u8(2), accounts);
  }
  return ix(program, disc("refund_offer"), [w(maker), r(mintA), w(makerA), w(o.offer), w(o.vault), r(TOKEN)]);
}

const only = process.argv.slice(2).filter((a): a is Impl => (IMPLS as readonly string[]).includes(a));
for (const impl of only.length ? only : IMPLS) {
  for (const then of ["take_offer", "refund_offer"] as const) {
    const id = state.nextId!++;
    save();
    const o = await make(impl, id, 1_000n, 300n);
    const m = await send(maker, [o.ix], `${impl} make_offer`);
    state.runs.push({ impl, program: programs[impl], id, label: "make_offer", ...m });
    save();
    const t = then === "take_offer" ? await send(taker, [take(impl, o)], `${impl} take_offer`) : await send(maker, [refund(impl, o)], `${impl} refund_offer`);
    state.runs.push({ impl, program: programs[impl], id, label: then, ...t });
    save();
    console.log(`${impl.padEnd(10)} make_offer ${String(m.cu).padStart(6)}  ${then} ${String(t.cu).padStart(6)}`);
  }
}
