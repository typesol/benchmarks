// basics/create-account. The program creates a System-owned keypair account with a CPI, sized to the Borsh
// AddressData { name, address } (Anchor, TypeSOL) or to the instruction data length (native, Pinocchio: the same
// Borsh bytes are sent as the data, so every variant creates a 24-byte account).
import { type Example, ROUNDS, SOL, SYSTEM, b, r, w } from "../lib.ts";

const example: Example = {
  name: "create-account",
  source: "basics/create-account",
  programs: [
    {
      id: "ARVNCsYKDQsCLHbwUTJLpFXVrJdjhWZStyzvxmKe2xHi",
      port: "basics/create-account.ts",
      so: { anchor: "create_system_account.so", native: "create_account_program.so", pinocchio: "create_account_pinocchio_program.so" },
    },
  ],
  labels: ["create_system_account"],
  notes:
    "The native and Pinocchio versions size the account by the instruction data length and do not decode it. " +
    "Anchor, native and TypeSOL log the new address as base58 (Anchor and native via to_string).",
  async scenario(c) {
    const payer = await c.signer(1, 100n * SOL);
    const created = [];
    for (let i = 0; i < ROUNDS; i++) {
      const fresh = await c.signer(100 + i);
      const accounts = [w(payer), w(fresh), r(SYSTEM)];
      const ix = c.nativeLike ? c.ix(b.cat(b.str("Joe C"), b.str("123 Main St")), accounts) : c.idl("create_system_account", { address_data: { name: "Joe C", address: "123 Main St" } }, accounts);
      await c.call("create_system_account", payer, ix);
      const acc = c.account(fresh.address);
      created.push({ owner: acc.owner, space: acc.data.length, lamports: acc.lamports });
    }
    return created;
  },
};
export default example;
