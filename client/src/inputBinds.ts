import base64 from "base64-js";
import $ from "jquery";
import { type Input, Input as GameInput } from "../../shared/gameConfig.ts";
import { BitStream } from "../../shared/lib/bitBuffer.ts";
import type { ConfigManager } from "./config.ts";
import { type InputHandler, InputType, InputValue, Key, MouseButton, MouseWheel } from "./input.ts";
import { crc16 } from "./lib/crc.ts";
import type { Localization } from "./ui/localization.ts";

// Bump when adding a bind so existing saved configs run upgradeBinds() and pick up
// the new action's default key. v2 added AdvSpecToggle. v3 added the Spectator
// category binds (ToggleSpectateUi + advanced spectator sub-toggles).
const BINDS_VERSION = 3;

type BindCategory = "controls" | "spectator";

/**
 * `exclusiveToPlay` marks a "controls" bind that only ever fires while actively
 * controlling your own player (movement, firing, equipping, healing, ...) - never
 * while spectating or watching a replay. Only those binds are allowed to share a key
 * with a "spectator" bind (see setBind()). Anything that keeps working while
 * spectating (chat, map toggle, HUD toggle, fullscreen, emotes/pings, ...) must stay
 * globally unique, since both binds could genuinely fire in the same frame.
 */
function def(
    name: string,
    defaultValue: InputValue | null,
    category: BindCategory = "controls",
    exclusiveToPlay = false,
) {
    return {
        name,
        defaultValue,
        category,
        exclusiveToPlay,
    };
}
function inputKey(key: Key) {
    return new InputValue(InputType.Key, key);
}
function mouseButton(button: MouseButton) {
    return new InputValue(InputType.MouseButton, button);
}
function mouseWheel(wheel: MouseWheel) {
    return new InputValue(InputType.MouseWheel, wheel);
}

