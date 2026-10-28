// basics/cross-program-invocation: `hand` calls `lever`'s switch_power through a CPI.
// Anchor: lever `initialize` creates the keypair power account (8 + 8 bytes) itself; hand `pull_lever(name)` checks
// the account is a lever PowerStatus and CPIs switch_power(name). Native: lever tells its instructions apart by which
// Borsh struct the data parses as (initialize = PowerStatus { is_on }, 1 byte; switch_power = { name: String }); hand
// forwards its data unchanged. Pinocchio: lever 0 = initialize, 1 + raw name bytes = switch_power; hand takes the raw
// name. Native and Pinocchio lever create the 1-byte account with a CreateAccount CPI. TypeSOL: as Anchor
// (`power.create(user, null, 8n + 8n)`).
import { type Example, ROUNDS, SOL, SYSTEM, b, r, w } from "../lib.ts";

const HAND = 0;
const LEVER = 1;

const example: Example = {
  name: "cross-program-invocation",
  source: "basics/cross-program-invocation",
  programs: [
    {
      id: "59c3ER1YrnnnezUVH7ix4WDUw9TQ9k7xH6wQyAmWvc52",
      port: "basics/cross-program-invocation/hand.ts",
      so: { anchor: "hand.so", native: "cross_program_invocatio_native_hand.so", pinocchio: "cross_program_invocation_pinocchio_hand.so" },
    },
    {
      id: "A6GUsa5Ej8iWzMMP3B6otFVB5aaUckVm8a31Y5TMLYRV",
      port: "basics/cross-program-invocation/lever.ts",
      so: { anchor: "lever.so", native: "cross_program_invocatio_native_lever.so", pinocchio: "cross_program_invocation_pinocchio_lever.so" },
    },
  ],
  labels: ["initialize (tx)", "pull_lever"],
  notes:
    "Binary sizes are hand + lever. initialize (tx) is the whole transaction that creates and initializes the power account: " +
    "every variant creates it inside lever's initialize (CreateAccount CPI). pull_lever includes the CPI into lever. " +
    "Anchor and TypeSOL hand check that power is a lever PowerStatus account before the CPI; the native and Pinocchio hand forward any account " +
    "(lever's own data parsing and the runtime's owner rule still stop a foreign account).",
  async scenario(c) {
    const user = await c.signer(1, 100n * SOL);
    const lever = c.ids[LEVER];
    const powers = [];
    for (let i = 0; i < ROUNDS; i++) {
      const power = await c.signer(100 + i);
      powers.push(power.address);
      switch (c.impl) {
        case "anchor":
        case "typesol":
          await c.callTx("initialize (tx)", user, [c.idl("initialize", {}, [w(power), w(user), r(SYSTEM)], LEVER)]);
          break;
        case "native":
          await c.callTx("initialize (tx)", user, [c.ix(b.bool(false), [w(power), w(user), r(SYSTEM)], lever)]);
          break;
        case "pinocchio":
          await c.callTx("initialize (tx)", user, [c.ix(b.u8(0), [w(power), w(user), r(SYSTEM)], lever)]);
          break;
      }
    }
    const pull = (name: string, power = powers[0]) => {
      const accounts = [w(power), r(lever)];
      if (c.impl === "native") return c.ix(b.str(name), accounts, c.ids[HAND]);
      if (c.impl === "pinocchio") return c.ix(Buffer.from(name, "utf8"), accounts, c.ids[HAND]);
      return c.idl("pull_lever", { name }, accounts, HAND);
    };
    // ROUNDS + 1 pulls on the first lever (ends on), one on the second (on); the rest stay off.
    for (let i = 0; i <= ROUNDS; i++) await c.call("pull_lever", user, pull(i % 2 ? "Ashley" : "Chris"));
    await c.call("pull_lever", user, pull("Chris", powers[1]));
    const isOn = (a: (typeof powers)[number]) => {
      const acc = c.account(a);
      // Anchor / TypeSOL: 8-byte discriminator then the bool; native / Pinocchio: the bool alone.
      return { owner: acc.owner, isOn: acc.data[c.nativeLike ? 0 : 8] === 1 };
    };
    const outcome = { powers: powers.map(isOn) };
    // A System-owned account posing as the power account.
    const stranger = await c.signer(2, SOL);
    await c.probe("pull_lever on an account lever does not own", user, pull("Mallory", stranger.address));
    return outcome;
  },
};
export default example;
