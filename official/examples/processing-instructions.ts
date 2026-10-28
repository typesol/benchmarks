// basics/processing-instructions. No accounts; the instruction data carries a name and a height and the program logs
// a greeting and a verdict. Anchor/TypeSOL: discriminator + Borsh String + u32; native: Borsh String + u32;
// Pinocchio: an 8-byte fixed name + u32.
import { type Example, ROUNDS, SOL, b } from "../lib.ts";

const fixed8 = (s: string) => {
  const x = Buffer.alloc(8);
  Buffer.from(s, "utf8").copy(x);
  return x;
};

const example: Example = {
  name: "processing-instructions",
  source: "basics/processing-instructions",
  programs: [
    {
      id: "DgoL5J44aspizyUs9fcnpGEUJjWTLJRCfx8eYtUMYczf",
      port: "basics/processing-instructions.ts",
      so: { anchor: "processing_instructions.so", native: "processing_instructions_program.so", pinocchio: "processing_instructions_pinocchio_program.so" },
    },
  ],
  labels: ["go_to_park"],
  notes: "The Pinocchio version takes the name as a fixed 8-byte field (shorter names are zero-padded) instead of a Borsh String.",
  async scenario(c) {
    const payer = await c.signer(1, 100n * SOL);
    const lines: string[][] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const name = i % 2 ? "Jimmy" : "Mary";
      const height = i % 2 ? 3 : 10;
      const ix =
        c.impl === "pinocchio"
          ? c.ix(b.cat(fixed8(name), b.u32(height)), [])
          : c.impl === "native"
            ? c.ix(b.cat(b.str(name), b.u32(height)), [])
            : c.idl("go_to_park", { name, height }, []);
      const res = await c.call("go_to_park", payer, ix);
      lines.push(
        res
          .logs()
          .filter((l) => l.startsWith("Program log: "))
          .map((l) => l.slice(13).replace(/\0/g, ""))
          .filter((l) => !l.startsWith("Instruction:")),
      );
    }
    return lines;
  },
};
export default example;
