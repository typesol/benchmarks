// tokens/create-token. One instruction creates a keypair mint (System CreateAccount + InitializeMint) and its
// Metaplex metadata account (CreateMetadataAccountV3) in every implementation.
// Anchor / TypeSOL: `create_token_mint(decimals, name, symbol, uri)` with Anchor's encoding; the mint authority is the
// payer and there is no freeze authority. Native / Pinocchio: the whole instruction data is Borsh
// `{ name, symbol, uri, decimals }` (no discriminator); the mint authority account is passed explicitly (the payer here)
// and also becomes the freeze authority.
import type { Address } from "@solana/kit";
import { type Example, METADATA, METADATA_SO, RENT_SYSVAR, Reader, SOL, SYSTEM, TOKEN, b, r, w } from "../lib.ts";

const ROUNDS_CREATE = 5;
const NAME = "Solana Gold";
const SYMBOL = "GOLDSOL";
const URI = "https://raw.githubusercontent.com/solana-developers/program-examples/new-examples/tokens/tokens/.assets/spl-token.json";
const DECIMALS = 9;

/** Metaplex Metadata: key, update authority, mint, then name/symbol/uri (zero-padded Borsh strings), seller fee. */
export function decodeMetadata(data: Buffer) {
  const rd = new Reader(data);
  const key = rd.u8();
  const updateAuthority = rd.key();
  const mint = rd.key();
  const trim = (s: string) => s.replace(/\0+$/, "");
  return { key, updateAuthority, mint, name: trim(rd.str()), symbol: trim(rd.str()), uri: trim(rd.str()), sellerFeeBasisPoints: rd.u16() };
}

export async function metadataPda(c: { pda: (s: (string | Address | Uint8Array)[], p?: Address) => Promise<[Address, number]> }, mint: Address) {
  const [a] = await c.pda(["metadata", METADATA, mint], METADATA);
  return a;
}

const example: Example = {
  name: "create-token",
  source: "tokens/create-token",
  programs: [
    {
      id: "GwvQ53QTu1xz3XXYfG5m5jEqwhMBvVBudPS8TUuFYnhT",
      port: "tokens/create-token.ts",
      so: { anchor: "create_token.so", native: "create_token_program.so", pinocchio: "create_token_pinocchio_program.so" },
    },
  ],
  extra: [{ id: METADATA, so: METADATA_SO }],
  labels: ["create_token_mint"],
  notes:
    "Each call creates a mint and its Metaplex metadata account; most of the cost is the Token Metadata CPI. " +
    "The native and Pinocchio versions also set the mint authority as freeze authority (Anchor and TypeSOL leave it unset); the freeze authority is not part of the compared outcome. " +
    "The native and Pinocchio versions do not check the metadata PDA, the program accounts or the mint authority themselves (the token and metadata programs do); the native one uses InitializeMint with the rent sysvar, the others InitializeMint2.",
  async scenario(c) {
    const payer = await c.signer(1, 100n * SOL);
    const created = [];
    for (let i = 0; i < ROUNDS_CREATE; i++) {
      const mint = await c.signer(100 + i);
      const metadata = await metadataPda(c, mint.address);
      let ix;
      if (c.nativeLike) {
        const data = b.cat(b.str(NAME), b.str(SYMBOL), b.str(URI), b.u8(DECIMALS));
        ix =
          c.impl === "native"
            ? c.ix(data, [w(mint), r(payer.address), w(metadata), w(payer), r(RENT_SYSVAR), r(SYSTEM), r(TOKEN), r(METADATA)])
            : c.ix(data, [w(mint), r(payer.address), w(metadata), w(payer), r(SYSTEM), r(TOKEN), r(METADATA)]);
      } else {
        ix = c.idl("create_token_mint", { token_decimals: DECIMALS, token_name: NAME, token_symbol: SYMBOL, token_uri: URI }, [
          w(payer),
          w(metadata),
          w(mint),
          r(METADATA),
          r(TOKEN),
          r(SYSTEM),
          r(RENT_SYSVAR),
        ]);
      }
      await c.call("create_token_mint", payer, ix);
      const m = c.mint(mint.address)!;
      const meta = c.account(metadata);
      created.push({
        mint: { owner: m.owner, supply: m.supply, decimals: m.decimals, mintAuthority: m.mintAuthority },
        metadata: { owner: meta.owner, ...decodeMetadata(meta.data) },
      });
    }
    return created;
  },
};
export default example;
