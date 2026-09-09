import $ from "jquery";
import { Game } from "../game";
import * as net from "../../../shared/net/net";
import { InputHandler, Key } from "../input";

export class ChatUi{

    chatInput = $("#ui-chat-wrapper");
    input = document.getElementById("ui-chat-input") as HTMLInputElement;
    button = document.getElementById("ui-chat-send");
    chatButton = document.getElementById("ui-chat-button");
    game: Game;
    inputHandler: InputHandler;
    chatShown = false;
    chatType = 0; // 0 = all | 1 = team | 3 = spectator
    clientSideChatSlowdown = 0;
    /** Timestamp (performance.now()) of the last leaveChat() call - joinChat() refuses
     *  to reopen within REOPEN_COOLDOWN_MS of it, as a hard backstop against Enter
     *  being both the send/close key and the "Open Chat" keybind: whatever exact event-
     *  timing quirk (key-repeat, focus-shift-mid-dispatch, etc.) causes a stray "open"
     *  trigger to slip through right after a close, this makes it impossible for that
     *  trigger to actually reopen the chat, without needing to nail down every such
     *  quirk individually. 250ms is far above normal human reaction time for a
     *  deliberate close-then-immediately-reopen, so it doesn't cost real usability. */
    private static readonly REOPEN_COOLDOWN_MS = 250;
    private lastCloseTime = 0;

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
        // Mobile: open the chat via the on-screen HUD button (no keyboard trigger)
        this.chatButton?.style.setProperty("pointer-events", "auto");
        this.chatButton?.addEventListener("touchstart", (e) => {
            e.stopPropagation();
            this.joinChat();
        });
        // Don't want to trigger keybinds (like L to fullscreen) while typing - but
        // Enter/Escape must still bubble up to InputHandler (input.ts), which already
        // has its own isTyping-aware handling that specifically lets these two through
        // regardless. Blocking them here (as this used to do unconditionally) meant
        // InputHandler's global key state never saw Enter's *release* once focus had
        // already moved to this input (the keydown that opens chat fires before focus
        // shifts and gets through fine, but the matching keyup fires after and was
        // getting swallowed) - leaving Enter stuck "held" until one wasted extra press
        // reset it, which is exactly the "have to press the chat key twice" bug.
        const stopUnlessEnterOrEscape = (e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== "Escape") e.stopPropagation();
        };
        this.input.addEventListener("keyup", stopUnlessEnterOrEscape);
        this.input.addEventListener("keydown", (e) => {
            stopUnlessEnterOrEscape(e);

            if (e.key == "Enter" ) {
                this.sendChatMessage();
            }
            if(e.key == "Tab"){
                e.preventDefault();
                this.switchChat();
                this.input.focus();
            }
            // Escape itself is left to the window-level listener below, now that it's
            // actually allowed to bubble there.
        });
            // Close the chat when tapping/clicking outside of it. Must ignore
            // taps inside the chat wrapper or on the chat button, otherwise on
            // mobile focusing the input (or hitting send) would close it instantly.
            const closeIfOutside = (e: Event) => {
                const target = e.target as Node | null;
                if (target && this.chatInput[0]?.contains(target)) return;
                if (target && this.chatButton?.contains(target)) return;
                this.leaveChat();
            };
            window.addEventListener("mousedown", closeIfOutside);
            // Escape is deliberately NOT handled here (only "<", a mobile/alternate
            // close key) - it's now handled solely by game.ts's per-frame
            // keyPressed(Key.Escape) check, which decides between leaveChat() and
            // toggleEscMenu() based on whether chat is open AT THE TIME IT POLLS.
            // Also reacting to the same keydown here, synchronously and earlier, would
            // close chat first and let game.ts's later poll see it as already-closed -
            // wrongly opening the pause menu right after Escape closed chat.
            window.addEventListener("keydown", (e) => {
                if(e.key == "<"){
                    this.leaveChat();
                }
            });
            this.input.placeholder = "[ALL]";
    }

    sendChatMessage() {
        const text = this.input.value.trim();
        if (!text) return;
        if(this.clientSideChatSlowdown >0) {

            const txt = this.game.m_ui2Manager.getAdminChatMessage("ADMIN", "chat-cooldown");

            this.game.m_ui2Manager.addChatMessage(txt, "#ff0000", "#000000");

            // Rate-limited: chat stays open (unlike a successful send below) so the
            // player can see the cooldown warning and keep typing/retry once it clears.
            return;
        }
        const msg = new net.KillFeedMsg();
        msg.string = text;
        msg.player = this.game.m_activePlayer.nameText.text;
        msg.chatType = this.chatType;
        msg.type = net.KillFeedMsgType.ChatMsg;

        this.game.m_sendMessage(net.MsgType.KillFeed, msg);

        this.input.value = "";
        this.clientSideChatSlowdown = 3;

        //this.input.focus();
        this.leaveChat();
        this.suppressPendingEnterPress();
    }

    /** The Enter keydown that triggers a send (target-phase, handled synchronously in
     *  sendChatMessage) is still mid-dispatch when this runs - it hasn't bubbled up to
     *  InputHandler's window-level listener yet, so `keys[Enter]` isn't `true` yet
     *  either. Once it does (right after the handler returns), game.ts's OWN "Open
     *  Chat" keybind poll (also bound to Enter) would see that as a brand new press on
     *  its very next frame and immediately reopen the chat that was just closed.
     *  Deferring to a microtask runs after the full synchronous dispatch (including
     *  that bubble) completes but still before the next animation frame, so this
     *  reliably cancels it out without touching any OTHER, unrelated Enter press. */
    private suppressPendingEnterPress() {
        queueMicrotask(() => {
            this.inputHandler.keys[Key.Enter] = false;
            this.inputHandler.keysOld[Key.Enter] = false;
        });
    }


    joinChat(){
        if (performance.now() - this.lastCloseTime < ChatUi.REOPEN_COOLDOWN_MS) return;
        this.chatInput.css("display", "block");
        this.inputHandler.isTyping = true;
        this.input.focus();
        // Brings back chat messages that already faded out, and keeps them (and any
        // new ones) from fading while chat stays open - see UiManager2#chatOpen and
        // its KillFeed ticker logic. Kill feed entries are unaffected either way.
        this.game.m_ui2Manager.chatOpen = true;
    }

    leaveChat(){
        this.lastCloseTime = performance.now();
        this.chatInput.css("display", "none");
        this.inputHandler.isTyping = false;
        this.game.m_ui2Manager.chatOpen = false;
        // Explicit blur, not just relying on the input becoming non-rendered - without
        // this the input can keep keyboard focus after Escape hides it, which would
        // otherwise route the player's next few keystrokes (WASD, etc.) into the
        // (invisible) chat box instead of back to normal gameplay input.
        this.input.blur();
    }

    switchChat(){
        const currentChat = this.chatType;
        switch(currentChat){
            case(0):{
                this.chatType = 1
                this.input.placeholder = "[TEAM]";
                this.input.focus();
                break;
            }
            case(1):{
                this.chatType = 0
                this.input.placeholder = "[ALL]";
                this.input.focus();
                break;
            }
        }
        this.input.focus();
    }

    adminCommands: Record<string, (admin: string, content: string, args: string[]) => void> = {
        announce: (admin, content, args) => {
            this.sendAnnouncementMsg(admin, content, args);
        },
    };

    chatIsEnabled(): boolean {

        const style = window.getComputedStyle(this.chatInput[0]);
            if(style.display !== "none"){
                return true;
            }

        return false;
    }


    handleAdminCmds(cmd: string, admin: string, content: string, args: string[]){
        const handler = this.adminCommands[cmd];

        if (!handler) return;

        handler(admin, content, args);
    }

    sendAnnouncementMsg(admin: string, content: string, args: string[]){
        const msg = `[${admin}]: ${content}`;
        const color = args[0];
        const time = Number(args[1]);
        this.game.m_uiManager.displayAnnouncement(msg, color, time);
    }

    update(dt: number){
        if(this.clientSideChatSlowdown>0)
        this.clientSideChatSlowdown -= dt;
    }
}