import { expect, test } from "vitest";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { MsgType, SpectateMsg } from "../../shared/net/net.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";
import "./testHelpers.ts";

const specBegin = new SpectateMsg();
specBegin.specBegin = true;

const specNext = new SpectateMsg();
specNext.specNext = true;

const specPrev = new SpectateMsg();
specPrev.specPrev = true;

const spectateDeathCooldown = 2;
const spectateTeammateCooldown = 0.1;
const spectateSoloCooldown = 1;

test("Spectate killer", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    game.preventStart = true;

    const playerA = game.playerBarn.addTestPlayer({});
    const playerB = game.playerBarn.addTestPlayer({});
    const playerC = game.playerBarn.addTestPlayer({});
    const playerD = game.playerBarn.addTestPlayer({});

    playerA.damage({
        damageType: GameConfig.DamageType.Player,
        source: playerB,
        amount: 999,
        dir: v2.randomUnit(),
    });
    playerA.spectate(specBegin);
    expect(playerA.spectating).toBeSamePlayer(playerB);

    playerB.damage({
        damageType: GameConfig.DamageType.Player,
        source: playerC,
        amount: 999,
        dir: v2.randomUnit(),
    });
    // this fork has no spectate death cooldown: when the spectated player dies we
    // immediately switch to their (still alive) killer
    expect(playerA.spectating).toBeSamePlayer(playerC);

    game.step(spectateDeathCooldown);
    expect(playerA.spectating).toBeSamePlayer(playerC);

    playerC.damage({
        damageType: GameConfig.DamageType.Player,
        source: playerC,
        amount: 999,
        dir: v2.randomUnit(),
    });

    // killer suicided, so there's no alive killer to fall back to; the only
    // remaining living player is playerD
    game.step(spectateDeathCooldown);
    expect(playerA.spectating).toBeSamePlayer(playerD);
});

test("Spectate solo", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    game.preventStart = true;

    const playerA = game.playerBarn.addTestPlayer({});
    const playerB = game.playerBarn.addTestPlayer({});
    const playerC = game.playerBarn.addTestPlayer({});
    const playerD = game.playerBarn.addTestPlayer({});

    playerA.damage({
        damageType: GameConfig.DamageType.Player,
        source: playerB,
        amount: 999,
        dir: v2.randomUnit(),
    });
    playerA.spectate(specBegin);
    expect(playerA.spectating).toBeSamePlayer(playerB);

    playerA.spectate(specNext);
    game.step(spectateSoloCooldown);
    expect(playerA.spectating).toBeSamePlayer(playerC);

    playerA.spectate(specNext);
    game.step(spectateSoloCooldown);
    expect(playerA.spectating).toBeSamePlayer(playerD);

    playerA.spectate(specNext);
    game.step(spectateSoloCooldown);
    expect(playerA.spectating).toBeSamePlayer(playerB);

    playerA.spectate(specPrev);
    game.step(spectateSoloCooldown);
    expect(playerA.spectating).toBeSamePlayer(playerD);

    // no spectate cooldown in this fork: specNext switches immediately, wrapping
    // from playerD back around to playerB
    playerA.spectate(specNext);
    game.step(0.4);
    expect(playerA.spectating).toBeSamePlayer(playerB);
    game.step(1);
    expect(playerA.spectating).toBeSamePlayer(playerB);

    // the spectated player (playerB) dies -> immediately switch to their killer (playerC)
    playerB.damage({
        damageType: GameConfig.DamageType.Player,
        source: playerC,
        amount: 999,
        dir: v2.randomUnit(),
    });
    game.step(0.1);
    expect(playerA.spectating).toBeSamePlayer(playerC);

    playerA.spectate(specNext);
    game.step(0.4);
    expect(playerA.spectating).toBeSamePlayer(playerD);

    playerA.spectate(specPrev);
    game.step(spectateSoloCooldown);
    // playerB is dead so prev skips them, landing back on playerC
    expect(playerA.spectating).toBeSamePlayer(playerC);
});

