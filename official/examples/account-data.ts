// basics/account-data. Every variant creates a keypair account holding an address record in one transaction.
// Anchor: `create_address_info` creates the account (`init`, 8 + 163 bytes, Borsh Strings). Native: Borsh
// AddressInfo as the instruction data, a CreateAccount CPI sized to it. Pinocchio: instruction 0 followed by a fixed
// 51-byte record (16-byte name, pad, house number, 16-byte street, pad, 16-byte city) copied into a 51-byte account.
// TypeSOL: as Anchor (`addressInfo.create(payer, null)`, `@layout borsh`).
import { type Example, ROUNDS, Reader, SOL, SYSTEM, b, r, w } from "../lib.ts";

const fixed16 = (s: string) => {
  const x = Buffer.alloc(16);
  Buffer.from(s, "utf8").copy(x);
  return x;
};
const unpad = (x: Buffer) => x.toString("utf8").replace(/\0+$/, "");

const example: Example = {
  name: "account-data",
  source: "basics/account-data",
  programs: [
    {
      id: "GpVcgWdgVErgLqsn8VYUch6EqDerMgNqoLSmGyKrd6MR",
      port: "basics/account-data.ts",
      so: { anchor: "account_data_anchor_program.so", native: "account_data_native_program.so", pinocchio: "account_data_pinocchio_program.so" },
    },
  ],
  labels: ["create_address_info (tx)"],
  notes:
    "Measured as the whole creating transaction; every variant creates the keypair account with a CPI inside the instruction. " +
    "Account layouts differ (Anchor and TypeSOL: Borsh Strings in 171 bytes; native: Borsh sized to the data; Pinocchio: fixed 51-byte record with 16-byte fields); the decoded fields are compared. " +
    "The native version does not check the system program account; Pinocchio caps each string at 16 bytes.",
  async scenario(c) {
    const payer = await c.signer(1, 100n * SOL);
    const records = [];
    for (let i = 0; i < ROUNDS; i++) {
      const info = await c.signer(100 + i);
      const name = `Joe C ${i}`;
      const house = 100 + i;
      const street = "Mile High Dr.";
      const city = "Solana Beach";
      const args = { name, house_number: house, street, city };
      let ixs;
      if (!c.nativeLike) ixs = [c.idl("create_address_info", args, [w(payer), w(info), r(SYSTEM)])];
      else if (c.impl === "native") ixs = [c.ix(b.cat(b.str(name), b.u8(house), b.str(street), b.str(city)), [w(info), w(payer), r(SYSTEM)])];
      else ixs = [c.ix(b.cat(b.u8(0), fixed16(name), b.u8(0), b.u8(house), fixed16(street), b.u8(0), fixed16(city)), [w(info), w(payer), r(SYSTEM)])];
      await c.callTx("create_address_info (tx)", payer, ixs);
      const acc = c.account(info.address);
      let rec;
      if (c.impl === "pinocchio") {
        const d = acc.data;
        rec = { name: unpad(d.subarray(0, 16)), house: d[17], street: unpad(d.subarray(18, 34)), city: unpad(d.subarray(35, 51)) };
      } else {
        const rd = new Reader(acc.data).skip(c.impl === "native" ? 0 : 8);
        rec = { name: rd.str(), house: rd.u8(), street: rd.str(), city: rd.str() };
      }
      records.push({ ...rec, owner: acc.owner, rentExempt: acc.lamports >= c.rent(acc.data.length) });
    }
    return records;
  },
};
export default example;
