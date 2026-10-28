// basics/favorites. Anchor: `set_favorites(number, color, hobbies: Vec<String>)` creates (init_if_needed) or
// overwrites the PDA ["favorites", user] (344 bytes, Borsh strings). Native: CreatePda(Favorites) (enum index 0)
// creates the PDA ["favorite", user] sized to the Borsh data and refuses an existing one; GetPda logs it. Pinocchio:
// 1 = create with a client-supplied bump, fixed fields (u64, color [u8; 8], hobbies [[u8; 16]; 4], 80 bytes).
// TypeSOL: as Anchor (`hobbies: Vec<string>`, the account in Anchor's bytes with `@layout borsh`).
import { BN } from "@anchor-lang/core";
import { type Address } from "@solana/kit";
import { type Ctx, type Example, ROUNDS, Reader, SOL, SYSTEM, b, disc, r, w } from "../lib.ts";

const NUMBER = 23n;
const COLOR = "purple";
// Four hobbies of at most 16 bytes: the Pinocchio layout holds exactly that.
const HOBBIES = ["coding", "reading", "biking", "swimming"];

const fixed = (s: string, n: number) => {
  const x = Buffer.alloc(n);
  Buffer.from(s, "utf8").copy(x);
  return x;
};
const trimNul = (s: string) => s.replace(/\0+$/, "");

function setFavorites(c: Ctx, user: { address: Address }, pda: Address, bump: number, number: bigint, hobbies: string[]) {
  const accounts = [w(user as never), w(pda), r(SYSTEM)];
  switch (c.impl) {
    case "anchor":
      return c.ix(b.cat(disc("set_favorites"), b.u64(number), b.str(COLOR), b.vec(hobbies.map(b.str))), accounts);
    case "typesol":
      return c.idl("set_favorites", { number: new BN(number.toString()), color: COLOR, hobbies }, accounts);
    case "native":
      return c.ix(b.cat(b.u8(0), b.u64(number), b.str(COLOR), b.vec(hobbies.map(b.str))), accounts);
    case "pinocchio":
      return c.ix(b.cat(b.u8(1), b.u8(bump), b.u64(number), fixed(COLOR, 8), ...hobbies.map((h) => fixed(h, 16))), accounts);
  }
}

function read(c: Ctx, pda: Address) {
  const acc = c.account(pda);
  if (!acc.exists) return null;
  const d = new Reader(acc.data);
  switch (c.impl) {
    case "anchor":
    case "typesol": {
      d.skip(8);
      const number = d.u64();
      const color = d.str();
      const n = d.u32();
      return { owner: acc.owner, number, color, hobbies: Array.from({ length: n }, () => d.str()) };
    }
    case "native": {
      const number = d.u64();
      const color = d.str();
      const n = d.u32();
      return { owner: acc.owner, number, color, hobbies: Array.from({ length: n }, () => d.str()) };
    }
    case "pinocchio": {
      const number = d.u64();
      const color = trimNul(acc.data.subarray(8, 16).toString("utf8"));
      const hobbies = [0, 1, 2, 3].map((i) => trimNul(acc.data.subarray(16 + 16 * i, 32 + 16 * i).toString("utf8")));
      return { owner: acc.owner, number, color, hobbies };
    }
  }
}

const example: Example = {
  name: "favorites",
  source: "basics/favorites",
  programs: [
    {
      id: "ww9C83noARSQVBnqmCUmaVdbJjmiwcV9j2LkXYMoUCV",
      port: "basics/favorites.ts",
      so: { anchor: "favorites.so", native: "favorites_native.so", pinocchio: "favorites_pinocchio.so" },
    },
  ],
  labels: ["set_favorites (create)"],
  notes:
    "Only the first set_favorites, which creates the user's PDA, is compared: the native and Pinocchio versions refuse to write an existing " +
    "account (Anchor and TypeSOL overwrite it), and they have no update. The variants store different layouts: Anchor and TypeSOL 344 bytes with Borsh " +
    "strings, native exactly the Borsh size, Pinocchio 80 bytes of fixed fields (color 8 bytes, " +
    "4 hobbies of 16) with the bump passed by the client (no on-chain bump search); the PDA seed is \"favorites\" in Anchor/TypeSOL and \"favorite\" in " +
    "native/Pinocchio. Pinocchio does not check that the instruction data fits its layout beyond the copy.",
  async scenario(c) {
    const seed = c.nativeLike ? "favorite" : "favorites";
    const users = [];
    for (let i = 0; i < ROUNDS; i++) {
      const user = await c.signer(100 + i, 10n * SOL);
      const [pda, bump] = await c.pda([seed, user.address]);
      users.push({ user, pda });
      await c.call("set_favorites (create)", user, setFavorites(c, user, pda, bump, NUMBER + BigInt(i), HOBBIES));
    }
    const outcome = users.map(({ pda }) => read(c, pda));
    const { user, pda } = users[0];
    const [, bump] = await c.pda([seed, user.address]);
    await c.probe("a second set_favorites (update)", user, setFavorites(c, user, pda, bump, 7n, HOBBIES));
    const other = await c.signer(2, 10n * SOL);
    await c.probe("set_favorites by another signer on this user's PDA", other, setFavorites(c, other, pda, bump, 7n, HOBBIES));
    return outcome;
  },
};
export default example;
