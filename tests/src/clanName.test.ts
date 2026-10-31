import { expect, test } from "vitest";
import { clanTextBlocked } from "../../shared/utils/clan.ts";

test("clan names / tags with a blocked letter group are refused", () => {
    for (const s of ["Ninja", "NINJAS", "N1nja", "N!NJA", "N.I.G", "N i g", "NGR", "n-g-r", "Ni Gang", "Night", "Knights"]) {
        expect(clanTextBlocked(s), s).toBe(true);
    }
    for (const s of ["The Fries Mafia", "TCR", "2009", "Unity", "Phoenix", "Vanilla"]) {
        expect(clanTextBlocked(s), s).toBe(false);
    }
});
