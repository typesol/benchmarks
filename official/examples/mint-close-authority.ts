// tokens/token-2022/mint-close-authority. Every variant creates a Token-2022 mint (decimals 2, mint authority and
// close authority: the payer) with the MintCloseAuthority extension in one instruction. Anchor (`init` with
// `extensions::close_authority::authority`) and TypeSOL also have `close`; the native and Pinocchio versions only create.
import { RENT_SYSVAR, ROUNDS, SOL, SYSTEM, TOKEN_2022, type Example, b, r, w } from "../lib.ts";
import { mint2022 } from "./non-transferable.ts";

const example: Example = {
  name: "mint-close-authority",
  source: "tokens/token-2022/mint-close-authority",
  programs: [
    {
      id: "AcfQLsYKuzprcCNH1n96pKKgAbAnZchwpbr3gbVN742n",
      port: "tokens/token-2022/mint-close-authority.ts",
      so: {
        anchor: "mint_close_authority.so",
        native: "token_2022_mint_close_authority_program.so",
        pinocchio: "token_2022_mint_close_authority_pinocchio_program.so",
      },
    },
  ],
  labels: ["initialize"],
  notes:
    "Only initialize is compared: the native and Pinocchio versions have no close instruction. " +
    "Their mint also gets the mint authority as freeze authority, where Anchor and TypeSOL set none (the freeze authority is left out of the compared outcome); " +
    "Anchor and TypeSOL also read the extension back after creating the mint and check its close authority.",
  async scenario(c) {
    const payer = await c.signer(1, 100n * SOL);
    const mints = [];
    for (let i = 0; i < ROUNDS; i++) {
      const mint = await c.signer(100 + i);
      const ix = c.nativeLike
        ? c.ix(b.u8(2), [w(mint), r(payer.address), r(payer.address), w(payer), r(RENT_SYSVAR), r(SYSTEM), r(TOKEN_2022)])
        : c.idl("initialize", {}, [w(payer), w(mint), r(TOKEN_2022), r(SYSTEM)]);
      await c.call("initialize", payer, ix);
      const { freezeAuthority: _, ...m } = mint2022(c, mint.address)!;
      mints.push(m);
    }
    return { mints };
  },
};
export default example;
