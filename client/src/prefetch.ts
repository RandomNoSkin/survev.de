/**
 * Startup requests the inline script in index.html sends right away - before the
 * ~600 KB of JS have loaded - so site info, profile and pass are (nearly) there by the
 * time the app asks for them. Each answer can be taken once; anything that doesn't
 * match exactly (other URL/body, API on another host, failed request) goes through
 * the normal request path instead.
 */
declare global {
    interface Window {
        __svPrefetch?: Record<string, Promise<unknown>>;
    }
}

export function prefetchKey(method: string, url: string, body?: unknown): string {
    return `${method} ${url} ${body === undefined || body === null ? "" : JSON.stringify(body)}`;
}

/** The prefetched answer for this request, once, or undefined. */
export function takePrefetch<T>(key: string): Promise<T> | undefined {
    const store = window.__svPrefetch;
    const pending = store?.[key];
    if (!pending) return undefined;
    delete store[key];
    return pending as Promise<T>;
}
