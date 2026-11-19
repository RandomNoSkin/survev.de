import { expect, test } from "vitest";
import type { Player } from "../../server/src/game/objects/player.ts";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

const kill = (p: Player, by: Player) =>
    p.kill({ damageType: GameConfig.DamageType.Player, dir: v2.create(1, 0), source: by });

test("Advanced spectator opens only once the whole own team is dead", () => {
    const game = createGame(TeamMode.Duo, "main");
    const a = game.playerBarn.addTestPlayer({});
    const b = game.playerBarn.addTestPlayer({ group: a.group });
    const enemy = game.playerBarn.addTestPlayer({});
    const enemyMate = game.playerBarn.addTestPlayer({ group: enemy.group });

    // alive: never
    expect(a.advSpecAllowed).toBe(false);

    // dead, but the teammate still plays: no (it could feed the teammate)
    kill(a, enemy);
    expect(a.dead).toBe(true);
    expect(a.advSpecAllowed).toBe(false);

    // the last teammate dies: now yes, for both
    kill(b, enemy);
    expect(a.advSpecAllowed).toBe(true);
    expect(b.advSpecAllowed).toBe(true);

    // the enemy team is untouched
    expect(enemy.advSpecAllowed).toBe(false);
    expect(enemyMate.advSpecAllowed).toBe(false);
});

test("A tampered client can't turn advanced spectator on while its team still plays", () => {
    const game = createGame(TeamMode.Duo, "main");
    const a = game.playerBarn.addTestPlayer({});
    game.playerBarn.addTestPlayer({ group: a.group });
    const enemy = game.playerBarn.addTestPlayer({});

    kill(a, enemy);
    a.handleSpectatorAdvanced({ enabled: true, freecam: true, pos: v2.create(10, 10), zoom: 1 } as never);
    expect(a.advSpecActive).toBe(false);
});

test("Solo: dead means the team (just you) is dead", () => {
    const game = createGame(TeamMode.Solo, "main");
    const a = game.playerBarn.addTestPlayer({});
    const enemy = game.playerBarn.addTestPlayer({});

    expect(a.advSpecAllowed).toBe(false);
    kill(a, enemy);
    expect(a.advSpecAllowed).toBe(true);
    expect(enemy.advSpecAllowed).toBe(false);
});

test("Owners may use it as soon as they're dead, even with their team alive - never while alive", () => {
    const game = createGame(TeamMode.Duo, "main");
    const owner = game.playerBarn.addTestPlayer({});
    game.playerBarn.addTestPlayer({ group: owner.group });
    const enemy = game.playerBarn.addTestPlayer({});
    owner.isOwner = true;

    expect(owner.advSpecAllowed).toBe(false);
    kill(owner, enemy);
    expect(owner.advSpecAllowed).toBe(true);
});

test("AdvancedSpectatorAllowedMsg survives the wire", async () => {
    const net = await import("../../shared/net/net.ts");
    const stream = new net.MsgStream(new ArrayBuffer(64));
    const out = new net.AdvancedSpectatorAllowedMsg();
    out.allowed = true;
    stream.serializeMsg(net.MsgType.AdvancedSpectatorAllowed, out);

    const read = new net.MsgStream(stream.getBuffer());
    expect(read.deserializeMsgType()).toBe(net.MsgType.AdvancedSpectatorAllowed);
    const back = new net.AdvancedSpectatorAllowedMsg();
    back.deserialize(read.stream);
    expect(back.allowed).toBe(true);
});
