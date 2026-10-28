// basics/counter. Anchor: `initialize_counter` creates a keypair account (8-byte discriminator + count) and
// `increment` adds one. Native / Pinocchio: the client creates an 8-byte account owned by the program and
// instruction 0 increments it; there is no initialize. TypeSOL: as Anchor (`counter.create(payer, null)`).
import { type Example, ROUNDS, Reader, SOL, SYSTEM, b, r, w } from "../lib.ts";

const example: Example = {
  name: "counter",
  source: "basics/counter",
  programs: [
    {
      id: "BmDHboaj1kBUoinJKKSRqKfMeRKJqQqEbUj1VgzeQe4A",
      port: "basics/counter.ts",
      so: { anchor: "counter_anchor.so", native: "counter_solana_native.so", pinocchio: "counter_solana_pinocchio.so" },
    },
  ],
  labels: ["increment"],
  notes:
    "Only increment is compared: the native and Pinocchio versions have no initialize (the client creates a zeroed 8-byte account), " +
    "while Anchor's initialize_counter creates the account itself. The native and Pinocchio increment do not check the account's owner or type.",
  async scenario(c) {
    const payer = await c.signer(1, 100n * SOL);
    const counter = await c.signer(2);
    if (!c.nativeLike) {
      await c.run(payer, c.idl("initialize_counter", {}, [w(payer), w(counter), r(SYSTEM)]));
    } else {
      await c.run(payer, c.createAccount(payer, counter, 8));
    }
    const increment = () => (c.nativeLike ? c.ix(b.u8(0), [w(counter.address)]) : c.idl("increment", {}, [w(counter.address)]));
    for (let i = 0; i < ROUNDS; i++) await c.call("increment", payer, increment());
    const acc = c.account(counter.address);
    const count = new Reader(acc.data).skip(c.nativeLike ? 0 : 8).u64();
    const outcome = { count, owner: acc.owner };
    // u64::MAX + 1 must abort (Anchor checked_add().unwrap(), overflow-checks in the Rust release profile, TypeSOL checked +=).
    const max = Buffer.from(acc.data);
    max.writeBigUInt64LE(2n ** 64n - 1n, c.nativeLike ? 0 : 8);
    c.svm.setAccount({ address: counter.address, data: new Uint8Array(max), executable: false, lamports: acc.lamports, programAddress: acc.owner as never, space: BigInt(max.length) });
    await c.probe("increment past u64::MAX", payer, increment());
    return outcome;
  },
};
export default example;
