import { expect, test } from "vitest";
import { util } from "../../shared/utils/util.ts";

test("passive heal particles are reduced by 50% while a player is in a heal region", () => {
    expect(util.getPassiveHealParticleRateMult(true)).toBe(2);
    expect(util.getPassiveHealParticleRateMult(false)).toBe(1);
});