const BindDefs = {
    [GameInput.MoveLeft]: def("Move Left", inputKey(Key.A), "controls", true),
    [GameInput.MoveRight]: def("Move Right", inputKey(Key.D), "controls", true),
    [GameInput.MoveUp]: def("Move Up", inputKey(Key.W), "controls", true),
    [GameInput.MoveDown]: def("Move Down", inputKey(Key.S), "controls", true),
    [GameInput.Fire]: def("Fire", mouseButton(MouseButton.Left), "controls", true),
    [GameInput.Reload]: def("Reload", inputKey(Key.R), "controls", true),
    [GameInput.Cancel]: def("Cancel", inputKey(Key.X), "controls", true),
    [GameInput.Interact]: def("Interact", inputKey(Key.F), "controls", true),
    [GameInput.Revive]: def("Revive", null, "controls", true),
    [GameInput.Use]: def("Open/Use", null, "controls", true),
    [GameInput.Loot]: def("Loot", null, "controls", true),
    [GameInput.EquipPrimary]: def("Equip Primary", inputKey(Key.One), "controls", true),
    [GameInput.EquipSecondary]: def("Equip Secondary", inputKey(Key.Two), "controls", true),
    [GameInput.EquipMelee]: def("Equip Melee", inputKey(Key.Three), "controls", true),
    [GameInput.EquipThrowable]: def("Equip Throwable", inputKey(Key.Four), "controls", true),
    [GameInput.EquipNextWeap]: def(
        "Equip Next Weapon",
        mouseWheel(MouseWheel.Down),
        "controls",
        true,
    ),
    [GameInput.EquipPrevWeap]: def(
        "Equip Previous Weapon",
        mouseWheel(MouseWheel.Up),
        "controls",
        true,
    ),
    [GameInput.EquipLastWeap]: def("Equip Last Weapon", inputKey(Key.Q), "controls", true),
    [GameInput.StowWeapons]: def("Stow Weapons", inputKey(Key.E), "controls", true),
    [GameInput.EquipPrevScope]: def("Equip Previous Scope", null, "controls", true),
    [GameInput.EquipNextScope]: def("Equip Next Scope", null, "controls", true),
    [GameInput.UseBandage]: def("Use Bandage", inputKey(Key.Seven), "controls", true),
    [GameInput.UseHealthKit]: def("Use Med Kit", inputKey(Key.Eight), "controls", true),
    [GameInput.UseSoda]: def("Use Soda", inputKey(Key.Nine), "controls", true),
    [GameInput.UsePainkiller]: def("Use Pills", inputKey(Key.Zero), "controls", true),
    [GameInput.SwapWeapSlots]: def("Switch Gun Slots", inputKey(Key.T), "controls", true),
    // Everything below still works while spectating/watching a replay (chat, map,
    // HUD toggle, fullscreen, emotes/pings), so it must stay globally unique -
    // NOT exclusiveToPlay - even though it's in the "controls" category.
    [GameInput.ToggleMap]: def("Toggle Map", inputKey(Key.M)),
    [GameInput.CycleUIMode]: def("Toggle Minimap", inputKey(Key.V)),
    [GameInput.EmoteMenu]: def("Emote Menu", mouseButton(MouseButton.Right)),
    [GameInput.TeamPingMenu]: def("Team Ping Hold", inputKey(Key.C)),
    [GameInput.EquipOtherGun]: def("Equip Other Gun", null, "controls", true),
    [GameInput.Fullscreen]: def("Full Screen", inputKey(Key.L)),
    [GameInput.HideUI]: def("Hide UI", null),
    [GameInput.TeamPingSingle]: def("Team Ping Menu", null),
    [GameInput.JoinChat]: def("Open the Chat", inputKey(Key.Enter)),
    [GameInput.SwitchAmmo]: def("Switch Ammo", inputKey(Key.B), "controls", true),
    [GameInput.AdvSpecToggle]: def("Toggle Advanced Spectator", inputKey(Key.N), "spectator"),
    [GameInput.ToggleSpectateUi]: def("Hide Spectate UI", null, "spectator"),
    [GameInput.AdvSpecCollapse]: def("Collapse Advanced Spectator Panel", null, "spectator"),
    [GameInput.AdvSpecFreecam]: def("Toggle Freecam", null, "spectator"),
    [GameInput.AdvSpecZoomToggle]: def("Toggle Custom Zoom", null, "spectator"),
    [GameInput.AdvSpecZoomIn]: def("Zoom In", null, "spectator"),
    [GameInput.AdvSpecZoomOut]: def("Zoom Out", null, "spectator"),
    [GameInput.AdvSpecLayer]: def("Toggle Surface/Underground Layer", null, "spectator"),
    [GameInput.AdvSpecTransparent]: def("Toggle Transparent Surfaces", null, "spectator"),
    [GameInput.AdvSpecEnemiesOnMap]: def("Toggle Enemies On Map", null, "spectator"),
    [GameInput.AdvSpecEsp]: def("Toggle ESP Lines", null, "spectator"),
    [GameInput.AdvSpecLabels]: def("Toggle Enemy Labels", null, "spectator"),
    [GameInput.AdvSpecNades]: def("Toggle Grenade ESP", null, "spectator"),
    [GameInput.ReplayTogglePause]: def("Play/Pause Replay", null, "spectator"),
    [GameInput.ReplaySkipBack]: def("Skip Back 5s", null, "spectator"),
    [GameInput.ReplaySkipForward]: def("Skip Forward 5s", null, "spectator"),
    [GameInput.ReplaySpeedUp]: def("Increase Playback Speed", null, "spectator"),
    [GameInput.ReplaySpeedDown]: def("Decrease Playback Speed", null, "spectator"),
    [GameInput.ReplayFrameBack]: def("Step Back One Frame", null, "spectator"),
    [GameInput.ReplayFrameForward]: def("Step Forward One Frame", null, "spectator"),
};

export class InputBinds {
    binds: Array<InputValue | null> = [];
    boundKeys: Record<number, boolean | null> = {};
    menuHovered = false;

    constructor(
        public input: InputHandler,
        public config: ConfigManager,
    ) {
        this.loadBinds();
    }

    toArray() {
        const buf = new ArrayBuffer(this.binds.length * 2 + 1);
        const stream = new BitStream(buf);
        stream.writeUint8(BINDS_VERSION);
        for (let i = 0; i < this.binds.length; i++) {
            const bind = this.binds[i];
            const type = bind ? bind.type : 0;
            const code = bind ? bind.code : 0;
            stream.writeBits(type & 3, 2);
            stream.writeUint8(code & 255);
        }
        // Append crc
        const data = new Uint8Array(buf, 0, stream.byteIndex);
        const checksum = crc16(data);
        const ret = new Uint8Array(data.length + 2);
        ret.set(data);
        ret[ret.length - 2] = (checksum >> 8) & 255;
        ret[ret.length - 1] = checksum & 255;
        return ret;
    }

