// tokens/token-2022/default-account-state. The end state in every variant: a Token-2022 mint (decimals 2, mint and
// freeze authority: the payer) whose DefaultAccountState extension was initialized Frozen and then updated to
// Initialized. Anchor and TypeSOL do it with two instructions (`initialize`, then `update_default_state`); the native
// and Pinocchio versions do all of it (create, Frozen, InitializeMint, update to Initialized) in their one instruction.
import { FailedTransactionMetadata } from "litesvm";
import { RENT_SYSVAR, ROUNDS, SOL, SYSTEM, TOKEN_2022, type Example, b, r, w } from "../lib.ts";
import { mint2022 } from "./non-transferable.ts";
import { getMintToInstruction } from "@solana-program/token-2022";

const LABEL = "initialize + update_default_state (tx)";

const example: Example = {
  name: "default-account-state",
  source: "tokens/token-2022/default-account-state",
  programs: [
    {
      id: "5LdYbHiUsFxVG8bfqoeBkhBYMRmWZb3BoLuABgYW7coB",
      port: "tokens/token-2022/default-account-state.ts",
      so: {
        anchor: "default_account_state.so",
        native: "token_2022_default_account_state_program.so",
        pinocchio: "token_2022_default_account_state_pinocchio_program.so",
      },
    },
  ],
  labels: [LABEL],
  notes:
    "One transaction per variant reaching the same mint: Anchor and TypeSOL send initialize (create, DefaultAccountState Frozen, InitializeMint2) and " +
    "update_default_state(Initialized) as two instructions of that transaction; the native and Pinocchio versions do the same four steps in their single instruction. " +
    "Anchor and TypeSOL check the mint's freeze authority in update_default_state; the native and Pinocchio versions leave the checks to Token-2022.",
  async scenario(c) {
    const payer = await c.signer(1, 100n * SOL);
    const mints = [];
    for (let i = 0; i < ROUNDS; i++) {
      const mint = await c.signer(100 + i);
      const ixs = c.nativeLike
        ? [c.ix(b.u8(2), [w(mint), r(payer.address), w(payer), r(RENT_SYSVAR), r(SYSTEM), r(TOKEN_2022)])]
        : [
            c.idl("initialize", {}, [w(payer), w(mint), r(TOKEN_2022), r(SYSTEM)]),
            c.idl("update_default_state", { account_state: { Initialized: {} } }, [w(payer), w(mint.address), r(TOKEN_2022), r(SYSTEM)]),
          ];
      await c.callTx(LABEL, payer, ixs);
      mints.push(mint2022(c, mint.address));
    }
    // A new token account of the mint starts Initialized (not frozen), so minting into it works.
    const first = (await c.signer(100)).address;
    const holder = await c.signer(2, SOL);
    const ata = await c.fundAta(payer, holder.address, first, 0n, { tokenProgram: TOKEN_2022 });
    const minted = !((await c.send(payer, getMintToInstruction({ mint: first, token: ata, mintAuthority: payer, amount: 7n }, { programAddress: TOKEN_2022 as never }))) instanceof FailedTransactionMetadata);
    return { mints, newAccount: c.token(ata), minted };
  },
};
export default example;
