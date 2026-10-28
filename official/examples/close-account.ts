// basics/close-account. `create_user` creates the user's PDA ["USER", user] with a CPI and stores the name;
// `close_user` gives the rent back. Anchor/TypeSOL: discriminator + Borsh String; the account holds bump, user and
// name (TypeSOL: FixedString<50> with @layout borsh, Anchor's bytes). Native: Borsh enum (0 + String / 1), the account holds the Borsh name.
// Pinocchio: 0 + bump + a fixed 16-byte name copied into a 16-byte account / 1.
// Closing: Anchor and TypeSOL drain the account (it disappears); native and Pinocchio refund all but the rent of an
// empty account, shrink it to 0 bytes and assign it to the System Program.
import { type Example, ROUNDS, Reader, SOL, SYSTEM, b, disc, r, w } from "../lib.ts";

const NAME = "John Doe";
const fixed16 = (s: string) => {
  const x = Buffer.alloc(16);
  Buffer.from(s, "utf8").copy(x);
  return x;
};

const example: Example = {
  name: "close-account",
  source: "basics/close-account",
  programs: [
    {
      id: "99TQtoDdQ5NS2v5Ppha93aqEmv3vV9VZVfHTP5rGST3c",
      port: "basics/close-account.ts",
      so: { anchor: "close_account_program.so", native: "close_account_native_program.so", pinocchio: "close_account_pinocchio_program.so" },
    },
  ],
  labels: ["create_user", "close_user"],
  notes:
    "The native and Pinocchio versions store only the name (Pinocchio: a fixed 16-byte field, with the bump passed by the client), not the bump and user key Anchor stores; " +
    "on close they keep the rent of an empty account in it (0 bytes, owned by the System Program) where Anchor and TypeSOL close it entirely. " +
    "Pinocchio's create_user signs with the bump the client passes and does not search for it (the others derive the canonical bump on chain, a find_program_address of several thousand CU); its close_user does the search. " +
    "Compared: the stored name, and that the closed account holds no data and is no longer owned by the program.",
  async scenario(c) {
    const users = [];
    for (let i = 0; i <= ROUNDS; i++) users.push(await c.signer(100 + i, 10n * SOL));
    const pdas = [];
    const names = [];
    for (const user of users) {
      const [pda, bump] = await c.pda(["USER", user.address]);
      pdas.push(pda);
      const ix =
        c.impl === "native"
          ? c.ix(b.cat(b.u8(0), b.str(NAME)), [w(pda), w(user), r(SYSTEM)])
          : c.impl === "pinocchio"
            ? c.ix(b.cat(b.u8(0), b.u8(bump), fixed16(NAME)), [w(pda), w(user), r(SYSTEM)])
            : c.idl("create_user", { name: NAME }, [w(user), w(pda), r(SYSTEM)]);
      await c.call("create_user", user, ix);
      const d = c.account(pda).data;
      const name =
        c.impl === "pinocchio"
          ? d.toString("utf8").replace(/\0+$/, "")
          : c.impl === "native"
            ? new Reader(d).str()
            : c.impl === "anchor"
              ? new Reader(d).skip(8 + 1 + 32).str()
              : new Reader(d).skip(8 + 1 + 32).fixed(50);
      names.push(name);
    }
    const close = (i: number, signer = users[i]) =>
      c.nativeLike ? c.ix(b.u8(1), [w(pdas[i]), w(signer), r(SYSTEM)]) : c.ix(disc("close_user"), [w(signer), w(pdas[i])]);
    for (let i = 0; i < ROUNDS; i++) await c.call("close_user", users[i], close(i));
    const state = pdas.map((p) => {
      const a = c.account(p);
      return a.exists && a.owner === c.id ? "open" : a.data.length === 0 && a.owner !== c.id ? "closed" : "other";
    });
    const outcome = { names, state };
    // A stranger may not close the last user's account.
    const stranger = await c.signer(999, 10n * SOL);
    await c.probe("stranger closes another user's account", stranger, close(ROUNDS, stranger));
    return outcome;
  },
};
export default example;
