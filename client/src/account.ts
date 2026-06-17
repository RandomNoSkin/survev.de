import $ from "jquery";
import type {
    BuyListingResponse,
    BuyShopResponse,
    CancelListingResponse,
    ListItemResponse,
    LoadoutRequest,
    LoadoutResponse,
    MarketBrowseRequest,
    MarketListResponse,
    MyListing,
    ProfileResponse,
    RefreshQuestRequest,
    RefreshQuestResponse,
    SaleNotification,
    SetItemStatusRequest,
    SetPassUnlockRequest,
    SetPassUnlockResponse,
    SetQuestRequest,
    ShopResponse,
    UsernameRequest,
    UsernameResponse,
} from "../../shared/types/user";
import type { ItemStatus } from "../../shared/utils/loadout";
import { type Loadout, loadout as loadouts } from "../../shared/utils/loadout";
import { util } from "../../shared/utils/util";
import { api } from "./api";
import type { ConfigManager } from "./config";
import { errorLogManager } from "./errorLogs";
import { helpers } from "./helpers";
import { proxy } from "./proxy";
import type { Item } from "./ui/loadoutMenu";

type DataOrCallback =
    | Record<string, unknown>
    | ((err: null | JQuery.jqXHR<any>, res?: any) => void)
    | null;

function ajaxRequest(
    url: string,
    data: DataOrCallback,
    cb: (err: null | JQuery.jqXHR<any>, res?: any) => void,
) {
    if (typeof data === "function") {
        cb = data;
        data = null;
    }
    const opts: JQueryAjaxSettings = {
        url: api.resolveUrl(url),
        type: "POST",
        timeout: 10 * 1000,
        xhrFields: {
            withCredentials: proxy.anyLoginSupported(),
        },
        headers: {
            // Set a header to guard against CSRF attacks.
            //
            // JQuery does this automatically, however we'll add it here explicitly
            // so the intent is clear incase of refactoring in the future.
            "X-Requested-With": "XMLHttpRequest",
        },
    };
    if (data) {
        opts.contentType = "application/json; charset=utf-8";
        opts.data = JSON.stringify(data);
    }
    $.ajax(opts)
        .done((res) => {
            cb(null, res);
        })
        .fail((e) => {
            cb(e);
        });
}

export type Quest = {
    idx: number;
    type: string;
    timeAcquired: number;
    progress: number;
    target: number;
    complete: boolean;
    rerolled: boolean;
    timeToRefresh: number;
};
export type PassType = {
    type: string;
    level: number;
    xp: number;
    newItems: unknown;
};

export class Account {
    events: Record<string, Array<(...args: any[]) => void>> = {};
    requestsInFlight = 0;
    loggingIn = false;
    loggedIn = false;
    profile = {
        linked: false,
        usernameSet: false,
        username: "",
        slug: "",
        usernameChangeTime: 0,
        goldenFries: 0,
    };

    loadout = loadouts.defaultLoadout();
    items: Item[] = [];
    /** The caller's own active marketplace listings (from the profile response). */
    myListings: MyListing[] = [];
    /** Marketplace sales the seller hasn't acknowledged yet (drives the sold popup). */
    sales: SaleNotification[] = [];
    quests: Quest[] = [];
    questPriv = "";
    pass: Record<string, PassType> = {};

    constructor(public config: ConfigManager) {}

    ajaxRequest(url: string, data: DataOrCallback, cb?: (err: any, res?: any) => void) {
        if (typeof data === "function") {
            cb = data;
            data = null;
        }
        this.requestsInFlight++;
        this.emit("request", this);

        ajaxRequest(url, data, (err, res) => {
            cb!(err, res);
            this.requestsInFlight--;
            this.emit("request", this);
            if (this.requestsInFlight == 0) {
                this.emit("requestsComplete");
            }
        });
    }

    addEventListener(event: string, callback: (...args: any[]) => void) {
        this.events[event] = this.events[event] || [];
        this.events[event].push(callback);
    }

    removeEventListener(event: string, callback: () => void) {
        const listeners = this.events[event] || [];
        for (let i = listeners.length - 1; i >= 0; i--) {
            if (listeners[i] == callback) {
                listeners.splice(i, 1);
            }
        }
    }