test("Spectate teammates", () => {
    const game = createGame(TeamMode.Squad, "test_normal");
    game.preventStart = true;

    const group = game.playerBarn.addGroup(false, false);

    const playerA = game.playerBarn.addTestPlayer({ group });
    const playerB = game.playerBarn.addTestPlayer({ group });
    const playerC = game.playerBarn.addTestPlayer({ group });
    const playerD = game.playerBarn.addTestPlayer({ group });

    const playerE = game.playerBarn.addTestPlayer({});

    playerA.kill({
        damageType: GameConfig.DamageType.Player,
        source: playerE,
        amount: 999,
        dir: v2.randomUnit(),
    });

    // Team mode starts spectating a *random* living teammate, and specNext/specPrev
    // navigate within the living teammates, so assert membership rather than a fixed
    // player (there is no spectate cooldown in this fork).
    const teammateIds = [playerB, playerC, playerD].map((p) => p.__id);
    const spectatingId = () => playerA.spectating?.__id;

    playerA.spectate(specBegin);
    expect(teammateIds).toContain(spectatingId());

    playerA.spectate(specNext);
    game.step(spectateTeammateCooldown);
    expect(teammateIds).toContain(spectatingId());

    playerA.spectate(specPrev);
    game.step(spectateTeammateCooldown);
    expect(teammateIds).toContain(spectatingId());

    playerA.spectate(specPrev);
    game.step(spectateTeammateCooldown);
    expect(teammateIds).toContain(spectatingId());

    for (const player of [playerB, playerC, playerD]) {
        // "are their heads all going to explode"
        // - Noelle seeing me write this

        player.kill({
            damageType: GameConfig.DamageType.Player,
            source: playerE,
            amount: 999,
            dir: v2.randomUnit(),
        });
    }
    // all teammates are dead now; advancing lands on the only remaining living
    // player, the (non-teammate) playerE
    playerA.spectate(specNext);
    expect(playerA.spectating).toBeSamePlayer(playerE);
});

test("Spectate faction teammtes", () => {
    const game = createGame(TeamMode.Squad, "test_faction");
    game.preventStart = true;

    const teamA = game.playerBarn.addTeam(1);
    const group = game.playerBarn.addGroup(false, false);

    const playerA = game.playerBarn.addTestPlayer({ team: teamA, group });
    const playerB = game.playerBarn.addTestPlayer({ team: teamA, group });
    const playerC = game.playerBarn.addTestPlayer({ team: teamA, group });
    const playerD = game.playerBarn.addTestPlayer({ team: teamA, group });
    const playerE = game.playerBarn.addTestPlayer({ team: teamA, group });
    const playerF = game.playerBarn.addTestPlayer({ team: teamA, group });

    const teamB = game.playerBarn.addTeam(2);
    game.playerBarn.addTestPlayer({ team: teamB });

    playerA.kill({
        damageType: GameConfig.DamageType.Player,
        source: playerE,
        amount: 999,
        dir: v2.randomUnit(),
    });

    // As in squad mode, spectating starts on a random living group teammate and
    // specNext/specPrev navigate within them, so assert membership.
    const teammateIds = [playerB, playerC, playerD, playerE, playerF].map((p) => p.__id);
    const spectatingId = () => playerA.spectating?.__id;

    playerA.spectate(specBegin);
    expect(teammateIds).toContain(spectatingId());

    playerA.spectate(specNext);
    game.step(spectateTeammateCooldown);
    expect(teammateIds).toContain(spectatingId());

    playerA.spectate(specPrev);
    game.step(spectateTeammateCooldown);
    expect(teammateIds).toContain(spectatingId());

    playerA.spectate(specPrev);
    game.step(spectateTeammateCooldown);
    expect(teammateIds).toContain(spectatingId());

    playerA.spectate(specNext);
    game.step(spectateTeammateCooldown);
    expect(teammateIds).toContain(spectatingId());

    for (const player of [playerB, playerC, playerD]) {
        player.kill({
            damageType: GameConfig.DamageType.Player,
            source: playerE,
            amount: 999,
            dir: v2.randomUnit(),
        });
    }

    // playerB/C/D are dead now; advancing lands on a living group teammate
    // (playerE or playerF)
    playerA.spectate(specNext);
    expect([playerE.__id, playerF.__id]).toContain(spectatingId());
});
