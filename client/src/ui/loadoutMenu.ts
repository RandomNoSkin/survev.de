import "@taufik-nurrohman/color-picker";
import $ from "jquery";
import { GameObjectDefs } from "../../../shared/defs/gameObjectDefs";
import { EmoteCategory, type EmoteDef } from "../../../shared/defs/gameObjects/emoteDefs";
import type { MeleeDef } from "../../../shared/defs/gameObjects/meleeDefs";
import { type UnlockDef, UnlockDefs } from "../../../shared/defs/gameObjects/unlockDefs";
import {
    getItemPrice,
    getItemRarity,
    getMarketPriceBounds,
    MARKET_LISTING_TTL_MS,
} from "../../../shared/defs/shopConfig";
import { EmoteSlot, Rarity } from "../../../shared/gameConfig";
import { cosmeticStats, formatOwnerPercent } from "../../../shared/utils/cosmeticStats";
import type { ItemStatus } from "../../../shared/utils/loadout";
import { type Crosshair, type Loadout, loadout } from "../../../shared/utils/loadout";
import { util } from "../../../shared/utils/util";
import type { Account } from "../account";
import { crosshair } from "../crosshair";
import { device } from "../device";
import { helpers } from "../helpers";
import type { AuctionUi } from "./auctionUi";
import type { Localization } from "./localization";
import type { MarketUi } from "./marketUi";
import { MenuModal } from "./menuModal";
import type { LoadoutDisplay } from "./opponentDisplay";
import type { ShopUi } from "./shopUi";
import type { SocialUi } from "./socialUi";

/** Free cosmetics everyone owns by default — counted as 0 worth in the value bar. */
const DEFAULT_UNLOCKED = new Set<string>([
    ...UnlockDefs.unlock_default.unlocks,
    ...UnlockDefs.unlock_new_account.unlocks,
]);

function emoteSlotToDomElem(e: Exclude<EmoteSlot, EmoteSlot.Count>) {
    const emoteSlotToDomId = {
        [EmoteSlot.Top]: "customize-emote-top",
        [EmoteSlot.Right]: "customize-emote-right",
        [EmoteSlot.Bottom]: "customize-emote-bottom",
        [EmoteSlot.Left]: "customize-emote-left",
        [EmoteSlot.Win]: "customize-emote-win",
        [EmoteSlot.Death]: "customize-emote-death",
    };
    const domId = emoteSlotToDomId[e] || emoteSlotToDomId[EmoteSlot.Top];
    return $(`#${domId}`);
}

/** " · 42 (3.1%)" owner-count suffix appended next to a rarity label (empty if no data). */
function ownerCountSuffix(type: string): string {
    if (!cosmeticStats.hasData()) return "";
    const count = cosmeticStats.getCount(type);
    return ` · ${count} (${formatOwnerPercent(cosmeticStats.getPercent(type))})`;
}

function itemSort(sortFn: (a: Item, b: Item) => void) {
    return function (a: Item, b: Item) {
        // Always put stock items at the front of the list;
        // if not stock, sort by the given sort routine
        const rarityA = getItemRarity(a.type);
        const rarityB = getItemRarity(b.type);
        if (rarityA == Rarity.Stock && rarityB == Rarity.Stock) {
            return sortAlphabetical(a, b);
        }
        if (rarityA == Rarity.Stock) {
            return -1;
        }
        if (rarityB == Rarity.Stock) {
            return 1;
        }
        return sortFn(a, b);
    };
}

function sortAcquired(a: Item, b: Item) {
    if (b.timeAcquired == a.timeAcquired) {
        return sortSubcat(a, b);
    }
    return b.timeAcquired - a.timeAcquired;
}

function sortAlphabetical(a: Item, b: Item) {
    const defA = GameObjectDefs[a.type] as EmoteDef;
    const defB = GameObjectDefs[b.type] as EmoteDef;
    if (defA.name! < defB.name!) {
        return -1;
    }
    if (defA.name! > defB.name!) {
        return 1;
    }
    return 0;
}

function sortRarity(a: Item, b: Item) {
    const rarityA = getItemRarity(a.type);
    const rarityB = getItemRarity(b.type);
    if (rarityA == rarityB) {
        return sortAlphabetical(a, b);
    }
    return rarityB - rarityA;
}

function sortSubcat(a: Item, b: Item) {
    const defA = GameObjectDefs[a.type] as EmoteDef;
    const defB = GameObjectDefs[b.type] as EmoteDef;
    if (!defA.category || !defB.category || defA.category == defB.category) {
        return sortAlphabetical(a, b);
    }
    return defA.category - defB.category;
}

const sortTypes: Record<string, any> = {
    newest: itemSort(sortAcquired),
    alpha: itemSort(sortAlphabetical),
    rarity: itemSort(sortRarity),
    subcat: itemSort(sortSubcat),
};

export interface Item {
    /** Inventory instance id (absent for virtual default-unlock items). */
    id?: number;
    type: string;
    source: string;
    timeAcquired: number;
    status?: ItemStatus;
    ackd?: ItemStatus.Ackd;
    /** Ownership history (slugs), present for traded items. */
    previousOwners?: string[];
    /** Lifetime match stats accrued by this instance while equipped. */
    games?: number;
    wins?: number;
    kills?: number;
    damage?: number;
    /** Golden Fries paid to acquire this instance (null = unknown). */
    pricePaid?: number | null;
}
interface ItemInfo {
    /** Inventory instance id, so duplicate copies of a type can be told apart. */
    id?: number;
    /** Ownership history (slugs) for the detail panel. */
    previousOwners?: string[];
    /** Lifetime match stats for the detail panel. */
    games?: number;
    wins?: number;
    kills?: number;
    damage?: number;
    /** Golden Fries paid to acquire this instance (null = unknown). */
    pricePaid?: number | null;
    type: string;
    loadoutType: string;
    rarity: number;
    displayName: string;
    displaySource: string;
    displayLore: string;
    timeAcquired: number;
    idx: number;
    subcat: EmoteCategory;
    outerDiv: JQuery<HTMLElement> | null;
}

// use itemInfo?
interface EquippedItem {
    id?: number;
    previousOwners?: string[];
    games?: number;
    wins?: number;
    kills?: number;
    damage?: number;
    pricePaid?: number | null;
    loadoutType: string;
    type: string;
    rarity: number;
    displayName: string;
    displayLore?: string;
    subcat: EmoteCategory;
    displaySource?: string;
}
export class LoadoutMenu {
    initialized = false;
    active = false;
    items: Item[] = [];

    loadoutDisplay: LoadoutDisplay | null = null;
    /** Set by main.ts so the item detail panel can open the marketplace sell dialog. */
    marketUi: MarketUi | null = null;
    /** Set by main.ts so clicking an item's rarity opens the shop's "Owners" view. */
    shopUi: ShopUi | null = null;
    /** Set by main.ts so the detail panel can open the Social gift flow for an item. */
    socialUi: SocialUi | null = null;
    /** Set by main.ts so the detail panel can put an item up for auction. */
    auctionUi: AuctionUi | null = null;
    /** True while the Settings tab is showing (its panel replaces the item list). */
    private settingsOpen = false;
    /** When true, the right side shows the item detail panel instead of the equip UI. */
    detailMode = false;
    loadout = loadout.defaultLoadout();
    localPendingConfirm: Item[] = [];
    localConfirmed: Item[] = [];
    confirmingItems = false;
    localAckItems: Item[] = [];

