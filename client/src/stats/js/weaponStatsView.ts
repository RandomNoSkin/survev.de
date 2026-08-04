import $ from "jquery";
import type { WeaponStatsRequest, WeaponStatsResponse } from "../../../../shared/types/stats.ts";
import { ALL_MAPS, ALL_TEAM_MODES } from "../../../../shared/types/stats.ts";
import { api } from "../../api.ts";
import { helpers } from "../../helpers.ts";
import type { App } from "./app.ts";
import leaderboardError from "./templates/leaderboardError.ejs";
import loading from "./templates/loading.ejs";
import weaponStats from "./templates/weaponStats.ejs";
import weaponStatsTable from "./templates/weaponStatsTable.ejs";

const templates = {
    loading,
    weaponStats,
    weaponStatsTable,
    leaderboardError,
};

type RangePreset = "7" | "30" | "month" | "alltime" | "custom";

function toIsoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** Resolves a range preset (+ optional custom from/to) to a concrete [from, to] pair. */
function resolveRange(
    range: RangePreset,
    customFrom: string,
    customTo: string,
): { from: string; to: string } {
    const today = new Date();
    const to = toIsoDate(today);

    if (range === "custom") {
        return {
            from: customFrom || toIsoDate(new Date(today.getTime() - 6 * 86400000)),
            to: customTo || to,
        };
    }
    if (range === "alltime") {
        return { from: "2000-01-01", to };
    }
    if (range === "month") {
        const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
        return { from: toIsoDate(first), to };
    }
    const days = range === "30" ? 30 : 7;
    return { from: toIsoDate(new Date(today.getTime() - (days - 1) * 86400000)), to };
}

export class WeaponStatsView {
    loading = false;
    error = false;
    data: WeaponStatsResponse | null = null;
    pendingParams: {
        teamMode: number;
        mapId: string;
        range: RangePreset;
        from: string;
        to: string;
    } | null = null;
    el = $(
        templates.weaponStats({
            gameModes: helpers.getGameModes(),
        }),
    );

    constructor(readonly app: App) {
        this.el.find(".weapon-stats-opt").change(() => {
            this.onChangedParams();
        });
    }

    load() {
        this.loading = true;
        this.error = false;

        const teamMode = Number(helpers.getParameterByName("team") || ALL_TEAM_MODES);
        const mapId = helpers.getParameterByName("mapId") || ALL_MAPS;
        const range = (helpers.getParameterByName<RangePreset>("range") || "7") as RangePreset;
        const customFrom = helpers.getParameterByName("from");
        const customTo = helpers.getParameterByName("to");

        const { from, to } = resolveRange(range, customFrom, customTo);

        const args: WeaponStatsRequest = {
            from,
            to,
            mapIdFilter: mapId,
            teamModeFilter: teamMode as WeaponStatsRequest["teamModeFilter"],
        };

        this.pendingParams = { teamMode, mapId, range, from, to };

        $.ajax({
            url: api.resolveUrl("/api/weapon_stats"),
            type: "POST",
            data: JSON.stringify(args),
            contentType: "application/json; charset=utf-8",
            success: (data: WeaponStatsResponse) => {
                this.data = data;
            },
            error: () => {
                this.error = true;
            },
            complete: () => {
                this.loading = false;
                this.render();
            },
        });

        this.render();
    }

    onChangedParams() {
        const teamMode = $("#weapon-stats-team-mode").val();
        const mapId = $("#weapon-stats-map-id").val();
        const range = $("#weapon-stats-range").val() as RangePreset;
        const from = $("#weapon-stats-from").val();
        const to = $("#weapon-stats-to").val();

        const params = new URLSearchParams({
            view: "weapons",
            team: String(teamMode),
            mapId: String(mapId),
            range,
        });
        if (range === "custom") {
            if (from) params.set("from", String(from));
            if (to) params.set("to", String(to));
        }
        window.history.pushState("", "", `?${params.toString()}`);
        this.load();
    }

    render() {
        let content = "";
        if (this.loading) {
            content = templates.loading({ type: "leaderboard" });
        } else if (this.error || !this.data) {
            content = templates.leaderboardError({});
        } else {
            content = templates.weaponStatsTable({ data: this.data });

            const p = this.pendingParams;
            if (p) {
                $("#weapon-stats-team-mode").val(String(p.teamMode));
                $("#weapon-stats-map-id").val(p.mapId);
                $("#weapon-stats-range").val(p.range);
                $("#weapon-stats-from").val(p.from);
                $("#weapon-stats-to").val(p.to);
                const customRange = p.range === "custom";
                $("#weapon-stats-from").prop("disabled", !customRange);
                $("#weapon-stats-to").prop("disabled", !customRange);
            }
        }

        this.el.find(".content").html(content);
        this.app.localization.localizeIndex();
    }
}