    fromArray(buf: Uint8Array) {
        let data = new Uint8Array(buf);
        if (!data || data.length < 3) {
            return false;
        }
        // Check crc
        const dataCrc = (data[data.length - 2] << 8) | data[data.length - 1];
        data = data.slice(0, data.length - 2);
        if (crc16(data) != dataCrc) {
            return false;
        }
        const arrayBuf = new ArrayBuffer(data.length);
        const view = new Uint8Array(arrayBuf);
        for (let i = 0; i < data.length; i++) {
            view[i] = data[i];
        }
        const stream = new BitStream(arrayBuf);
        const version = stream.readUint8();
        this.clearAllBinds();
        for (let idx = 0; stream.length - stream.index >= 10;) {
            const bind = idx++;
            const type = stream.readBits(2);
            const code = stream.readUint8();
            if (bind >= 0 && bind < GameInput.Count && type != InputType.None) {
                this.setBind(bind, type != 0 ? new InputValue(type, code) : null);
            }
        }
        if (version < BINDS_VERSION) {
            this.upgradeBinds(version);
            this.saveBinds();
        }
        return true;
    }

    toBase64() {
        return base64.fromByteArray(this.toArray());
    }

    fromBase64(str: string) {
        let loaded = false;
        try {
            loaded = this.fromArray(base64.toByteArray(str));
        } catch (err) {
            console.error("Error", err);
        }
        return loaded;
    }

    saveBinds() {
        this.config.set("binds", this.toBase64());
    }

    loadBinds() {
        if (!this.fromBase64(this.config.get("binds") || "")) {
            this.loadDefaultBinds();
            this.saveBinds();
        }
    }

    upgradeBinds(_version: number) {
        // Binds added after older configs were saved. Apply each one's default key
        // for upgrading users, but never stomp a key they've already bound elsewhere
        // and never overwrite a bind they've already set for this action.
        const newBinds: GameInput[] = [
            GameInput.AdvSpecToggle,
            GameInput.ToggleSpectateUi,
            GameInput.AdvSpecCollapse,
            GameInput.AdvSpecFreecam,
            GameInput.AdvSpecZoomToggle,
            GameInput.AdvSpecZoomIn,
            GameInput.AdvSpecZoomOut,
            GameInput.AdvSpecLayer,
            GameInput.AdvSpecTransparent,
            GameInput.AdvSpecEnemiesOnMap,
            GameInput.AdvSpecEsp,
            GameInput.AdvSpecLabels,
            GameInput.AdvSpecNades,
        ];

        for (const bind of newBinds) {
            if (this.binds[bind]) continue;
            const input = BindDefs[bind as keyof typeof BindDefs].defaultValue;
            if (!input) continue;
            const alreadyBound = this.binds.some((b) => b?.equals(input));
            if (!alreadyBound) {
                this.setBind(bind, input);
            }
        }
    }

    clearAllBinds() {
        for (let i = 0; i < GameInput.Count; i++) {
            this.binds[i] = null;
        }
        this.boundKeys = {};
    }

    setBind(bind: number, inputValue: InputValue | null) {
        if (inputValue) {
            // A key may only be shared between two binds when one is a "controls" bind
            // marked exclusiveToPlay (only fires while controlling your own player) and
            // the other is a "spectator" bind - those two truly never fire in the same
            // frame. Everything else (same category, or a non-exclusiveToPlay controls
            // bind like chat/map/HUD-toggle that still works while spectating) must
            // stay globally unique.
            const def = BindDefs[bind as keyof typeof BindDefs];
            for (let i = 0; i < this.binds.length; i++) {
                if (!this.binds[i]?.equals(inputValue)) continue;
                const otherDef = BindDefs[i as keyof typeof BindDefs];
                const canShare = def && otherDef && def.category !== otherDef.category
                    && ((def.category === "controls" && def.exclusiveToPlay)
                        || (otherDef.category === "controls" && otherDef.exclusiveToPlay));
                if (!canShare) this.binds[i] = null;
            }
        }
        const curBind = this.binds[bind];

        if (curBind && curBind.type == InputType.Key) {
            this.boundKeys[curBind.code] = null;
        }
        this.binds[bind] = inputValue;
        if (inputValue && inputValue.type == InputType.Key) {
            this.boundKeys[inputValue.code] = true;
        }
    }

    getBind(bind: number) {
        return this.binds[bind];
    }

    preventMenuBind(b: InputValue | null) {
        return b && this.menuHovered && (b.type == 2 || b.type == 3);
    }

    isKeyBound(key: Key) {
        return this.boundKeys[key];
    }

    isBindPressed(bind: Input) {
        const b = this.binds[bind];
        return !this.preventMenuBind(b) && b && this.input.isInputValuePressed(b);
    }

    isBindReleased(bind: Input) {
        const b = this.binds[bind];
        return !this.preventMenuBind(b) && b && this.input.isInputValueReleased(b);
    }

