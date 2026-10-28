// basics/transfer-sol. `transfer_sol_with_cpi(amount)` moves lamports from a signer with a System Transfer CPI;
// `transfer_sol_with_program(amount)` moves them directly out of an account the program owns. Native: Borsh enum
// (0 = CpiTransfer(u64), 1 = ProgramTransfer(u64)); Pinocchio: the same one-byte tags + u64.
import { type Address, type KeyPairSigner } from "@solana/kit";
import { BN } from "@anchor-lang/core";
import { type Ctx, type Example, ROUNDS, SOL, SYSTEM, b, r, w } from "../lib.ts";

function withCpi(c: Ctx, payer: KeyPairSigner, recipient: Address, amount: bigint) {
  const accounts = [w(payer), w(recipient), r(SYSTEM)];
  if (c.nativeLike) return c.ix(b.cat(b.u8(0), b.u64(amount)), accounts);
  return c.idl("transfer_sol_with_cpi", { amount: new BN(amount.toString()) }, accounts);
}

function withProgram(c: Ctx, payer: KeyPairSigner | Address, recipient: Address, amount: bigint) {
  const accounts = [w(payer), w(recipient)];
  if (c.nativeLike) return c.ix(b.cat(b.u8(1), b.u64(amount)), accounts);
  return c.idl("transfer_sol_with_program", { amount: new BN(amount.toString()) }, accounts);
}

const example: Example = {
  name: "transfer-sol",
  source: "basics/transfer-sol",
  programs: [
    {
      id: "4fQVnLWKKKYxtxgGn7Haw8v2g2Hzbu8K61JvWKvqAi7W",
      port: "basics/transfer-sol.ts",
      so: { anchor: "transfer_sol.so", native: "transfer_sol_program.so", pinocchio: "transfer_sol_pinocchio_program.so" },
    },
  ],
  labels: ["transfer_sol_with_cpi", "transfer_sol_with_program"],
  notes:
    "Anchor and TypeSOL also check that the recipient is a System-owned account and that the paying account of transfer_sol_with_program " +
    "is owned by the program; the native and Pinocchio versions check only the signature and leave ownership to the runtime.",
  async scenario(c) {
    const payer = await c.signer(1, 100n * SOL);
    // A keypair account owned by the program, which pays directly.
    const programOwned = await c.signer(2);
    c.svm.setAccount({ address: programOwned.address, data: new Uint8Array(), executable: false, lamports: (50n * SOL) as never, programAddress: c.id, space: 0n });
    const recipients: Address[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const to = (await c.signer(100 + i)).address;
      recipients.push(to);
      await c.call("transfer_sol_with_cpi", payer, withCpi(c, payer, to, SOL / 100n * BigInt(i + 1)));
      await c.call("transfer_sol_with_program", payer, withProgram(c, programOwned, to, SOL / 1000n * BigInt(i + 1)));
    }
    const outcome = { programOwned: c.balance(programOwned.address), recipients: recipients.map((a) => c.balance(a)) };
    // The attacker passes the program-owned account without its signature.
    const attacker = await c.signer(3);
    await c.probe("transfer_sol_with_program without the paying account's signature", payer, withProgram(c, programOwned.address, attacker.address, SOL));
    return outcome;
  },
};
export default example;
