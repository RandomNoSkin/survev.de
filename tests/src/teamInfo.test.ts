import { expect, test } from "vitest";
import type { Player } from "../../server/src/game/objects/player.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import * as net from "../../shared/net/net.ts";
import { createGame } from "./gameTestHelpers.ts";

/** Every TeamInfoMsg a player's update would carry. */
function captureTeamInfo(p: Player) {
    const got: net.TeamInfoPlayer[][] = [];
    const orig = net.MsgStream.prototype.serializeMsg;
    const sendMsgs = p.sendMsgs.bind(p);
    p.sendMsgs = () => {
        net.MsgStream.prototype.serializeMsg = function (this: net.MsgStream, type: net.MsgType, msg: net.AbstractMsg, ...rest: unknown[]) {
            if (type === net.MsgType.TeamInfo) {
                // through the wire format, like the client gets it
                const out = new net.MsgStream(new ArrayBuffer(4096));
                orig.call(out, type, msg);
                const read = new net.MsgStream(out.getBuffer());
                read.deserializeMsgType();
                const back = new net.TeamInfoMsg();
                back.deserialize(read.stream);
                got.push(back.players);
            }
            return (orig as Function).call(this, type, msg, ...rest);
        } as typeof orig;
        try {
            sendMsgs();
        } finally {
            net.MsgStream.prototype.serializeMsg = orig;
        }
    };
    return got;
}

test("Teammates get each other's health, gear and heals - the other team doesn't", () => {
    const game = createGame(TeamMode.Duo, "main");
    const a = game.playerBarn.addTestPlayer({});
    const b = game.playerBarn.addTestPlayer({ group: a.group });
    const enemy = game.playerBarn.addTestPlayer({});
    game.playerBarn.addTestPlayer({ group: enemy.group });

    b.health = 63;
    b.boost = 40;
    b.weaponManager.setWeapon(0, "mosin", 5);
    b.helmet = "helmet02";
    b.chest = "chest03";
    b.backpack = "backpack02";
    b.scope = "4xscope";
    b.inventory["2xscope"] = 1;
    b.inventory["4xscope"] = 1;
    b.inventory["8xscope"] = 1;
    b.inventory.bandage = 7;
    b.inventory.soda = 2;

    const toA = captureTeamInfo(a);
    const toEnemy = captureTeamInfo(enemy);
    game.netSync();

    expect(toA).toHaveLength(1);
    const mate = toA[0].find((p) => p.playerId === b.__id)!;
    expect(Math.round(mate.health)).toBe(63);
    expect(Math.round(mate.boost)).toBe(40);
    expect(mate.weapons[0]).toStrictEqual({ type: "mosin", ammo: 5 });
    expect([mate.helmet, mate.chest, mate.backpack, mate.scope]).toStrictEqual(["helmet02", "chest03", "backpack02", "4xscope"]);
    expect(mate.scopes).toStrictEqual(["1xscope", "2xscope", "4xscope", "8xscope"]);
    expect([mate.bandage, mate.soda, mate.healthkit]).toStrictEqual([7, 2, 0]);
    expect(toA[0].map((p) => p.playerId).sort()).toStrictEqual([a.__id, b.__id].sort());
    // the enemy's message only lists the enemy's own team
    expect(toEnemy.flat().some((p) => p.playerId === b.__id)).toBe(false);

    // nothing changed: not sent again
    toA.length = 0;
    game.netSync();
    expect(toA).toHaveLength(0);
});