    emit(event: string, ...args: any[]) {
        const listenersCopy = (this.events[event] || []).slice(0);
        // const len = arguments.length;
        // const data = Array(len > 1 ? len - 1 : 0);
        // for (let i = 1; i < len; i++) {
        //     data[i - 1] = arguments[i];
        // }
        for (let i = 0; i < listenersCopy.length; i++) {
            // listenersCopy[i].apply(listenersCopy, args);
            listenersCopy[i](...args);
        }
    }

    init() {
        if (this.config.get("sessionCookie")) {
            this.setSessionCookies();
        }

        if (helpers.getCookie("app-data")) {
            this.login();
            return;
        }

        this.emit("request", this);
        this.emit("items", []);

        const storedLoadout = this.config.get("loadout");
        this.loadout = util.mergeDeep({}, loadouts.defaultLoadout(), storedLoadout);
        this.emit("loadout", this.loadout);
    }

    setSessionCookies() {
        this.clearSessionCookies();
        document.cookie = this.config.get("sessionCookie")!;
        document.cookie = `app-data=${Date.now()}`;
    }

    clearSessionCookies() {
        document.cookie = "app-sid=;expires=Thu, 01 Jan 1970 00:00:01 GMT;";
        document.cookie = "app-data=;expires=Thu, 01 Jan 1970 00:00:01 GMT;";
    }

    loginWithAccessToken(
        authUrl: string,
        requestTokenFn: (cb: (...args: any[]) => void) => void,
        extractTokenFn: (...args: any[]) => void,
    ) {
        requestTokenFn((err, data) => {
            if (err) {
                this.emit("error", "login_failed");
                return;
            }
            const token = extractTokenFn(data) as unknown as string;
            this.ajaxRequest(`${authUrl}?access_token=${token}`, (err, res) => {
                if (err) {
                    this.emit("error", "login_failed");
                } else {
                    this.config.set("sessionCookie", res.cookie);
                    this.setSessionCookies();
                    this.login();
                }
            });
        });
    }

    login() {
        if (helpers.getCookie("app-data")) {
            this.loadProfile();
            this.getPass(true);
        }
    }

    logout() {
        this.config.set("profile", null);
        this.config.set("sessionCookie", null);
        this.config.set("loadout", loadouts.defaultLoadout());
        this.ajaxRequest("/api/user/logout", () => {
            window.location.reload();
        });
    }

    loadProfile() {
        this.loggingIn = !this.loggedIn;
        this.ajaxRequest("/api/user/profile", (err, data: ProfileResponse) => {
            const a = this.loggingIn;
            this.loggingIn = false;
            this.loggedIn = false;
            this.profile = {} as this["profile"];
            this.items = [];
            this.myListings = [];
            this.sales = [];
            if (err) {
                errorLogManager.storeGeneric("account", "load_profile_error");
            } else if (data.banned) {
                this.emit("error", "account_banned", data.reason);
            } else if (data.success) {
                this.loggedIn = true;
                this.profile = data.profile;
                this.items = data.items;
                this.myListings = data.listings ?? [];
                this.sales = data.sales ?? [];
                this.loadout = data.loadout;
                const profile = this.config.get("profile") || { slug: "" };
                profile.slug = data.profile.slug;
                this.config.set("profile", profile);
            }
            if (!this.loggedIn) {
                this.config.set("sessionCookie", null);
            }
            if (a && this.loggedIn) {
                this.emit("login", this);
            }
            this.emit("items", this.items);
            this.emit("loadout", this.loadout);
            this.emit("sales", this.sales);
        });
    }

    /**
     * Reports the instance ids the player currently has selected/equipped, so the server
     * can attach this game's cosmetic stats to the exact owned copy (not just the oldest
     * of a type). Called on game join — a snapshot of "what's equipped at the start".
     */
    reportEquippedInstances() {
        if (!this.loggedIn) return;
        const ids = Object.values(this.config.get("selectedItemIds") ?? {}).filter(
            (id): id is number => typeof id === "number",
        );
        this.ajaxRequest("/api/user/equipped_instances", { ids }, (err) => {
            if (err) errorLogManager.storeGeneric("account", "equipped_instances_error");
        });
    }