    isBindDown(bind: Input) {
        const b = this.binds[bind];
        return !this.preventMenuBind(b) && b && this.input.isInputValueDown(b);
    }

    loadDefaultBinds() {
        this.clearAllBinds();
        const defKeys = Object.keys(BindDefs);
        for (let i = 0; i < defKeys.length; i++) {
            const key = defKeys[i];
            const def = BindDefs[key as unknown as keyof typeof BindDefs];
            this.setBind(parseInt(key), def.defaultValue);
        }
    }
}

const CATEGORY_LABELS: Record<BindCategory, string> = {
    controls: "Controls",
    spectator: "Spectator",
};

export class InputBindUi {
    activeCategory: BindCategory = "controls";

    constructor(
        public input: InputHandler,
        public inputBinds: InputBinds,
        private localization: Localization,
    ) {
        $(".js-btn-keybind-restore").on("click", () => {
            this.inputBinds.loadDefaultBinds();
            this.inputBinds.saveBinds();
            this.refresh();
        });
    }

    cancelBind() {
        this.input.captureNextInput(null);
    }

    private renderCategoryTabs() {
        const categories = Object.keys(CATEGORY_LABELS) as BindCategory[];
        const tabsContainers = $(".js-keybind-category-tabs");
        tabsContainers.each((_i, el) => {
            const container = $(el);
            container.empty();
            for (const category of categories) {
                // Reuses the same tab look as the Team/Private Lobby settings tabs
                // (translucent pill, lime-green outline when active).
                const btn = $("<a/>", {
                    class:
                        "private-lobby-settings-tab"
                        + (category === this.activeCategory
                            ? " private-lobby-settings-tab-active"
                            : ""),
                    text: this.localization.translate(`bind-category-${category}`)
                        || CATEGORY_LABELS[category],
                });
                btn.on("click", () => {
                    if (this.activeCategory === category) return;
                    this.activeCategory = category;
                    this.refresh();
                });
                container.append(btn);
            }
        });
    }

    refresh() {
        this.renderCategoryTabs();
        const defKeys = Object.keys(BindDefs).filter((key) => {
            const bindDef = BindDefs[key as unknown as keyof typeof BindDefs];
            return (bindDef.category ?? "controls") === this.activeCategory;
        });
        const binds = this.inputBinds.binds;
        const container = $(".js-keybind-list");
        container.empty();
        for (let i = 0; i < defKeys.length; i++) {
            const key = defKeys[i];
            const bindDef = BindDefs[key as unknown as keyof typeof BindDefs];
            const bind = binds[key as unknown as number];
            const nameKey = "bind-"
                + bindDef.name
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/-+/g, "-")
                    .replace(/^-|-$/g, "");
            const btn = $("<a/>", {
                class: "btn-game-menu btn-darken btn-keybind-desc",
                text: this.localization.translate(nameKey) || bindDef.name,
            });
            const val = $("<div/>", {
                class: "btn-keybind-display",
                text: bind
                    ? this.localization.translate(bind.toString()) || bind.toString()
                    : "",
            });
            btn.on("click", (event) => {
                const targetElem = $(event.target);
                targetElem.addClass("btn-keybind-desc-selected");
                this.input.captureNextInput((event, inputValue) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const disallowKeys: number[] = [
                        Key.Control,
                        Key.Alt,
                        Key.Windows,
                        Key.ContextMenu,
                        Key.F1,
                        Key.F2,
                        Key.F3,
                        Key.F4,
                        Key.F5,
                        Key.F6,
                        Key.F7,
                        Key.F8,
                        Key.F9,
                        Key.F10,
                        Key.F11,
                        Key.F12,
                    ];
                    if (
                        inputValue.type == InputType.Key
                        && disallowKeys.includes(inputValue.code)
                    ) {
                        return false;
                    }
                    targetElem.removeClass("btn-keybind-desc-selected");
                    // Escape and Backspace both clear the bind (Escape doubles as
                    // "cancel by unbinding" rather than a no-op).
                    const bindValue: InputValue | null =
                        inputValue.equals(inputKey(Key.Escape))
                            || inputValue.equals(inputKey(Key.Backspace))
                            ? null
                            : inputValue;
                    this.inputBinds.setBind(parseInt(key), bindValue);
                    this.inputBinds.saveBinds();
                    this.refresh();
                    return true;
                });
            });
            container.append(
                $("<div/>", {
                    class: "ui-keybind-container",
                })
                    .append(btn)
                    .append(val),
            );
        }
        $("#keybind-link").html(this.inputBinds.toBase64());
    }
}
