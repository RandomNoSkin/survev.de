import $ from "jquery";
import { api } from "./api";
import { proxy } from "./proxy";

export type AjaxCallback = (err: null | JQuery.jqXHR<any>, res?: any) => void;

export type DataOrCallback = Record<string, unknown> | AjaxCallback | null;

/**
 * Session-cookie-authenticated POST helper shared by `Account` and any lightweight,
 * standalone page (dev dashboard, OAuth consent screens) that needs to talk to the
 * API without pulling in the rest of `Account`'s state (loadout, market, etc.).
 */
export function ajaxRequest(url: string, data: DataOrCallback, cb: AjaxCallback) {
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
