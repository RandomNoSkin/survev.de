import $ from "jquery";
import { type CosmeticStat, cosmeticStats } from "../../shared/utils/cosmeticStats";
import { api } from "./api";

interface CosmeticStatsRes {
    stats?: Record<string, CosmeticStat>;
    totalAccounts?: number;
}

/** Fetch ownership-based cosmetic rarity + owner counts and publish them app-wide. */
export function loadCosmeticStats(): void {
    $.ajax(api.resolveUrl("/api/cosmetic_stats"))
        .done((data: CosmeticStatsRes) => {
            if (data?.stats) {
                cosmeticStats.set(data.stats, data.totalAccounts ?? 0);
            }
        })
        .fail(() => {
            // Non-fatal: UI + pricing fall back to static def rarity.
        });
}

/**
 * Load once at boot. The server recomputes these stats only daily (midnight cron), so a
 * single fetch per session is enough — no client-side polling loop.
 */
export function startCosmeticStats(): void {
    loadCosmeticStats();
}
