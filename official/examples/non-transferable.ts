// tokens/token-2022/non-transferable. Every variant creates a Token-2022 mint (decimals 2, mint and freeze authority:
// the payer) with the NonTransferable extension in one instruction: System CreateAccount, InitializeNonTransferableMint,
// then InitializeMint2 (Anchor, TypeSOL) or InitializeMint with the rent sysvar (native, Pinocchio). Anchor and
// TypeSOL take no arguments; native and Pinocchio take the decimals as their only instruction data byte.
import { getMintDecoder, getTransferCheckedInstruction } from "@solana-program/token-2022";
import { FailedTransactionMetadata } from "litesvm";
import { type Ctx, type Example, RENT_SYSVAR, ROUNDS, SOL, SYSTEM, TOKEN_2022, b, r, w } from "../lib.ts";

/** A Token-2022 mint with its extensions, decoded (null when the account does not exist). */
export function mint2022(c: Ctx, a: Parameters<Ctx["account"]>[0]) {
  const acc = c.account(a);
  if (!acc.exists) return null;
  const m = getMintDecoder().decode(acc.data);
  return { owner: acc.owner, space: acc.data.length, lamports: acc.lamports, ...m };
}

const example: Example = {
  name: "non-transferable",
  source: "tokens/token-2022/non-transferable",
  programs: [
    {
      id: "8Bz4wpHaUckiC169Rg5ZfaBHFemp5S8RwTSDTKzhJ9W",
      port: "tokens/token-2022/non-transferable.ts",
      so: {
        anchor: "non_transferable.so",
        native: "token_2022_non_transferable_program.so",
        pinocchio: "token_2022_non_transferable_pinocchio_program.so",
      },
    },
  ],
  labels: ["initialize"],
  notes:
    "The native and Pinocchio versions take the mint authority as an account and do not check the payer's or the token program's identity (the CPIs fail on a wrong one); " +
    "Anchor and TypeSOL check the token and system programs by address.",
  async scenario(c) {
    const payer = await c.signer(1, 100n * SOL);
    const mints = [];
    for (let i = 0; i < ROUNDS; i++) {
      const mint = await c.signer(100 + i);
      const ix = c.nativeLike
        ? c.ix(b.u8(2), [w(mint), r(payer.address), w(payer), r(RENT_SYSVAR), r(SYSTEM), r(TOKEN_2022)])
        : c.idl("initialize", {}, [w(payer), w(mint), r(TOKEN_2022), r(SYSTEM)]);
      await c.call("initialize", payer, ix);
      mints.push(mint2022(c, mint.address));
    }
    // The extension holds: a transfer of a minted balance is refused by Token-2022 in every variant.
    const first = (await c.signer(100)).address;
    const from = await c.fundAta(payer, payer.address, first, 100n, { tokenProgram: TOKEN_2022 });
    const other = await c.signer(2, SOL);
    const to = await c.fundAta(payer, other.address, first, 0n, { tokenProgram: TOKEN_2022 });
    const res = await c.send(payer, getTransferCheckedInstruction({ source: from, mint: first, destination: to, authority: payer, amount: 50n, decimals: 2 }));
    const transferRefused = res instanceof FailedTransactionMetadata && c.token(from)?.amount === 100n && c.token(to)?.amount === 0n;
    return { mints, transferRefused };
  },
};
export default example;