    /** Acknowledges sale notifications so the "your item sold" popup won't fire again. */
    ackSales(listingIds: number[], cb?: (err: unknown) => void) {
        if (!listingIds.length) {
            cb?.(null);
            return;
        }
        this.ajaxRequest("/api/user/market/ack_sales", { listingIds }, (err) => {
            if (err) errorLogManager.storeGeneric("account", "ack_sales_error");
            cb?.(err);
        });
    }

    resetStats() {
        this.ajaxRequest("/api/user/reset_stats", (err) => {
            if (err) {
                errorLogManager.storeGeneric("account", "reset_stats_error");
                this.emit("error", "server_error");
            }
        });
    }

    deleteAccount() {
        this.ajaxRequest("/api/user/delete", (err) => {
            if (err) {
                errorLogManager.storeGeneric("account", "delete_error");
                this.emit("error", "server_error");
                return;
            }
            this.config.set("profile", null);
            this.config.set("sessionCookie", null);
            window.location.reload();
        });
    }

    setUsername(username: string, callback: (err?: string) => void) {
        const args: UsernameRequest = {
            username,
        };
        this.ajaxRequest("/api/user/username", args, (err, res: UsernameResponse) => {
            if (err) {
                errorLogManager.storeGeneric("account", "set_username_error");
                callback(err);
                return;
            }
            if (res.result == "success") {
                this.loadProfile();
                callback();
            } else {
                callback(res.result);
            }
        });
    }

    setLoadout(loadout: Loadout) {
        // Preemptively set the new loadout and revert if the call fail
        const loadoutPrev = this.loadout;
        this.loadout = loadout;
        this.emit("loadout", this.loadout);
        this.config.set("loadout", loadout);

        if (!helpers.getCookie("app-data")) return;
        const args: LoadoutRequest = {
            loadout: loadout,
        };
        this.ajaxRequest("/api/user/loadout", args, (err, res: LoadoutResponse) => {
            if (err) {
                errorLogManager.storeGeneric("account", "set_loadout_error");
                this.emit("error", "server_error");
            }
            if (err || !res.loadout) {
                this.loadout = loadoutPrev;
            } else {
                this.loadout = res.loadout;
            }
            this.emit("loadout", this.loadout);
        });
    }

    setItemStatus(status: ItemStatus, itemTypes: string[]) {
        if (itemTypes.length != 0) {
            // Preemptively mark the item status as modified on our local copy.
            // Update every instance of each type (matching the server's bulk update),
            // not just the first match — otherwise duplicate-type items stay below the
            // new status and keep re-triggering setItemsAckd/setItemStatus.
            for (const item of this.items) {
                if (itemTypes.includes(item.type)) {
                    item.status = Math.max(item.status ?? loadouts.ItemStatus.New, status);
                }
            }

            const args: SetItemStatusRequest = {
                status,
                itemTypes,
            };
            this.emit("items", this.items);
            this.ajaxRequest("/api/user/set_item_status", args, (err) => {
                if (err) {
                    errorLogManager.storeGeneric("account", "set_item_status_error");
                }
            });
        }
    }

    setQuest(args: SetQuestRequest) {
        this.ajaxRequest("/api/user/set_quest", args, () => {
            this.getPass(false);
        });
    }

    getPass(tryRefreshQuests: boolean) {
        //return;
        const args = {
            tryRefreshQuests,
        };
        this.ajaxRequest("/api/user/get_pass", args, (err, res) => {
            this.pass = {};
            this.quests = [];
            this.questPriv = "";
            if (err || !res.success) {
                errorLogManager.storeGeneric("account", "get_pass_error");
            } else {
                this.pass = res.pass || {};
                this.quests = res.quests || [];
                this.questPriv = res.questPriv || "";
                this.quests.sort((a, b) => {
                    return a.idx - b.idx;
                });
                this.emit("pass", this.pass, this.quests, true);
                // Reload the profile if new cosmetics OR Golden Fries were granted,
                // so the items list and the top-left fries balance stay in sync.
                if (this.pass.newItems || (res.goldenFriesAwarded ?? 0) > 0) {
                    this.loadProfile();
                }
            }
        });
    }

