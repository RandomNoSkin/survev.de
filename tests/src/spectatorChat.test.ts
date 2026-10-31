import { expect, test, vi } from "vitest";
import { Chat } from "../../server/src/utils/chat.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import * as net from "../../shared/net/net.ts";
import { createGame } from "./gameTestHelpers.ts";

function chatMsg(text: string, chatType: number) {
    const msg = new net.KillFeedMsg();
    msg.type = net.KillFeedMsgType.ChatMsg;
    msg.string = text;
    msg.chatType = chatType;
    return msg;
}

function setup(stealth: boolean) {
    const game = createGame(TeamMode.Squad, "comp");
    const player = game.playerBarn.addTestPlayer({});
    const spec = game.playerBarn.addTestPlayer({});
    const otherSpec = game.playerBarn.addTestPlayer({});
    for (const s of [spec, otherSpec]) s.spectator = true;
    spec.stealth = stealth;
    spec.chat = new Chat(spec, game, false);
    return { game, player, spec, otherSpec };
}

for (const stealth of [false, true]) {
    const who = `A${stealth ? "n invisible" : ""} spectator`;

    test(`${who}'s SPEC chat only reaches the spectators`, () => {
        const { game, player, spec, otherSpec } = setup(stealth);
        const toPlayer = vi.spyOn(player, "sendMsg");
        const toSpecs = [vi.spyOn(spec, "sendMsg"), vi.spyOn(otherSpec, "sendMsg")];
        const broadcast = vi.spyOn(game, "broadcastMsg");
        spec.chat.handleChatMessage(chatMsg("gg", 2));

        const feed = (s: typeof toPlayer) => s.mock.calls.filter(([type]) => type === net.MsgType.KillFeed).map(([, m]) => m as net.KillFeedMsg);
        expect(broadcast).not.toHaveBeenCalled();
        expect(feed(toPlayer)).toHaveLength(0);
        for (const s of toSpecs) {
            const got = feed(s);
            expect(got).toHaveLength(1);
            expect(got[0].string).toBe("gg");
            expect(got[0].chatType).toBe(2);
        }
    });

    test(`${who} switched to ALL reaches everyone, tagged as a spectator`, () => {
        const { game, spec } = setup(stealth);
        const broadcast = vi.spyOn(game, "broadcastMsg");
        spec.chat.handleChatMessage(chatMsg("gg", 0));

        const sent = broadcast.mock.calls.filter(([type]) => type === net.MsgType.KillFeed).map(([, m]) => m as net.KillFeedMsg);
        expect(sent).toHaveLength(1);
        expect(sent[0].string).toBe("gg");
        expect(sent[0].chatType).toBe(3);
        expect(sent[0].player).toBe(spec.name);
    });
}

test("JoinedMsg carries the spectator flag", () => {
    const msg = new net.JoinedMsg();
    msg.spectator = true;
    const stream = new net.MsgStream(new ArrayBuffer(1024));
    stream.serializeMsg(net.MsgType.Joined, msg);
    stream.stream.index = 0;
    expect(stream.deserializeMsgType()).toBe(net.MsgType.Joined);
    const back = new net.JoinedMsg();
    back.deserialize(stream.stream);
    expect(back.spectator).toBe(true);
});
