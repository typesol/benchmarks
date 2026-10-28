// basics/checking-accounts. One instruction that only validates its four accounts: payer, an account to create,
// an account to change (must be owned by this program) and the System Program. Anchor/TypeSOL: 8-byte discriminator;
// native/Pinocchio: empty instruction data.
import { type Example, ROUNDS, SOL, SYSTEM, disc, r, w } from "../lib.ts";

const example: Example = {
  name: "checking-accounts",
  source: "basics/checking-accounts",
  programs: [
    {
      id: "ECWPhR3rJbaPfyNFgphnjxSEexbTArc7vxD8fnW6tgKw",
      port: "basics/checking-accounts.ts",
      so: { anchor: "checking_account_program.so", native: "checking_accounts_native_program.so", pinocchio: "checking_accounts_pinocchio_program.so" },
    },
  ],
  labels: ["check_accounts"],
  notes:
    "The native and Pinocchio versions also log both account addresses and require the account to create to hold no lamports; " +
    "Anchor (and the TypeSOL port) leave that account unchecked. The native version does not check that the payer signed.",
  async scenario(c) {
    const payer = await c.signer(1, 100n * SOL);
    const toChange = await c.signer(2);
    await c.run(payer, c.createAccount(payer, toChange, 0));
    const check = (create: string, change: string) =>
      c.ix(c.nativeLike ? new Uint8Array() : disc("check_accounts"), [r(payer), w(create as never), w(change as never), r(SYSTEM)]);
    for (let i = 0; i < ROUNDS; i++) {
      const toCreate = await c.signer(100 + i);
      await c.call("check_accounts", payer, check(toCreate.address, toChange.address));
    }
    const acc = c.account(toChange.address);
    const outcome = { toChange: { owner: acc.owner, lamports: acc.lamports }, toCreateExists: c.account((await c.signer(100)).address).exists };
    const systemOwned = await c.signer(3, SOL);
    await c.probe("account to change owned by the System Program", payer, check((await c.signer(200)).address, systemOwned.address));
    const funded = await c.signer(4, SOL);
    await c.probe("account to create already holds lamports", payer, check(funded.address, toChange.address));
    return outcome;
  },
};
export default example;
