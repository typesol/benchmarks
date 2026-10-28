// tokens/transfer-tokens. Create a mint, mint into the payer's associated token account, transfer to other wallets
// (creating their associated token accounts when missing).
// Anchor / TypeSOL: create_token / mint_token / transfer_tokens (Anchor encoding; amounts are whole tokens, scaled by
// 10^decimals in the program). Native: Borsh enum (0 Create{title, symbol, uri, decimals}, 2 MintSpl{quantity},
// 3 TransferTokens{quantity}), raw base-unit amounts, mints only to the payer's own account. Pinocchio: one-byte
// discriminator (0 CreateToken{decimals}, 1 MintTokens{amount}, 2 TransferTokens{amount}), raw amounts; its create
// makes no Metaplex metadata.
import { BN } from "@anchor-lang/core";
import { type Example, METADATA, METADATA_SO, RENT_SYSVAR, ROUNDS, SOL, SYSTEM, TOKEN, ATA_PROGRAM, b, r, w } from "../lib.ts";
import { decodeMetadata, metadataPda } from "./create-token.ts";

const NAME = "Solana Gold";
const SYMBOL = "GOLDSOL";
const URI = "https://raw.githubusercontent.com/solana-developers/program-examples/new-examples/tokens/tokens/.assets/spl-token.json";
const DECIMALS = 9;
const UNIT = 10n ** BigInt(DECIMALS);
const NEW_RECIPIENTS = 5;

