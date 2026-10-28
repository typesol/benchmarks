// tokens/escrow. make_offer creates the offer PDA ["offer", maker, id] and its vault (the offer's associated token
// account for mint A) and moves mint A into it; take_offer pays the maker in mint B, releases the vault to the taker
// and closes vault and offer; refund_offer returns the vault to the maker and closes both.
// Encodings: Anchor and TypeSOL use Anchor discriminators + Borsh u64 arguments; native is a Borsh enum (u8 index,
// then the MakeOffer fields); Pinocchio is a u8 discriminator plus the fields and the offer PDA's bump. The account
// orders differ too (native/Pinocchio put the offer first and take an explicit payer).
import { type Address, type KeyPairSigner } from "@solana/kit";
import { ATA_PROGRAM, type Ctx, type Example, ROUNDS, Reader, SOL, SYSTEM, TOKEN, b, disc, r, w } from "../lib.ts";

async function scenario(c: Ctx) {
  const maker = await c.signer(1, 100n * SOL);
  const taker = await c.signer(2, 100n * SOL);
  const mintA = await c.createMint(maker, await c.signer(10), { authority: maker.address });
  const mintB = await c.createMint(taker, await c.signer(11), { authority: taker.address });
  const makerA = await c.fundAta(maker, maker.address, mintA, 1_000_000n);
  const takerB = await c.fundAta(taker, taker.address, mintB, 1_000_000n, { authority: taker });
  // The receiving accounts exist beforehand, so take_offer measures the swap rather than an ATA creation
  // (Anchor/TypeSOL init_if_needed, native "create if empty", Pinocchio CreateIdempotent all skip it then).
  const takerA = await c.fundAta(taker, taker.address, mintA, 0n);
  const makerB = await c.fundAta(maker, maker.address, mintB, 0n);

  const offerOf = async (id: bigint, who: Address = maker.address) => c.pda(["offer", who, b.u64(id)]);
  const vaultOf = (offer: Address) => c.ata(offer, mintA);

  async function make(id: bigint, amountA: bigint, wantB: bigint) {
    const [offer, bump] = await offerOf(id);
    const vault = await vaultOf(offer);
    if (c.impl === "native" || c.impl === "pinocchio") {
      const data = c.impl === "native" ? b.cat(b.u8(0), b.u64(id), b.u64(amountA), b.u64(wantB)) : b.cat(b.u8(0), b.u64(id), b.u64(amountA), b.u64(wantB), b.u8(bump));
      return {
        offer,
        vault,
        ix: c.ix(data, [w(offer), r(mintA), r(mintB), w(makerA), w(vault), w(maker), w(maker), r(TOKEN), r(ATA_PROGRAM), r(SYSTEM)]),
      };
    }
    const data = b.cat(disc("make_offer"), b.u64(id), b.u64(amountA), b.u64(wantB));
    return { offer, vault, ix: c.ix(data, [w(maker), r(mintA), r(mintB), w(makerA), w(offer), w(vault), r(ATA_PROGRAM), r(TOKEN), r(SYSTEM)]) };
  }

  function take(o: { offer: Address; vault: Address }, makerAddress: Address = maker.address, who: KeyPairSigner = taker) {
    const whoA = who === taker ? takerA : makerA;
    const whoB = who === taker ? takerB : makerB;
    if (c.nativeLike)
      return c.ix(b.u8(1), [w(o.offer), r(mintA), r(mintB), w(makerB), w(whoA), w(whoB), w(o.vault), r(makerAddress), w(who), w(who), r(TOKEN), r(ATA_PROGRAM), r(SYSTEM)]);
    return c.ix(disc("take_offer"), [w(who), w(makerAddress), r(mintA), r(mintB), w(whoA), w(whoB), w(makerB), w(o.offer), w(o.vault), r(ATA_PROGRAM), r(TOKEN), r(SYSTEM)]);
  }

  function refund(o: { offer: Address; vault: Address }, who: KeyPairSigner = maker, whoA: Address = makerA) {
    if (c.nativeLike) {
      const accounts = [w(o.offer), r(mintA), w(whoA), w(o.vault), w(who), r(TOKEN)];
      if (c.impl === "native") accounts.push(r(SYSTEM));
      return c.ix(b.u8(2), accounts);
    }
    return c.ix(disc("refund_offer"), [w(who), r(mintA), w(whoA), w(o.offer), w(o.vault), r(TOKEN)]);
  }

  const closed: boolean[] = [];
  for (let id = 1n; id <= BigInt(ROUNDS); id++) {
    const o = await make(id, id * 1_000n, id * 300n);
    await c.call("make_offer", maker, o.ix);
    if (id % 2n) await c.call("take_offer", taker, take(o));
    else await c.call("refund_offer", maker, refund(o));
    closed.push(!c.account(o.offer).exists && !c.account(o.vault).exists);
  }
  // One offer left open: its decoded fields are part of the outcome.
  const open = await make(100n, 4_242n, 77n);
  await c.call("make_offer", maker, open.ix);
  const acc = c.account(open.offer);
  const rd = new Reader(acc.data).skip(c.nativeLike ? 0 : 8);
  const offer = { id: rd.u64(), maker: rd.key(), mintA: rd.key(), mintB: rd.key(), wantB: rd.u64(), bump: rd.u8(), owner: acc.owner };
  const outcome = {
    closed,
    offer,
    balances: [makerA, makerB, takerA, takerB, open.vault].map((a) => c.token(a)?.amount ?? null),
    vaultAuthority: c.token(open.vault)?.authority,
  };

  // Hostile calls, after the outcome is captured.
  await c.probe("take naming the taker as the maker", taker, take(open, taker.address));
  await c.probe("refund signed by someone other than the maker", taker, refund(open, taker, takerA));
  return outcome;
}

const example: Example = {
  name: "escrow",
  source: "tokens/escrow",
  programs: [
    {
      id: "3o3jk7aj2aGCGsbChkgeNdHcBmeEmGA7BtpnTXdVSgtr",
      port: "tokens/escrow.ts",
      so: { anchor: "escrow.so", native: "escrow_native_program.so", pinocchio: "escrow_pinocchio_program.so" },
    },
  ],
  labels: ["make_offer", "take_offer", "refund_offer"],
  notes:
    "The taker's mint A and the maker's mint B token accounts exist before take_offer, so no implementation creates them there. " +
    "Anchor and TypeSOL move tokens with TransferChecked and check the mints' token program and the offer's account type; the native and " +
    "Pinocchio versions use Transfer, read the offer without an owner or type check, and send the vault's rent to the taker and the offer's " +
    "to the payer (Anchor: both to the maker). Pinocchio takes the offer's bump from the client instead of searching for it.",
  scenario,
};
export default example;
