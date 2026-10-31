import { expect, test, vi } from "vitest";
import { Chat } from "../../server/src/utils/chat.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import * as net from "../../shared/net/net.ts";
import { createGame } from "./gameTestHelpers.ts";

function chatMsg(text: string) {
    const msg = new net.KillFeedMsg();
    msg.type = net.KillFeedMsgType.ChatMsg;
    msg.string = text;
    msg.chatType = 0;
    return msg;
}

for (const stealth of [false, true]) {
    test(`A${stealth ? "n invisible" : ""} spectator's chat reaches everyone, tagged [SPEC]`, () => {
        const game = createGame(TeamMode.Squad, "comp");
        game.playerBarn.addTestPlayer({});
        const spec = game.playerBarn.addTestPlayer({});
        spec.spectator = true;
        spec.stealth = stealth;
        spec.chat = new Chat(spec, game, false);

        const broadcast = vi.spyOn(game, "broadcastMsg");
        spec.chat.handleChatMessage(chatMsg("gg"));

        const sent = broadcast.mock.calls.filter(([type]) => type === net.MsgType.KillFeed).map(([, m]) => m as net.KillFeedMsg);
        expect(sent).toHaveLength(1);
        expect(sent[0].string).toBe("gg");
        expect(sent[0].chatType).toBe(2);
        expect(sent[0].player).toBe(spec.name);
    });
}