    categories = [
        {
            loadoutType: "outfit",
            gameType: "outfit",
            categoryImage: "img/gui/loadout-outfit.svg",
        },
        {
            loadoutType: "melee",
            gameType: "melee",
            categoryImage: "img/gui/loadout-melee.svg",
        },
        {
            loadoutType: "emote",
            gameType: "emote",
            categoryImage: "img/gui/loadout-emote.svg",
        },
        {
            loadoutType: "heal",
            gameType: "heal_effect",
            categoryImage: "img/gui/loadout-heal.svg",
        },
        {
            loadoutType: "boost",
            gameType: "boost_effect",
            categoryImage: "img/gui/loadout-boost.svg",
        },
        {
            loadoutType: "death_effect",
            gameType: "death_effect",
            categoryImage: "img/gui/loadout-kill-icon.svg",
        },
    ];

    selectedItem: {
        prevSlot: JQuery<HTMLElement> | null;
        img: string;
        id?: number;
        previousOwners?: string[];
        games?: number;
        wins?: number;
        kills?: number;
        damage?: number;
        pricePaid?: number | null;
        type: string;
        rarity?: number;
        displayName?: string;
        displaySource?: string;
        loadoutType?: string;
        displayLore?: string;
        subcat?: number;
    } = {
        prevSlot: null,
        img: "",
        type: "",
    };

    emotesLoaded = false;
    selectedCatIdx = 0;
    selectedCatItems: ItemInfo[] = [];
    equippedItems: EquippedItem[] = [];

    modalCustomize: JQuery<HTMLElement>;
    modalCustomizeList: JQuery<HTMLElement>;
    modalCustomizeItemRarity: JQuery<HTMLElement>;
    modalCustomizeItemName: JQuery<HTMLElement>;
    modalCustomizeItemLore: JQuery<HTMLElement>;
    modalCustomizeItemSource: JQuery<HTMLElement>;

    picker: any;

    modal: MenuModal;
    confirmItemModal: MenuModal;

    itemSort!: JQuery<HTMLSelectElement>;
    selectableCats!: JQuery<HTMLElement>;
    selectableCatConnects!: JQuery<HTMLElement>;
    selectableCatImages!: JQuery<HTMLElement>;
    selectableSlots!: JQuery<HTMLElement>;
    droppableSlots!: JQuery<HTMLElement>;
    highlightedSlots!: JQuery<HTMLElement>;
    itemSelected!: boolean;

    highlightOpacityMin!: number;
    constructor(
        public account: Account,
        public localization: Localization,
    ) {
        if (!device.touch) {
            this.categories.push({
                loadoutType: "crosshair",
                gameType: "crosshair",
                categoryImage: "img/gui/loadout-crosshair.svg",
            });
        }
        this.categories.push({
            loadoutType: "player_icon",
            gameType: "emote",
            categoryImage: "img/gui/loadout-emote.svg",
        });

        this.modalCustomize = $("#modal-customize");
        this.modalCustomizeList = $("#modal-customize-list");
        this.modalCustomizeItemRarity = $("#modal-customize-item-rarity");
        this.modalCustomizeItemName = $("#modal-customize-item-name");
        this.modalCustomizeItemLore = $("#modal-customize-item-lore");
        this.modalCustomizeItemSource = $("#modal-customize-item-source");
        this.modal = new MenuModal(this.modalCustomize);
        this.modal.onShow(() => {
            this.onShow();
        });
        this.modal.onHide(() => {
            this.onHide();
        });
        const displayBlockingElem = function () {
            $("#modal-screen-block").fadeIn(200);
        };
        this.confirmItemModal = new MenuModal($("#modal-item-confirm"));
        this.confirmItemModal.onShow(displayBlockingElem);
        this.confirmItemModal.onHide((e) => {
            const confirmAll = e?.target?.dataset?.confirmAll;
            if (confirmAll) {
                this.confirmAllItems();
                return;
            }
            this.confirmNextItem();
        });
        account.addEventListener("request", this.onRequest.bind(this));
        account.addEventListener("loadout", this.onLoadout.bind(this));
        account.addEventListener("items", this.onItems.bind(this));
        account.addEventListener("pass", this.onPass.bind(this));
    }

    init() {
        if (!this.initialized) {
            for (let i = 0; i < this.categories.length; i++) {
                const r = $("<div/>", {
                    class: "modal-customize-cat",
                    "data-idx": i,
                });
                r.append(
                    $("<div/>", {
                        class: "modal-customize-cat-image",
                        css: {
                            "background-image": `url(${this.categories[i].categoryImage})`,
                        },
                    }),
                );
                r.append(
                    $("<div/>", {
                        class: "modal-customize-cat-connect",
                    }),
                );
                r.append(
                    $("<div/>", {
                        class: "account-alert account-alert-cat",
                    }),
                );
                $("#modal-customize-header").append(r);
            }
            this.selectableCats = $(".modal-customize-cat");
            this.selectableCatConnects = $(".modal-customize-cat-connect");
            this.selectableCatImages = $(".modal-customize-cat-image");

            // Listen for cat selection
            this.selectableCats.on("mouseup", (e) => {
                const selector = $(e.currentTarget);
                const newCategoryIdx = selector.data("idx");
                // Also switch when leaving the Settings tab, even if this category was the
                // last-selected one (its index still equals selectedCatIdx).
                if (this.settingsOpen || this.selectedCatIdx != newCategoryIdx) {
                    this.selectCat(newCategoryIdx);
                }
            });

            // Account settings tab — a sibling of the cosmetic category icons that shows
            // the settings panel instead of an item list. It carries the standalone
            // separator ("|") and is inserted right after it, before the player-icon tab,
            // so the meta tabs sit together on the right. Added after the category set is
            // captured so it isn't treated as a selectable cosmetic category.
            const settingsTab = $("<div/>", {
                id: "modal-customize-cat-standalone",
                class: "modal-customize-cat modal-customize-settings-tab",
                title: "Account settings",
            });
            settingsTab.append(
                $("<div/>", {
                    class: "modal-customize-cat-image modal-customize-settings-icon",
                    html: "⚙",
                }),
            );
            settingsTab.append($("<div/>", { class: "modal-customize-cat-connect" }));
            // Insert before the last cosmetic tab (the player-icon), right after the "|".
            $("#modal-customize-header .modal-customize-cat").last().before(settingsTab);
            settingsTab.on("mouseup", () => this.openSettingsTab());
            this.itemSort = $("#modal-customize-sort");
            this.itemSort.on("change", (e) => {
                this.sortItems(e.target.value);
            });
            // Search box filters the current category's item list by name.
            $("#modal-customize-search").on("input", () =>
                this.selectCat(this.selectedCatIdx),
            );
            $("#modal-customize-info-toggle").on("click", () => this.toggleDetailMode());
            // Account settings toggles (offers / loadout privacy).
            $("#setting-offers-disabled").on("click", () =>
                this.toggleSetting("offersDisabled", "#setting-offers-disabled"),
            );
            $("#setting-loadout-private").on("click", () =>
                this.toggleSetting("loadoutPrivate", "#setting-loadout-private"),
            );
            // Clicking an item's rarity jumps to the shop's "Owners" view for that item.
            const openOwners = () => {
                const type = this.selectedItem?.type;
                if (!type || !this.shopUi) return;
                this.hide();
                this.shopUi.openOwners(type);
            };
            this.modalCustomizeItemRarity
                .addClass("clickable-rarity")
                .on("click", openOwners);
            $("#detail-item-rarity").addClass("clickable-rarity").on("click", openOwners);
            this.modalCustomizeItemName.on("click", () => {
                const elements = document.getElementsByClassName(
                    "customize-list-item-selected",
                );
                if (elements.length > 0 && window.self === window.top) {
                    elements[0].scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                        inline: "nearest",
                    });
                }
            });
            $("#crosshair-size").on("input", () => {
                this.updateLoadoutFromDOM();
            });
            $("#crosshair-stroke").on("input", () => {
                this.updateLoadoutFromDOM();
            });
            const container = document.getElementById("color-picker");

