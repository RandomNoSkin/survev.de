import { expect, test } from "vitest";
import type { Player } from "../../server/src/game/objects/player.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import * as net from "../../shared/net/net.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

/** Every UpdateMsg emote serialized while `p` builds its update. */
function captureEmotes(p: Player) {
    const got: net.UpdateMsg["emotes"] = [];
    const orig = net.UpdateMsg.prototype.serialize;
    const sendMsgs = p.sendMsgs.bind(p);
    p.sendMsgs = () => {
        net.UpdateMsg.prototype.serialize = function (this: net.UpdateMsg, s: never) {
            got.push(...this.emotes);
            return orig.call(this, s);
        };
        try {
            sendMsgs();
        } finally {
            net.UpdateMsg.prototype.serialize = orig;
        }
    };
    return got;
}

function ping(p: Player, type: string, x: number, y: number) {
    const msg = new net.EmoteMsg();
    msg.type = type;
    msg.pos = v2.create(x, y);
    msg.isPing = true;
    p.emoteFromMsg(msg);
}

test("A teammate who joins later still gets the pings that are on the map", () => {
    const game = createGame(TeamMode.Duo, "main");
    const a = game.playerBarn.addTestPlayer({});
    const enemy = game.playerBarn.addTestPlayer({});
    ping(a, "ping_coming", 100, 120); // stays on the map 300s
    expect(game.playerBarn.activePings.map((p) => p.emote.type)).toContain("ping_coming");
    game.netSync();
    ping(enemy, "ping_help", 50, 50); // the other team's - never for a
    game.netSync();

    const b = game.playerBarn.addTestPlayer({ group: a.group });
    const got = captureEmotes(b);
    game.netSync();

    const pings = got.filter((e) => e.isPing);
    expect(pings.map((e) => [e.type, e.playerId])).toStrictEqual([["ping_coming", a.__id]]);
    expect(pings[0].restoredLife).toBeGreaterThan(290);
    expect(pings[0].pos!.x).toBeCloseTo(100, 0);

    // only once: the next update doesn't repeat it
    got.length = 0;
    game.netSync();
    expect(got.filter((e) => e.isPing)).toHaveLength(0);
});

test("A spectator switching to another team gets that team's pings", () => {
    const game = createGame(TeamMode.Duo, "main");
    const a = game.playerBarn.addTestPlayer({});
    const b = game.playerBarn.addTestPlayer({});
    ping(a, "ping_coming", 100, 120);
    ping(b, "ping_help", 50, 50);
    game.netSync();

    const spec = game.playerBarn.addTestPlayer({});
    spec.spectating = a;
    const got = captureEmotes(spec);
    game.netSync();
    expect(got.filter((e) => e.isPing).map((e) => e.type)).toStrictEqual(["ping_coming"]);

    // same team again: nothing repeated
    got.length = 0;
    game.netSync();
    expect(got.filter((e) => e.isPing)).toHaveLength(0);

    // switched to the other team: its pings, once
    spec.spectating = b;
    game.netSync();
    const pings = got.filter((e) => e.isPing);
    expect(pings.map((e) => [e.type, e.playerId])).toStrictEqual([["ping_help", b.__id]]);
    expect(pings[0].restoredLife).toBeGreaterThan(0);
});
