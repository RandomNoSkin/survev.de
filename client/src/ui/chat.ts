import $ from "jquery";
import { Game } from "../game";
import * as net from "../../../shared/net/net";
import { InputHandler } from "../input";

export class ChatUi{

    chatInput = $("#ui-chat-wrapper");
    input = document.getElementById("ui-chat-input") as HTMLInputElement;
    button = document.getElementById("ui-chat-send");
    game: Game;
    inputHandler: InputHandler;

    constructor(
        game: Game,
        input: InputHandler
    ){

        this.game = game;
        this.inputHandler = input;
        // Button click
        this.button?.addEventListener("click", () => {
            this.sendChatMessage.call(this);
        });
        // don't want to trigger keybinds (like L to fullscreen) while typing
            this.input.addEventListener("keyup", (e) => e.stopPropagation());
            this.input.addEventListener("keydown", (e) => {
                e.stopPropagation();

                if (e.key == "Enter" ) {
                    this.sendChatMessage();
                }
                if(e.key == "Escape" || e.key == "<"){
                    this.leaveChat();
                }
            });
    }

    sendChatMessage() {
        const text = this.input.value.trim();
        if (!text) return;

        const msg = new net.KillFeedMsg;
        msg.string = text;
        msg.player = this.game.m_activePlayer.nameText.text;
        msg.type = net.KillFeedMsgType.ChatMsg;

        this.game.m_sendMessage(net.MsgType.KillFeed, msg);

        // 🔥 Input leeren
        this.input.value = "";

        // optional: Fokus behalten (sehr nice fürs Chatten)
        this.input.focus();

    }


    joinChat(){
        this.chatInput.css("display", "block");
        this.inputHandler.isTyping = true;
    }

    leaveChat(){
        this.chatInput.css("display", "none");
        this.inputHandler.isTyping = false;
    }
}