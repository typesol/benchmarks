// Quick CU probe: create + bump on one .so (no byte checks).
import { AccountRole, type Instruction, address, appendTransactionMessageInstructions, createTransactionMessage, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress, lamports, pipe, setTransactionMessageFeePayerSigner, signTransactionMessageWithSigners } from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { createHash } from "node:crypto";
const ID = address("EaiwmXTVEwU6sh1wAizeXHmPkHS4s6HaHr4EX3vZ6kJq");
const disc = (n: string) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const so = process.argv[2]!;
let lastLogs: string[] = [];
const svm = new LiteSVM();
svm.addProgramFromFile(ID, so);
const owner = await generateKeyPairSigner();
svm.airdrop(owner.address, lamports(10_000_000_000n));
const [profile] = await getProgramDerivedAddress({ programAddress: ID, seeds: ["profile", getAddressEncoder().encode(owner.address)] });
const send = async (ix: string, data: Buffer, create = false) => {
  const accounts = create
    ? [{ address: owner.address, role: AccountRole.WRITABLE_SIGNER, signer: owner }, { address: profile, role: AccountRole.WRITABLE }, { address: address("11111111111111111111111111111111"), role: AccountRole.READONLY }]
    : [{ address: owner.address, role: AccountRole.READONLY_SIGNER, signer: owner }, { address: profile, role: AccountRole.WRITABLE }];
  const msg = { programAddress: ID, accounts, data: new Uint8Array(Buffer.concat([disc(ix), data])) } as unknown as Instruction;
  const tx = await pipe(createTransactionMessage({ version: 0 }), (t) => setTransactionMessageFeePayerSigner(owner, t), (t) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(t), (t) => appendTransactionMessageInstructions([msg], t), (t) => signTransactionMessageWithSigners(t));
  const r = svm.sendTransaction(tx);
  if (!(r instanceof FailedTransactionMetadata)) lastLogs = r.logs();
  svm.expireBlockhash();
  if (r instanceof FailedTransactionMetadata) throw new Error(r.meta().logs().join("\n"));
  return Number(r.computeUnitsConsumed());
};
const name = Buffer.alloc(9); name.writeUInt32LE(5); name.write("alice", 4);
await send("create", name, true);
const by = Buffer.alloc(8); by.writeBigUInt64LE(1n);
console.log("bump", await send("bump", by)); if (process.env.LOGS) console.log(lastLogs.join("\n"));
