// basics/pda-rent-payer. Anchor: `init_rent_vault(fund_lamports)` transfers lamports from the payer to the PDA
// ["rent_vault"] (it stays a System-owned account); `create_new_account` has the vault pay a System CreateAccount
// (0 bytes) for a new signer account. Native: InitRentVault(fund) (enum 0) creates the vault as a program-owned 0-byte
// PDA holding rent + fund; CreateNewAccount (1) moves rent-exempt lamports from the vault to the new account directly.
// Pinocchio: the same with the bump in the data ([0, bump, fund], [1, bump]). TypeSOL: as Anchor, signing with the
// canonical bump its Seeds<> check finds (`pdaBump`).
import { type Address, type KeyPairSigner } from "@solana/kit";
import { BN } from "@anchor-lang/core";
import { type Ctx, type Example, ROUNDS, SOL, SYSTEM, b, disc, r, w } from "../lib.ts";

const FUND = SOL;

function init(c: Ctx, payer: KeyPairSigner, vault: Address, bump: number) {
  switch (c.impl) {
    case "anchor":
      return c.ix(b.cat(disc("init_rent_vault"), b.u64(FUND)), [w(payer), w(vault), r(SYSTEM)]);
    case "typesol":
      return c.idl("init_rent_vault", { fund_lamports: new BN(FUND.toString()) }, [w(payer), w(vault), r(SYSTEM)]);
    // The native and Pinocchio vault holds rent(0) + fund: fund it so its balance matches the Anchor vault's.
    case "native":
      return c.ix(b.cat(b.u8(0), b.u64(FUND - c.rent(0))), [w(vault), w(payer), r(SYSTEM)]);
    case "pinocchio":
      return c.ix(b.cat(b.u8(0), b.u8(bump), b.u64(FUND - c.rent(0))), [w(vault), w(payer), r(SYSTEM)]);
  }
}

function create(c: Ctx, fresh: KeyPairSigner | Address, vault: Address, bump: number) {
  const accounts = [w(fresh), w(vault), r(SYSTEM)];
  switch (c.impl) {
    case "anchor":
      return c.ix(disc("create_new_account"), accounts);
    case "typesol":
      return c.idl("create_new_account", {}, accounts);
    case "native":
      return c.ix(b.u8(1), accounts);
    case "pinocchio":
      return c.ix(b.cat(b.u8(1), b.u8(bump)), accounts);
  }
}

const example: Example = {
  name: "pda-rent-payer",
  source: "basics/pda-rent-payer",
  programs: [
    {
      id: "7Hm9nsYVuBZ9rf8z9AMUHreZRv8Q4vLhqwdVTCawRZtA",
      port: "basics/pda-rent-payer.ts",
      so: { anchor: "pda_rent_payer.so", native: "pda_rent_payer_program.so", pinocchio: "pda_rent_payer_pinocchio_program.so" },
    },
  ],
  labels: ["init_rent_vault", "create_new_account"],
  notes:
    "The same observable result by different means: Anchor and TypeSOL fund a System-owned vault with a System Transfer and pay for each new " +
    "account with a signed System CreateAccount CPI; native and Pinocchio create the vault as a program-owned account (CreateAccount CPI) and " +
    "move lamports out of it directly (no CPI) in create_new_account. The vault's owner is therefore not compared (its balance is). " +
    "Native searches the bump on chain in both instructions; Pinocchio takes it from the client and checks it with create_program_address; " +
    "Anchor and TypeSOL find the canonical bump on chain while checking the vault. The native and Pinocchio create_new_account do not require " +
    "the new account's signature.",
  async scenario(c) {
    const payer = await c.signer(1, 100n * SOL);
    const [vault, bump] = await c.pda(["rent_vault"]);
    await c.call("init_rent_vault", payer, init(c, payer, vault, bump));
    const fresh = [];
    for (let i = 0; i < ROUNDS; i++) {
      const account = await c.signer(100 + i);
      fresh.push(account.address);
      await c.call("create_new_account", payer, create(c, account, vault, bump));
    }
    const outcome = {
      vault: c.balance(vault),
      created: fresh.map((a) => {
        const acc = c.account(a);
        return { exists: acc.exists, lamports: acc.lamports, owner: acc.owner, size: acc.data.length };
      }),
    };
    const unsigned = await c.signer(2);
    await c.probe("create_new_account without the new account's signature", payer, create(c, unsigned.address, vault, bump));
    return outcome;
  },
};
export default example;