    setPassUnlock(unlockType: string) {
        const args: SetPassUnlockRequest = {
            unlockType,
        };
        this.ajaxRequest(
            "/api/user/set_pass_unlock",
            args,
            (err, res: SetPassUnlockResponse) => {
                if (err || !res.success) {
                    errorLogManager.storeGeneric("account", "set_pass_unlock_error");
                } else {
                    this.getPass(false);
                }
            },
        );
    }

    refreshQuest(idx: number) {
        const args: RefreshQuestRequest = {
            idx,
        };
        this.ajaxRequest(
            "/api/user/refresh_quest",
            args,
            (err, res: RefreshQuestResponse) => {
                if (err) {
                    errorLogManager.storeGeneric("account", "refresh_quest_error");
                    return;
                }
                if (res.success) {
                    this.getPass(false);
                } else {
                    // Give the pass UI a chance to update quests
                    this.emit("pass", this.pass, this.quests, false);
                }
            },
        );
    }

    getShop(cb: (err: unknown, res?: ShopResponse) => void) {
        this.ajaxRequest("/api/user/shop", {}, (err, res: ShopResponse) => {
            if (err) {
                errorLogManager.storeGeneric("account", "get_shop_error");
            }
            cb(err, res);
        });
    }

    buyShopOffer(slot: number, cb: (err: unknown, res?: BuyShopResponse) => void) {
        this.ajaxRequest(
            "/api/user/shop/buy",
            { slot },
            (err, res: BuyShopResponse) => {
                if (err) {
                    errorLogManager.storeGeneric("account", "buy_shop_error");
                } else if (res.success) {
                    // Refresh balance + inventory after a purchase.
                    this.loadProfile();
                }
                cb(err, res);
            },
        );
    }

    //
    // MARKET (player-to-player marketplace)
    //

    getMarket(
        filters: MarketBrowseRequest,
        cb: (err: unknown, res?: MarketListResponse) => void,
    ) {
        this.ajaxRequest("/api/user/market/listings", filters, (err, res) => {
            if (err) errorLogManager.storeGeneric("account", "get_market_error");
            cb(err, res);
        });
    }

    getStorefront(slug: string, cb: (err: unknown, res?: MarketListResponse) => void) {
        this.ajaxRequest("/api/user/market/storefront", { slug }, (err, res) => {
            if (err) errorLogManager.storeGeneric("account", "get_storefront_error");
            cb(err, res);
        });
    }

    getPrivateOffers(cb: (err: unknown, res?: MarketListResponse) => void) {
        this.ajaxRequest("/api/user/market/private", {}, (err, res) => {
            if (err) errorLogManager.storeGeneric("account", "get_private_offers_error");
            cb(err, res);
        });
    }

    listItem(
        itemId: number,
        price: number,
        buyerSlug: string | undefined,
        cb: (err: unknown, res?: ListItemResponse) => void,
    ) {
        this.ajaxRequest(
            "/api/user/market/list",
            buyerSlug ? { itemId, price, buyerSlug } : { itemId, price },
            (err, res: ListItemResponse) => {
                if (err) {
                    errorLogManager.storeGeneric("account", "list_item_error");
                } else if (res.success) {
                    this.loadProfile();
                }
                cb(err, res);
            },
        );
    }

    buyListing(listingId: number, cb: (err: unknown, res?: BuyListingResponse) => void) {
        this.ajaxRequest(
            "/api/user/market/buy",
            { listingId },
            (err, res: BuyListingResponse) => {
                if (err) {
                    errorLogManager.storeGeneric("account", "buy_listing_error");
                } else if (res.success) {
                    // Refresh balance + inventory after a purchase.
                    this.loadProfile();
                }
                cb(err, res);
            },
        );
    }

    cancelListing(
        listingId: number,
        cb: (err: unknown, res?: CancelListingResponse) => void,
    ) {
        this.ajaxRequest(
            "/api/user/market/cancel",
            { listingId },
            (err, res: CancelListingResponse) => {
                if (err) {
                    errorLogManager.storeGeneric("account", "cancel_listing_error");
                } else if (res.success) {
                    this.loadProfile();
                }
                cb(err, res);
            },
        );
    }
}
