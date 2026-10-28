// basics/program-derived-addresses. Anchor: `create_page_visits` creates the PDA ["page_visits", payer] and stores
// { page_visits: 0, bump } (canonical bump found on chain); `increment_page_visits` checks the PDA from `user` and
// the stored bump and adds one. Native: the data is parsed as PageVisits { u32, bump } (create, 5 bytes) or as the
// empty IncrementPageVisits (increment). Pinocchio: 0 + { u32, bump } = create, 1 = increment. Both create the PDA
// with the client's bump and leave its data zeroed; their increment only takes the page-visits account.
import { type Address, type KeyPairSigner } from "@solana/kit";
import { type Ctx, type Example, ROUNDS, Reader, SOL, SYSTEM, b, r, w } from "../lib.ts";

function create(c: Ctx, payer: KeyPairSigner, pda: Address, bump: number) {
  switch (c.impl) {
    case "anchor":
    case "typesol":
      return c.idl("create_page_visits", {}, [w(payer), w(pda), r(SYSTEM)]);
    case "native":
      return c.ix(b.cat(b.u32(0), b.u8(bump)), [w(pda), r(payer.address), w(payer), r(SYSTEM)]);
    case "pinocchio":
      return c.ix(b.cat(b.u8(0), b.u32(0), b.u8(bump)), [w(pda), r(payer.address), w(payer), r(SYSTEM)]);
  }
}

function increment(c: Ctx, payer: KeyPairSigner, user: Address, pda: Address) {
  switch (c.impl) {
    case "anchor":
    case "typesol":
      return c.idl("increment_page_visits", {}, [r(user), w(pda)]);
    case "native":
      return c.ix(Buffer.alloc(0), [w(pda), w(payer)]);
    case "pinocchio":
      return c.ix(b.u8(1), [w(pda)]);
  }
}

const example: Example = {
  name: "program-derived-addresses",
  source: "basics/program-derived-addresses",
  programs: [
    {
      id: "oCCQRZyAbVxujyd8m57MPmDzZDmy2FoKW4ULS7KofCE",
      port: "basics/program-derived-addresses.ts",
      so: { anchor: "program_derived_addresses_program.so", native: "program_derived_addresses_native_program.so", pinocchio: "program_derived_addresses_pinocchio_program.so" },
    },
  ],
  labels: ["create_page_visits", "increment_page_visits"],
  notes:
    "Anchor and TypeSOL find the canonical bump on chain at creation, store it, and check the PDA against the user and the stored bump on " +
    "every increment; the native and Pinocchio versions sign with the bump the client sends, do not store it (their account stays zeroed " +
    "until the first increment), and their increment checks neither the address nor the owner of the account. The stored bump is therefore " +
    "not compared, only the visit count.",
  async scenario(c) {
    const pages = [];
    for (let i = 0; i < ROUNDS; i++) {
      const payer = await c.signer(100 + i, 10n * SOL);
      const [pda, bump] = await c.pda(["page_visits", payer.address]);
      pages.push({ payer, pda });
      await c.call("create_page_visits", payer, create(c, payer, pda, bump));
    }
    // The first page is visited ROUNDS times, the second once.
    for (let i = 0; i < ROUNDS; i++) await c.call("increment_page_visits", pages[0].payer, increment(c, pages[0].payer, pages[0].payer.address, pages[0].pda));
    await c.call("increment_page_visits", pages[1].payer, increment(c, pages[1].payer, pages[1].payer.address, pages[1].pda));
    const outcome = pages.map(({ pda }) => {
      const acc = c.account(pda);
      return { owner: acc.owner, visits: new Reader(acc.data).skip(c.nativeLike ? 0 : 8).u32() };
    });
    // Another user's address does not derive the first page's PDA (only Anchor and TypeSOL take the user).
    const other = await c.signer(2, SOL);
    await c.probe("increment_page_visits naming another user", pages[0].payer, increment(c, pages[0].payer, other.address, pages[0].pda));
    return outcome;
  },
};
export default example;