const example: Example = {
  name: "transfer-tokens",
  source: "tokens/transfer-tokens",
  programs: [
    {
      id: "nHi9DdNjuupjQ3c8AJU9sChB5gLbZvTLsJQouY4hU67",
      port: "tokens/transfer-tokens.ts",
      so: { anchor: "transfer_tokens.so", native: "transfer_tokens_program.so", pinocchio: "transfer_tokens_pinocchio_program.so" },
    },
  ],
  extra: [{ id: METADATA, so: METADATA_SO }],
  labels: ["mint_token", "transfer_tokens", "transfer_tokens (new account)"],
  notes:
    "create_token is not compared: the Pinocchio version creates only the mint, without the Metaplex metadata account the others create (the metadata is not part of the compared outcome). " +
    "mint_token and transfer_tokens go to existing associated token accounts; 'transfer_tokens (new account)' sends to wallets whose associated token account the instruction creates. " +
    "Anchor and TypeSOL take whole-token amounts and scale them by the mint's decimals; the native and Pinocchio versions take base units. " +
    "The native and Pinocchio versions leave the associated-token-account and owner checks to the token programs. " +
    "Anchor, TypeSOL and native skip the associated token account program for an existing account; Pinocchio calls CreateIdempotent every time.",
  async scenario(c) {
    const payer = await c.signer(1, 100n * SOL);
    const mint = await c.signer(2);
    const metadata = await metadataPda(c, mint.address);
    const payerAta = await c.ata(payer.address, mint.address);

    // create (setup)
    if (c.impl === "native")
      await c.run(
        payer,
        c.ix(b.cat(b.u8(0), b.str(NAME), b.str(SYMBOL), b.str(URI), b.u8(DECIMALS)), [w(mint), r(payer.address), w(metadata), w(payer), r(RENT_SYSVAR), r(SYSTEM), r(TOKEN), r(METADATA)]),
      );
    else if (c.impl === "pinocchio") await c.run(payer, c.ix(b.cat(b.u8(0), b.u8(DECIMALS)), [w(mint), r(payer.address), w(payer), r(SYSTEM), r(TOKEN)]));
    else
      await c.run(
        payer,
        c.idl("create_token", { token_title: NAME, token_symbol: SYMBOL, token_uri: URI }, [w(payer), w(mint), w(metadata), r(TOKEN), r(METADATA), r(SYSTEM), r(RENT_SYSVAR)]),
      );

    const mintIx = (whole: bigint) => {
      if (c.impl === "native")
        return c.ix(b.cat(b.u8(2), b.u64(whole * UNIT)), [w(mint.address), w(payer), w(payerAta), w(payer), r(SYSTEM), r(TOKEN), r(ATA_PROGRAM)]);
      if (c.impl === "pinocchio")
        return c.ix(b.cat(b.u8(1), b.u64(whole * UNIT)), [w(mint.address), w(payerAta), r(payer), w(payer), r(payer.address), r(SYSTEM), r(TOKEN), r(ATA_PROGRAM)]);
      return c.idl("mint_token", { amount: new BN(whole.toString()) }, [w(payer), r(payer.address), w(mint.address), w(payerAta), r(TOKEN), r(ATA_PROGRAM), r(SYSTEM)]);
    };
    const transferIx = async (to: string, whole: bigint) => {
      const toAta = await c.ata(to as never, mint.address);
      if (c.impl === "native")
        return c.ix(b.cat(b.u8(3), b.u64(whole * UNIT)), [r(mint.address), w(payerAta), w(toAta), w(payer), r(to as never), w(payer), r(SYSTEM), r(TOKEN), r(ATA_PROGRAM)]);
      if (c.impl === "pinocchio")
        return c.ix(b.cat(b.u8(2), b.u64(whole * UNIT)), [r(mint.address), w(payerAta), w(toAta), r(payer), r(to as never), w(payer), r(SYSTEM), r(TOKEN), r(ATA_PROGRAM)]);
      return c.idl("transfer_tokens", { amount: new BN(whole.toString()) }, [w(payer), r(to as never), w(mint.address), w(payerAta), w(toAta), r(TOKEN), r(ATA_PROGRAM), r(SYSTEM)]);
    };

    // The first mint creates the payer's account (setup); then ROUNDS mints into the existing account.
    await c.run(payer, mintIx(1_000n));
    for (let i = 1; i <= ROUNDS; i++) await c.call("mint_token", payer, mintIx(BigInt(i)));

    // Transfers to wallets without a token account (the instruction creates it), then ROUNDS to an existing one.
    const fresh = [];
    for (let i = 0; i < NEW_RECIPIENTS; i++) {
      const to = (await c.signer(200 + i)).address;
      fresh.push(to);
      await c.call("transfer_tokens (new account)", payer, await transferIx(to, BigInt(i + 1)));
    }
    const recipient = fresh[0];
    for (let i = 1; i <= ROUNDS; i++) await c.call("transfer_tokens", payer, await transferIx(recipient, BigInt(i)));

    const m = c.mint(mint.address)!;
    const balance = (owner: string) => c.ata(owner as never, mint.address).then((a) => c.token(a));
    const outcome = {
      mint: { owner: m.owner, supply: m.supply, decimals: m.decimals, mintAuthority: m.mintAuthority, freezeAuthority: m.freezeAuthority },
      payer: await balance(payer.address),
      recipients: await Promise.all(fresh.map(balance)),
    };
    // Metadata exists everywhere but in Pinocchio: compared among the others only through the decode not throwing.
    if (c.impl !== "pinocchio") decodeMetadata(c.account(metadata).data);

    // A transfer of more than the balance, and one signed by a wallet that does not own the source account.
    await c.probe("transfer above the balance", payer, await transferIx(recipient, 10n ** 9n));
    const stranger = await c.signer(300, 10n * SOL);
    const strangerIx = await (async () => {
      const toAta = await c.ata(recipient, mint.address);
      if (c.impl === "native")
        return c.ix(b.cat(b.u8(3), b.u64(UNIT)), [r(mint.address), w(payerAta), w(toAta), w(stranger), r(recipient), w(stranger), r(SYSTEM), r(TOKEN), r(ATA_PROGRAM)]);
      if (c.impl === "pinocchio")
        return c.ix(b.cat(b.u8(2), b.u64(UNIT)), [r(mint.address), w(payerAta), w(toAta), r(stranger), r(recipient), w(stranger), r(SYSTEM), r(TOKEN), r(ATA_PROGRAM)]);
      return c.idl("transfer_tokens", { amount: new BN(1) }, [w(stranger), r(recipient), w(mint.address), w(payerAta), w(toAta), r(TOKEN), r(ATA_PROGRAM), r(SYSTEM)]);
    })();
    await c.probe("transfer from another wallet's account", stranger, strangerIx);
    return outcome;
  },
};
export default example;