            this.picker = new window.CP(container, false, container);
            this.picker.self.classList.add("static");

            this.picker.on("change", (color: string) => {
                $("#color-picker-hex").val(color);
                if (this.loadout?.crosshair) {
                    this.updateLoadoutFromDOM();
                }
            });

            const colorCode =
                document.querySelector<HTMLInputElement>("#color-picker-hex")!;
            const updateColor = () => {
                const value = colorCode.value;
                if (value.length) {
                    // Only accept 6 digit hex or 7 digit with a hash
                    if (value.length == 6) {
                        this.picker.set(`#${value}`);
                        this.picker.fire("change", [value]);
                    } else if (value.length == 7 && value[0] == "#") {
                        this.picker.set(value);
                        this.picker.fire("change", [value.slice(1)]);
                    } else {
                        return undefined;
                    }
                }
            };
            colorCode.oncut = updateColor;
            colorCode.onpaste = updateColor;
            colorCode.onkeyup = updateColor;
            colorCode.oninput = updateColor;
            this.initialized = true;
        }
    }

    show() {
        this.init();
        this.modal.show();
    }

    hide() {
        this.modal.hide();
    }

    onShow() {
        this.active = true;

        // Reset items to ack locally
        this.localAckItems = [];
        for (let i = 0; i < this.items.length; i++) {
            const item = this.items[i];
            if (item.status! < loadout.ItemStatus.Ackd) {
                this.localAckItems.push(item);
            }
        }
        $("#modal-customize-search").val("");
        this.selectCat(0);
        this.tryBeginConfirmingItems();
        this.updateLoadoutValue();
        $("#start-bottom-right, #start-main").fadeOut(200);
        $("#background").hide();
    }

    onHide() {
        this.active = false;
        if (loadout.modified(this.loadout, this.account.loadout)) {
            this.account.setLoadout(this.loadout);
        }
        this.clearConfirmItemModal();
        this.modalCustomize.css({
            cursor: "initial",
        });
        $("#start-bottom-right, #start-main").fadeIn(200);
        $("#background").show();
    }

    onResize() {
        // Adjust the emote modal content on mobile
        if (device.mobile) {
            if (this.categories[this.selectedCatIdx].loadoutType == "emote") {
                // Apply styling based on orientation
                $("#modal-customize-list").attr("style", "");
            } else {
                $("#modal-customize-list").attr(
                    "style",
                    device.isLandscape ? "" : "height: 380px",
                );
            }
        }
    }

    onRequest() {
        $("#modal-customize-loading").css(
            "opacity",
            this.account.requestsInFlight > 0 ? 1 : 0,
        );
    }

    onLoadout(_loadout: Loadout) {
        this.loadout = loadout.validate(_loadout);
        crosshair.setGameCrosshair(_loadout.crosshair);
        if (this.active) {
            this.selectCat(this.selectedCatIdx);
        }
    }

    onItems(items: Item[]) {
        this.items = loadout.getUserAvailableItems(items) as Item[];
        for (let i = 0; i < this.items.length; i++) {
            const item = this.items[i];
            if (
                item.status! < loadout.ItemStatus.Confirmed &&
                !this.localPendingConfirm.find((x) => {
                    return x.type == item.type;
                }) &&
                !this.localConfirmed.find((x) => {
                    return x.type == item.type;
                })
            ) {
                this.localPendingConfirm.push(item);
            }
            if (
                item.status! < loadout.ItemStatus.Ackd &&
                !this.localAckItems.find((x) => {
                    return x.id === item.id;
                })
            ) {
                // Track the specific new instance, not the type — otherwise an
                // already-owned duplicate of a new type would also get the "new" tag.
                this.localAckItems.push(item);
            }
        }
        if (this.active) {
            this.tryBeginConfirmingItems();
            this.selectCat(this.selectedCatIdx);
        }
    }

    onPass(pass: UnlockDef) {
        // Show/hide the social media buttons based on whether we have
        // unlocked them
        return;
        const unlocks = ["facebook", "instagram", "youtube", "twitter"];
        for (let i = 0; i < unlocks.length; i++) {
            const unlockType = unlocks[i];
            const hasUnlock = !!pass.unlocks[unlockType as keyof typeof pass.unlocks];
            const el = $(`.customize-social-unlock[data-lock-reason='${unlockType}']`);
            el.css({
                display: hasUnlock ? "none" : "inline-block",
            });
            el.off("click").on("click", () => {
                this.account.setPassUnlock(unlockType);
            });
        }
    }

    getCategory(gameType: string) {
        for (let i = 0; i < this.categories.length; i++) {
            const category = this.categories[i];
            if (category.gameType == gameType) {
                return category;
            }
        }
        return null;
    }

    clearConfirmItemModal() {
        this.localPendingConfirm = [];
        this.localConfirmed = [];
        this.confirmingItems = false;
        this.confirmItemModal.hide();
    }

    setItemsConfirmed() {
        const confirmItemTypes = [];
        for (let i = 0; i < this.items.length; i++) {
            const item = this.items[i];
            if (item.status! < loadout.ItemStatus.Confirmed) {
                confirmItemTypes.push(item.type);
            }
        }
        if (confirmItemTypes.length > 0) {
            this.account.setItemStatus(loadout.ItemStatus.Confirmed, confirmItemTypes);
        }
    }

    setItemsAckd(catIdx: number) {
        const category = this.categories[catIdx];

        // Ack items on the server
        const ackItemTypes = [];
        for (let i = 0; i < this.items.length; i++) {
            const item = this.items[i];
            const objDef = GameObjectDefs[item.type];
            if (
                objDef &&
                objDef.type == category.gameType &&
                item?.status! < loadout.ItemStatus.Ackd
            ) {
                ackItemTypes.push(item.type);
            }
        }
        if (ackItemTypes.length > 0) {
            this.account.setItemStatus(loadout.ItemStatus.Ackd, ackItemTypes);
        }
    }

    tryBeginConfirmingItems() {
        if (this.active && !this.confirmingItems) {
            this.confirmingItems = true;
            this.confirmNextItem();
        }
    }

    confirmAllItems() {
        this.clearConfirmItemModal();
        $("#modal-screen-block").fadeOut(300);
    }

    confirmNextItem() {
        // Confirm all pending new items in one shot upon displaying
        // the first item
        this.setItemsConfirmed();
        const currentNewItem = this.localPendingConfirm.shift()!;
        if (currentNewItem) {
            this.localConfirmed.push(currentNewItem);
            const objDef = GameObjectDefs[currentNewItem.type] as EmoteDef;
            const itemInfo = {
                type: currentNewItem.type,
                rarity: getItemRarity(currentNewItem.type),
                displayName:
                    this.localization.translate(`game-${currentNewItem.type}`) ||
                    objDef.name!,
                category: objDef.type,
            };
            const svg = helpers.getSvgFromGameType(currentNewItem.type);
            const imageUrl = `url(${svg})`;
            const transform = helpers.getCssTransformFromGameType(currentNewItem.type);
            setTimeout(() => {
                $("#modal-item-confirm-name").html(itemInfo.displayName);
                $("#modal-item-confirm-image-inner").css({
                    "background-image": imageUrl,
                    transform,
                });
                this.confirmItemModal.show();
            }, 200);
        } else {
            this.confirmingItems = false;
            $("#modal-screen-block").fadeOut(300);
        }
    }

    sortItems(sort: string) {
        this.selectedCatItems.sort(sortTypes[sort]);
        const category = this.categories[this.selectedCatIdx];

        const listChildren = $("<div/>");
        for (let i = 0; i < this.selectedCatItems.length; i++) {
            const itemInfo = this.selectedCatItems[i];
            itemInfo.outerDiv?.data("idx", i);
            listChildren.append(itemInfo.outerDiv!);
        }
        this.modalCustomizeList.html("");
        this.modalCustomizeList.append(listChildren);
        this.selectableSlots.off("mouseup");
        this.setItemListeners(category.loadoutType);
    }

    setItemListeners(loadoutType: string) {
        // listen for ui modifications
        this.selectableSlots.on("mouseup", (e) => {
            const elem = e.currentTarget;

            if (!$(elem).hasClass("customize-list-item-locked")) {
                if (this.itemSelected && !$(elem).hasClass("customize-list-item")) {
                    this.itemSelected = false;
                    return;
                }
                this.selectItem($(elem));
                this.updateLoadoutFromDOM();
            }
        });

        if (loadoutType == "emote") {
            this.setEmoteDraggable(this.selectableSlots, this);
            // Only do this once, assuming the wheel is only used for emotes
            if (!this.emotesLoaded) {
                this.setEmoteDraggable(this.droppableSlots, this);
                this.droppableSlots.on("mouseup", (e) => {
                    const elem = e.currentTarget;
                    if (!$(elem).hasClass("customize-list-item-locked")) {
                        if (
                            this.itemSelected &&
                            !$(elem).hasClass("customize-list-item")
                        ) {
                            this.deselectItem();
                            return;
                        }
                        this.selectItem($(elem));
                        this.updateLoadoutFromDOM();
                    }
                });
                this.droppableSlots.on("drop", (e) => {
                    e.originalEvent?.preventDefault();
                    const elem = e.currentTarget;
                    const parent = $(elem).parent();
                    this.updateSlot(
                        parent,
                        this.selectedItem.img,
                        this.selectedItem.type,
                    );
                    this.updateLoadoutFromDOM();
                    this.deselectItem();
                });
                this.droppableSlots.on("mousedown", (e) => {
                    if (this.itemSelected) {
                        e.stopPropagation();
                        const parent = $(e.currentTarget).parent();
                        this.updateSlot(
                            parent,
                            this.selectedItem.img,
                            this.selectedItem.type,
                        );
                        this.updateLoadoutFromDOM();
                    }
                });
                this.droppableSlots.on("dragover", function (e) {
                    e.originalEvent?.preventDefault();
                    $(this).parent().find(".ui-emote-hl").css("opacity", 1);
                });
                this.droppableSlots.on("dragleave", (e) => {
                    e.originalEvent?.preventDefault();
                    $(e.currentTarget)
                        .parent()
                        .find(".ui-emote-hl")
                        .css("opacity", this.highlightOpacityMin);
                });
                this.droppableSlots.on("dragend", (e) => {
                    e.originalEvent?.preventDefault();
                    this.deselectItem();
                });

                // Trash auto emotes
                $(".ui-emote-auto-trash").on("click", (e) => {
                    const parent = $(e.currentTarget).parent();
                    this.updateSlot(parent, "", "");
                    this.updateLoadoutFromDOM();
                });
                this.emotesLoaded = true;
            }
        } else if (loadoutType == "crosshair") {
            const crosshairHex = util.intToHex(this.loadout.crosshair.color);
            const color = [crosshairHex.slice(1)];
            this.picker.set(crosshairHex);
            $("#color-picker-hex").val(color);
            $("#crosshair-size").val(this.loadout.crosshair.size);
            $("#crosshair-stroke").val(this.loadout.crosshair.stroke);
        }
    }

    updateLoadoutFromDOM() {
        const loadoutType = this.categories[this.selectedCatIdx].loadoutType;
        if (loadoutType == "emote") {
            for (let t = 0; t < EmoteSlot.Count; t++) {
                const domElem = emoteSlotToDomElem(t);
                const slotIdx = domElem.data("idx");
                const slotItem = this.equippedItems[slotIdx];
                if (slotItem?.type) {
                    this.loadout.emotes[t] = slotItem.type;
                } else {
                    this.loadout.emotes[t] = "";
                }
            }
        } else if (loadoutType == "crosshair") {
            const size = parseFloat($("#crosshair-size").val() as string);
            const color = $("#color-picker-hex").val() as string;
            const stroke = parseFloat($("#crosshair-stroke").val() as string);
            this.loadout.crosshair = {
                type: this.selectedItem.type,
                color: util.hexToInt(color),
                size: size.toFixed(2),
                stroke: stroke.toFixed(2),
            };
        } else {
            this.loadout[loadoutType as keyof Loadout] = this.selectedItem.type as any;
        }

        this.loadout = loadout.validate(this.loadout);

        if (this.loadoutDisplay?.initialized) {
            this.loadoutDisplay.setLoadout(this.loadout);
        }
        if (this.selectedItem.loadoutType == "crosshair") {
            this.setSelectedCrosshair();
        }
        this.updateLoadoutValue();
    }

    /** Refresh the "Loadout: N · Equipped: M" Golden-Fries value bar (footer). */
    updateLoadoutValue() {
        // Free default-unlock cosmetics have no tradeable worth.
        const worthOf = (type: string) =>
            DEFAULT_UNLOCKED.has(type) ? 0 : getItemPrice(type);

        // Total worth of the instances the player actually owns (id present).
        const total = this.items
            .filter((it) => it.id != null)
            .reduce((s, it) => s + worthOf(it.type), 0);

        const l = this.loadout;
        const equippedTypes = [
            l.outfit,
            l.melee,
            l.heal,
            l.boost,
            l.death_effect,
            l.player_icon,
            l.crosshair?.type,
            ...(l.emotes ?? []),
        ].filter((t): t is string => typeof t === "string" && t.length > 0);
        const equipped = equippedTypes.reduce((s, t) => s + worthOf(t), 0);

        $("#loadout-value-bar").html(
            `Loadout <b>${total.toLocaleString("en-US")} 🍟</b> · ` +
                `Equipped <b>${equipped.toLocaleString("en-US")} 🍟</b>`,
        );
    }

    /** Selects the Settings tab: highlights it, titles the panel, and shows the settings. */
    private openSettingsTab() {
        this.settingsOpen = true;
        // Deselect the cosmetic category tabs, select the settings tab.
        this.selectableCats.removeClass("modal-customize-cat-selected");
        this.selectableCatConnects.removeClass("modal-customize-cat-connect-selected");
        this.selectableCatImages.removeClass("modal-customize-cat-image-selected");
        const tab = $(".modal-customize-settings-tab");
        tab.addClass("modal-customize-cat-selected");
        tab.find(".modal-customize-cat-connect").addClass(
            "modal-customize-cat-connect-selected",
        );
        tab.find(".modal-customize-cat-image").addClass(
            "modal-customize-cat-image-selected",
        );
        $("#modal-customize-cat-title").html("SETTINGS");

        // Swap the item list out for the settings content (search/sort don't apply here).
        $("#modal-customize-list").css("display", "none");
        $("#modal-customize-item-header").css("display", "none");
        $("#modal-customize-search").css("display", "none");
        $("#modal-customize-sort-wrap").css("display", "none");
        $("#modal-content-right-emote, #customize-emote-parent").css("display", "none");
        $("#modal-content-right-crosshair, #customize-crosshair-parent").css(
            "display",
            "none",
        );
        $("#modal-content-right-detail").css("display", "none");
        // Clear the per-item footer text (the account value bar stays relevant).
        this.modalCustomizeItemSource.html("");
        this.modalCustomizeItemLore.html("");

        // Sync toggles to current values, then show the settings content.
        $("#setting-offers-disabled").toggleClass(
            "loadout-toggle-on",
            this.account.settings.offersDisabled,
        );
        $("#setting-loadout-private").toggleClass(
            "loadout-toggle-on",
            this.account.settings.loadoutPrivate,
        );
        $("#loadout-settings-status").text("");
        $("#loadout-settings-panel").css("display", "block");
    }

    /** Restores the item list + deselects the Settings tab (when switching to a cosmetic tab). */
    private closeSettingsTab() {
        this.settingsOpen = false;
        const tab = $(".modal-customize-settings-tab");
        tab.removeClass("modal-customize-cat-selected");
        tab.find(".modal-customize-cat-connect").removeClass(
            "modal-customize-cat-connect-selected",
        );
        tab.find(".modal-customize-cat-image").removeClass(
            "modal-customize-cat-image-selected",
        );
        $("#loadout-settings-panel").css("display", "none");
        $("#modal-customize-list").css("display", "");
        $("#modal-customize-item-header").css("display", "");
        $("#modal-customize-search").css("display", "");
        $("#modal-customize-sort-wrap").css("display", "");
    }

    /** Flips one setting, updates its toggle optimistically, and persists it. */
    private toggleSetting(key: "offersDisabled" | "loadoutPrivate", sel: string) {
        const next = !this.account.settings[key];
        $(sel).toggleClass("loadout-toggle-on", next);
        $("#loadout-settings-status").text("Saving…");
        this.account.saveSettings({ [key]: next }, (err, res) => {
            if (err || !res?.success) {
                $(sel).toggleClass("loadout-toggle-on", !next); // revert
                $("#loadout-settings-status").text("Failed to save");
                return;
            }
            $("#loadout-settings-status").text("Saved ✓");
        });
    }

    selectItem(selector: JQuery<HTMLElement>, deselect = true) {
        const isListItem = selector.hasClass("customize-list-item");
        const parent = isListItem ? selector : selector.parent();
        const image = parent.find(".customize-item-image");
        const selectorIdx = parent.data("idx");
        const selectedItem = parent.data("slot")
            ? this.equippedItems[selectorIdx]
            : this.selectedCatItems[selectorIdx];

        if (!selectedItem) {
            this.itemSelected = false;
            this.selectedItem = {
                prevSlot: null,
                img: "",
                type: "",
            };
            return;
        }

        // Deselect this emote if it's already selected
        if (
            selectedItem.type == this.selectedItem.type &&
            selectedItem.loadoutType == "emote" &&
            this.selectedItem.loadoutType == "emote" &&
            deselect
        ) {
            this.deselectItem();
            return;
        }

        this.itemSelected = true;

        this.selectedItem = {
            prevSlot: isListItem ? null : parent,
            img: image.data("img"),
            id: selectedItem.id,
            previousOwners: selectedItem.previousOwners,
            games: selectedItem.games,
            wins: selectedItem.wins,
            kills: selectedItem.kills,
            damage: selectedItem.damage,
            pricePaid: selectedItem.pricePaid,
            type: selectedItem.type,
            rarity: selectedItem.rarity,
            displayName: selectedItem.displayName || "",
            displaySource: selectedItem.displaySource || "Unknown",
            displayLore: selectedItem.displayLore || "",
            loadoutType: selectedItem.loadoutType,
            subcat: selectedItem.subcat,
        };
        // Remember this exact instance (persisted) so re-entering the category — or
        // reloading the page — re-selects the same owned copy, not just the type.
        if (this.selectedItem.id != null && this.selectedItem.loadoutType) {
            const ids = { ...(this.account.config.get("selectedItemIds") ?? {}) };
            ids[this.selectedItem.loadoutType] = this.selectedItem.id;
            this.account.config.set("selectedItemIds", ids);
        }
        this.modalCustomizeItemName.html(this.selectedItem.displayName!);
        const source =
            this.localization.translate(`loadout-${selectedItem.displaySource}`) ||
            this.localization.translate(`${selectedItem.displaySource}`) ||
            this.selectedItem.displaySource;
        const sourceTxt = `${this.localization.translate("loadout-acquired")}: ${source}`;
        this.modalCustomizeItemSource.html(sourceTxt);

        // Use the 2nd line on emotes to display the subcategory
        const emoteSubcatNames = {
            [EmoteCategory.Locked]: this.localization.translate("emote-subcat-locked"),
            [EmoteCategory.Faces]: this.localization.translate("emote-subcat-faces"),
            [EmoteCategory.Food]: this.localization.translate("emote-subcat-food"),
            [EmoteCategory.Animals]: this.localization.translate("emote-subcat-animals"),
            [EmoteCategory.Logos]: this.localization.translate("emote-subcat-logos"),
            [EmoteCategory.Other]: this.localization.translate("emote-subcat-other"),
            [EmoteCategory.Flags]: this.localization.translate("emote-subcat-flags"),
            [EmoteCategory.Default]: this.localization.translate("emote-subcat-default"),
        };
        const localizedLore =
            selectedItem.loadoutType == "emote"
                ? `${this.localization.translate("loadout-category")}: ${
                      emoteSubcatNames[selectedItem.subcat]
                  }`
                : this.selectedItem.displayLore;
        this.modalCustomizeItemLore.html(localizedLore!);
        const rarityNames = ["stock", "common", "uncommon", "rare", "epic", "mythic"];
        const Rarities = [
            "#c5c5c5",
            "#c5c5c5",
            "#12ff00",
            "#00deff",
            "#f600ff",
            "#d96100",
        ];
        const localizedRarity = this.localization.translate(
            `loadout-${rarityNames[this.selectedItem.rarity!]}`,
        );
        this.modalCustomizeItemRarity.html(
            localizedRarity + ownerCountSuffix(this.selectedItem.type),
        );
        this.modalCustomizeItemRarity.css({
            color: Rarities[this.selectedItem.rarity!],
        });
        if (this.selectedItem.loadoutType == "emote") {
            this.highlightedSlots.css({
                display: "block",
                opacity: this.highlightOpacityMin,
            });
        }

        // Highlight clicked item
        this.selectableSlots.removeClass("customize-list-item-selected");
        if (isListItem) {
            selector.addClass("customize-list-item-selected");
        } else {
            parent.find(".ui-emote-hl").css("opacity", 1);
        }

        if (this.selectedItem.loadoutType == "crosshair") {
            const objDef = GameObjectDefs[this.selectedItem.type];
            if (objDef && objDef.type == "crosshair" && objDef.cursor) {
                $("#modal-content-right-crosshair").css("display", "none");
            } else {
                $("#modal-content-right-crosshair").css("display", "block");
                this.picker.exit();
                this.picker.enter();
            }
        }

        // Mark item as ackd — by instance id, so clicking one copy only clears that
        // copy's "new" tag, not a same-type duplicate's.
        const itemIdx = this.localAckItems.findIndex((x) => {
            return x.id === this.selectedItem.id;
        });
        if (itemIdx !== -1) {
            selector
                .find(".account-alert")
                .removeClass("account-alert account-alert-cat");
            this.localAckItems.splice(itemIdx, 1);
            this.setCategoryAlerts();
        }

        this.updateDetailPanel();
    }

    /** Toggle the right side between the equip UI (emote wheel/crosshair) and the
     *  item detail/info panel. */
    toggleDetailMode() {
        this.detailMode = !this.detailMode;
        $("#modal-customize-info-toggle").toggleClass(
            "info-toggle-active",
            this.detailMode,
        );
        this.refreshRightPanels();
    }

    /** Apply the right-side panel visibility for the current category + detail mode. */
    refreshRightPanels() {
        const lt = this.categories[this.selectedCatIdx]?.loadoutType ?? "";
        const showEmote = !this.detailMode && lt === "emote";
        const showCrosshair = !this.detailMode && lt === "crosshair";
        $("#modal-content-right-emote").css("display", showEmote ? "block" : "none");
        $("#customize-emote-parent").css("display", showEmote ? "block" : "none");
        $("#modal-content-right-crosshair").css(
            "display",
            showCrosshair ? "block" : "none",
        );
        $("#customize-crosshair-parent").css("display", showCrosshair ? "block" : "none");
        this.updateDetailPanel();
    }

    /**
     * Populate and show the right-side detail panel for the selected instance: image,
     * name, rarity, source, ownership history, and the Sell/Cancel action. Only while
     * detail mode is on — otherwise the equip UI / character preview owns the right side.
     */
    updateDetailPanel() {
        const panel = $("#modal-content-right-detail");
        const item = this.selectedItem;
        if (!this.detailMode || !item || !item.type) {
            panel.css("display", "none");
            return;
        }
        panel.css("display", "block");
        const owned = item.id != null; // default unlocks have no instance id

        $("#detail-item-image").css({
            "background-image": `url(${helpers.getSvgFromGameType(item.type)})`,
            transform: helpers.getCssTransformFromGameType(item.type),
        });
        $("#detail-item-name").html(item.displayName || "");

        const rarityNames = ["stock", "common", "uncommon", "rare", "epic", "mythic"];
        const rarityColors = [
            "#c5c5c5",
            "#c5c5c5",
            "#12ff00",
            "#00deff",
            "#f600ff",
            "#d96100",
        ];
        const r = item.rarity ?? 0;
        $("#detail-item-rarity")
            .html(
                (this.localization.translate(`loadout-${rarityNames[r]}`) || "") +
                    ownerCountSuffix(item.type),
            )
            .css("color", rarityColors[r] ?? "#c5c5c5");

        // Localize the source if a translation exists, else show the raw label.
        const rawSource = item.displaySource || "";
        $("#detail-item-source").html(
            owned
                ? this.localization.translate(`loadout-${rawSource}`) ||
                      this.localization.translate(rawSource) ||
                      rawSource ||
                      "Unknown"
                : "Default",
        );

        // Paid (what this owner spent) vs. current shop worth.
        const worth = getItemPrice(item.type);
        const paidTxt =
            item.pricePaid != null
                ? `${item.pricePaid.toLocaleString("en-US")} 🍟`
                : owned
                  ? "—"
                  : "Free";
        $("#detail-item-value").html(
            `Paid <b>${paidTxt}</b> · Worth <b>${worth.toLocaleString("en-US")} 🍟</b>`,
        );

        const owners = item.previousOwners ?? [];
        $("#detail-item-owners").text(
            owners.length ? owners.join("  →  ") : "Original owner",
        );

        // Lifetime match stats this instance earned while equipped.
        const statsEl = $("#detail-item-stats");
        if (owned) {
            statsEl
                .css("display", "")
                .html(
                    `<div class="detail-stat"><span class="detail-stat-val">${item.games ?? 0}</span><span class="detail-stat-lbl">Games</span></div>` +
                        `<div class="detail-stat"><span class="detail-stat-val">${item.wins ?? 0}</span><span class="detail-stat-lbl">Wins</span></div>` +
                        `<div class="detail-stat"><span class="detail-stat-val">${item.kills ?? 0}</span><span class="detail-stat-lbl">Kills</span></div>` +
                        `<div class="detail-stat"><span class="detail-stat-val">${item.damage ?? 0}</span><span class="detail-stat-lbl">Damage</span></div>`,
                );
        } else {
            statsEl.css("display", "none").empty();
        }

        this.renderDetailMarketAction();
    }

    /** Compact "Xh Ym" until a listing created at `createdAt` (ms) auto-expires. */
    private formatExpiry(createdAt: number): string {
        const remaining = createdAt + MARKET_LISTING_TTL_MS - Date.now();
        if (remaining <= 0) return "moments";
        const totalMin = Math.floor(remaining / 60000);
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }

    /** The Sell / Cancel-listing button inside the detail panel. */
    private renderDetailMarketAction() {
        const el = $("#detail-item-market");
        el.empty();
        const item = this.selectedItem;
        if (!item || item.id == null) return;

        const listing = this.account.myListings.find((l) => l.itemId === item.id);
        if (listing) {
            el.append(`<div class="detail-listed">Listed for ${listing.price}</div>`);
            if (listing.buyerSlug) {
                el.append(
                    `<div class="detail-expiry">🔒 Private → ${helpers.htmlEscape(
                        listing.buyerSlug,
                    )}</div>`,
                );
            }
            el.append(
                `<div class="detail-expiry">Auto-removed in ${this.formatExpiry(
                    listing.createdAt,
                )}</div>`,
            );
            const btn = $(
                '<div class="shop-buy-btn market-cancel-btn menu-option btn-darken">Cancel listing</div>',
            );
            btn.on("click", () => {
                btn.addClass("shop-buy-disabled").text("…");
                this.account.cancelListing(listing.listingId, () => {});
            });
            el.append(btn);
        } else if (getMarketPriceBounds(item.type)) {
            // This exact instance is up for auction: it's committed, so every action on it
            // is disabled until the auction ends.
            const auctionedNow = item.id === this.account.activeAuctionItemId;
            // A player may only run one auction at a time, so the Auction button is disabled
            // on every item while one is live.
            const hasAuction = this.account.activeAuctionItemId != null;

            if (auctionedNow) {
                el.append('<div class="detail-listed">🔨 In auction</div>');
            }

            const sellBtn = $(
                '<div class="shop-buy-btn menu-option btn-darken">Sell</div>',
            );
            if (auctionedNow) sellBtn.addClass("shop-buy-disabled");
            else
                sellBtn.on("click", () =>
                    this.marketUi?.openSellDialog(item.id!, item.type),
                );
            el.append(sellBtn);

            const auctionBtn = $(
                '<div class="shop-buy-btn detail-auction-btn menu-option btn-darken">🔨 Auction</div>',
            );
            if (auctionedNow || hasAuction) {
                auctionBtn
                    .addClass("shop-buy-disabled")
                    .attr(
                        "title",
                        auctionedNow
                            ? "This item is in an auction."
                            : "You already have an item in an auction.",
                    );
            } else {
                auctionBtn.on("click", () => {
                    this.shopUi?.open();
                    this.shopUi?.selectTab("auction");
                    this.auctionUi?.openCreate(item.id!, item.type);
                });
            }
            el.append(auctionBtn);

            const giftBtn = $(
                '<div class="shop-buy-btn detail-gift-btn menu-option btn-darken">🎁 Gift</div>',
            );
            if (auctionedNow) giftBtn.addClass("shop-buy-disabled");
            else giftBtn.on("click", () => this.socialUi?.openWithItem(item));
            el.append(giftBtn);
        }
    }

    updateSlot(parent: JQuery<HTMLElement>, img: string, type: string) {
        const prevParent = this.selectedItem.prevSlot;
        this.selectedItem = {} as (typeof this)["selectedItem"];
        if (prevParent) {
            const image = parent.find(".customize-item-image");
            const slotIdx = parent.data("idx");
            const slotItem = this.equippedItems[slotIdx];
            let slotItemType = "";
            if (slotItem.type) {
                slotItemType = slotItem.type;
            }
            this.updateSlot(prevParent, image.data("img"), slotItemType);
        }
        this.updateSlotData(parent, img, type);
    }

    deselectItem() {
        this.itemSelected = false;
        this.selectedItem = {} as (typeof this)["selectedItem"];
        this.selectableSlots.removeClass("customize-list-item-selected");
        this.highlightedSlots.css({
            display: "none",
            opacity: 0,
        });
        this.modalCustomizeItemName.html("");
        this.modalCustomizeItemSource.html("");
        this.modalCustomizeItemLore.html("");
        this.modalCustomizeItemRarity.html("");
        $("#modal-content-right-detail").css("display", "none");
    }

    updateSlotData(parent: JQuery<HTMLElement>, img: string, type: string) {
        const image = parent.find(".customize-emote-slot");
        image.css("background-image", img || "none");
        image.data("img", img || "none");
        const emoteDef = GameObjectDefs[type] as EmoteDef & { lore: string };
        const slotIdx = parent.data("idx") as number;
        if (emoteDef) {
            const itemInfo: EquippedItem = {
                loadoutType: "emote",
                type,
                rarity: getItemRarity(type),
                displayName:
                    this.localization.translate(`game-${type}`) || emoteDef.name!,
                displayLore:
                    this.localization.translate(`game-${type}-lore`) || emoteDef.lore,
                subcat: emoteDef.category,
            };
            this.equippedItems[slotIdx] = itemInfo;
        } else {
            this.equippedItems[slotIdx] = {} as EquippedItem;
        }
    }

    selectCat(catIdx: number) {
        const r = this.selectedCatIdx;
        this.selectedCatIdx = catIdx;
        this.setItemsAckd(this.selectedCatIdx);
        if (r != this.selectedCatIdx) {
            const category = this.categories[r];
            for (let i = this.localAckItems.length - 1; i >= 0; i--) {
                const s = this.localAckItems[i];
                const n = GameObjectDefs[s.type];
                // Splice out items of the previous category — and any stale entry whose
                // type no longer has a def, so a bad type can't crash the loop.
                if (!n || n.type == category.gameType) {
                    this.localAckItems.splice(i, 1);
                }
            }
        }
        const category = this.categories[this.selectedCatIdx];

        const searchQ = String($("#modal-customize-search").val() ?? "")
            .trim()
            .toLowerCase();
        const loadoutItems = this.items.filter((x) => {
            const gameTypeDef = GameObjectDefs[x.type] as {
                type?: string;
                name?: string;
            };
            if (!gameTypeDef || gameTypeDef.type != category.gameType) return false;
            if (searchQ) {
                const name = (
                    this.localization.translate(`game-${x.type}`) ||
                    gameTypeDef.name ||
                    x.type
                ).toLowerCase();
                if (!name.includes(searchQ) && !x.type.toLowerCase().includes(searchQ)) {
                    return false;
                }
            }
            return true;
        });

        // Sort items based on currently selected sort
        const displaySubcatSort =
            category.loadoutType == "emote" || category.loadoutType == "player_icon";

        $("#customize-sort-subcat").css("display", displaySubcatSort ? "block" : "none");

        let sortType = this.itemSort.val() as string;
        if (!displaySubcatSort && sortType == "subcat") {
            sortType = "newest";
            this.itemSort.val(sortType);
        }

        loadoutItems.sort(sortTypes[sortType]);

        const displayEmoteWheel = category.loadoutType == "emote";
        const displayCrosshairAdjust = category.loadoutType == "crosshair";
        const draggable = category.loadoutType == "emote";

        this.loadoutDisplay?.setView(category.loadoutType);

        // Leaving the Settings tab for a cosmetic category.
        this.closeSettingsTab();

        const _ = $(`.modal-customize-cat[data-idx='${this.selectedCatIdx}']`);
        this.selectableCats.removeClass("modal-customize-cat-selected");
        this.selectableCatConnects.removeClass("modal-customize-cat-connect-selected");
        this.selectableCatImages.removeClass("modal-customize-cat-image-selected");
        _.addClass("modal-customize-cat-selected");
        _.find(".modal-customize-cat-connect").addClass(
            "modal-customize-cat-connect-selected",
        );
        _.find(".modal-customize-cat-image").addClass(
            "modal-customize-cat-image-selected",
        );
        const localizedTitle = this.localization
            .translate(`loadout-title-${category.loadoutType}`)
            .toUpperCase();
        $("#modal-customize-cat-title").html(localizedTitle);
        // Equip panels only when NOT in detail mode (detail mode shows the info panel).
        $("#modal-content-right-crosshair").css(
            "display",
            !this.detailMode && category.loadoutType == "crosshair" ? "block" : "none",
        );
        $("#modal-content-right-emote").css(
            "display",
            !this.detailMode && category.loadoutType == "emote" ? "block" : "none",
        );
        $("#customize-emote-parent").css(
            "display",
            !this.detailMode && displayEmoteWheel ? "block" : "none",
        );
        $("#customize-crosshair-parent").css(
            "display",
            !this.detailMode && displayCrosshairAdjust ? "block" : "none",
        );
        this.modalCustomizeItemName.html("");
        this.modalCustomizeItemSource.html("");
        this.modalCustomizeItemLore.html("");
        this.modalCustomizeItemRarity.html("");
        $("#modal-content-right-detail").css("display", "none");

        const getItemSourceName = function (source: string) {
            // Shop purchases store their source as "shop:YYYY-MM-DD".
            if (source.startsWith("shop:")) {
                return `Bought on ${source.slice(5)}`;
            }
            const sourceDef = GameObjectDefs[source] as EmoteDef;
            if (sourceDef?.name) {
                return sourceDef.name;
            }
            return source;
        };

        this.selectedCatItems = [];
        let loadoutItemDiv: JQuery<HTMLElement> | "" = "";
        // The exact instance last selected in this category (preferred over the
        // first tile matching the equipped type when the player owns duplicates).
        let instanceMatchDiv: JQuery<HTMLElement> | "" = "";
        const rememberedId = (this.account.config.get("selectedItemIds") ?? {})[
            category.loadoutType
        ];
        const listItems = $("<div/>");
        for (let i = 0; i < loadoutItems.length; i++) {
            const item = loadoutItems[i];
            const objDef = GameObjectDefs[item.type] as MeleeDef;

            const itemInfo: ItemInfo = {
                id: item.id,
                previousOwners: item.previousOwners,
                games: item.games,
                wins: item.wins,
                kills: item.kills,
                damage: item.damage,
                pricePaid: item.pricePaid,
                loadoutType: category.loadoutType,
                type: item.type,
                rarity: getItemRarity(item.type),
                displayName:
                    this.localization.translate(`game-${item.type}`) || objDef.name,
                displayLore:
                    this.localization.translate(`game-${item.type}-lore`) || objDef.lore!,
                displaySource: getItemSourceName(item.source),
                timeAcquired: item.timeAcquired,
                idx: i,
                subcat: (objDef as unknown as EmoteDef).category,
                outerDiv: null,
            };

            // Create div for emote customization list
            const outerDiv = $("<div/>", {
                class: "customize-list-item customize-list-item-unlocked",
                "data-idx": i,
            });

            const svg = helpers.getSvgFromGameType(item.type);
            const transform = helpers.getCssTransformFromGameType(item.type);
            const innerDiv = $("<div/>", {
                class: "customize-item-image",
                css: {
                    "background-image": `url(${svg})`,
                    transform,
                },
                "data-img": `url(${svg})`,
                draggable,
            });
            outerDiv.append(innerDiv);

            // Notification pulse — only on the specific new instance, so an
            // already-owned duplicate of the same type doesn't get the "new" tag.
            if (
                this.localAckItems.findIndex((x) => {
                    return x.id === item.id;
                }) !== -1
            ) {
                const alertDiv = $("<div/>", {
                    class: "account-alert account-alert-cat",
                    css: {
                        display: "block",
                    },
                });
                outerDiv.append(alertDiv);
            }

            // Marker for an instance that's currently listed on the marketplace.
            if (
                item.id != null &&
                this.account.myListings.some((l) => l.itemId === item.id)
            ) {
                outerDiv.append('<div class="customize-listed-badge">Listed</div>');
            }
            // Marker for the instance that's currently up for auction.
            if (item.id != null && item.id === this.account.activeAuctionItemId) {
                outerDiv.append(
                    '<div class="customize-listed-badge customize-auction-badge">Auction</div>',
                );
            }

            // Crosshair specific styling
            if (category.gameType == "crosshair") {
                // Change the pointer in this slot
                const crosshairDef = {
                    type: itemInfo.type,
                    color: 0xffffff,
                    size: 1,
                    stroke: 0,
                } as unknown as Crosshair;
                crosshair.setElemCrosshair(outerDiv, crosshairDef);
            }

            listItems.append(outerDiv);

            // Add the itemInfo to the currently selected items array
            itemInfo.outerDiv = outerDiv;
            this.selectedCatItems.push(itemInfo);
            if (rememberedId != null && item.id === rememberedId) {
                instanceMatchDiv = itemInfo.outerDiv;
            }
            if (!loadoutItemDiv) {
                if (
                    category.loadoutType == "crosshair" &&
                    itemInfo.type == this.loadout.crosshair.type
                ) {
                    loadoutItemDiv = itemInfo.outerDiv;
                } else if (
                    category.loadoutType != "emote" &&
                    itemInfo.type ==
                        this.loadout[category.loadoutType as keyof typeof this.loadout]
                ) {
                    loadoutItemDiv = itemInfo.outerDiv;
                }
            }
        }
        this.modalCustomizeList.html("");
        this.modalCustomizeList.append(listItems);
        if (window.self === window.top) {
            this.modalCustomizeList.scrollTop(0);
        }

        // Set itemInfo for equipped emotes
        if (category.loadoutType == "emote") {
            this.equippedItems = [];

            for (let T = 0; T < this.loadout.emotes.length; T++) {
                this.equippedItems.push({} as EquippedItem);
                const emote = this.loadout.emotes[T];
                if (GameObjectDefs[emote]) {
                    const svg = helpers.getSvgFromGameType(emote);
                    const imgCss = `url(${svg})`;
                    const domElem = emoteSlotToDomElem(T);
                    this.updateSlotData(domElem, imgCss, emote);
                }
            }
        }

        this.selectableSlots = $(".customize-list-item");
        this.droppableSlots = $(".customize-col");
        this.highlightedSlots = this.droppableSlots.siblings(".ui-emote-hl");
        this.highlightOpacityMin = 0.4;
        this.itemSelected = false;

        this.setItemListeners(category.loadoutType);
        this.setCategoryAlerts();

        // Select loadout item — prefer the exact instance last selected here (emotes
        // keep their own slot-based selection, so don't force one there).
        if (instanceMatchDiv != "" && category.loadoutType !== "emote") {
            loadoutItemDiv = instanceMatchDiv;
        }
        this.deselectItem();
        if (loadoutItemDiv != "") {
            this.selectItem(loadoutItemDiv);
            if (category.loadoutType == "crosshair") {
                this.setSelectedCrosshair();
            }
            this.modalCustomizeItemName.trigger("click");
        }

        // Disable crosshair elements on Edge
        if (device.browser == "edge") {
            if (category.loadoutType == "crosshair") {
                const disableElem = function (
                    parentElem: JQuery<HTMLElement>,
                    disableElem: JQuery<HTMLElement>,
                ) {
                    const height =
                        parentElem.height()! +
                        parseInt(parentElem.css("padding-top")) +
                        parseInt(parentElem.css("padding-bottom"));
                    disableElem.css("height", height);
                };
                disableElem(
                    $("#modal-customize-body"),
                    $("#modal-content-left").find(".modal-disabled"),
                );
                disableElem(
                    $("#modal-content-right-crosshair"),
                    $("#modal-content-right-crosshair").find(".modal-disabled"),
                );
                $(".modal-disabled").css("display", "block");
            } else {
                $(".modal-disabled").css("display", "none");
            }
        }
        this.onResize();
    }

    setCategoryAlerts() {
        // Display alerts on each category that has new items
        for (let i = 0; i < this.categories.length; i++) {
            const category = this.categories[i];
            const unackdItems = this.localAckItems.filter((x) => {
                const gameTypeDef = GameObjectDefs[x.type];
                return gameTypeDef && gameTypeDef.type == category.gameType;
            });
            $(`.modal-customize-cat[data-idx='${i}']`)
                .find(".account-alert-cat")
                .css("display", unackdItems.length > 0 ? "block" : "none");
        }
    }

    setEmoteDraggable(selector: JQuery<HTMLElement>, that: LoadoutMenu) {
        selector.on("dragstart", function (e) {
            if (
                !$(this).hasClass("customize-list-item-locked") &&
                (that.selectItem($(this), false), device.browser != "edge")
            ) {
                const imgDiv = document.createElement("img");
                imgDiv.src = that.selectedItem.img
                    ? that.selectedItem.img
                          .replace("url(", "")
                          .replace(")", "")
                          .replace(/\'/gi, "")
                    : "";
                e.originalEvent?.dataTransfer?.setDragImage(imgDiv, 64, 64);
            }
        });
    }

    setSelectedCrosshair() {
        const crosshairDef = this.loadout.crosshair;
        $("#customize-crosshair-selected")
            .find(".customize-item-image")
            .css({
                "background-image": crosshair.getCursorURL(crosshairDef),
            });
        crosshair.setElemCrosshair($("#customize-crosshair-selected"), crosshairDef);
    }
}
