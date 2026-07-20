import $ from "jquery";
import { MinGames } from "../../../../shared/constants.ts";
import { MapId } from "../../../../shared/gameConfig.ts";
import type { LeaderboardRequest } from "../../../../shared/types/stats.ts";
import { api } from "../../api.ts";
import { device } from "../../device.ts";
import { helpers } from "../../helpers.ts";
import type { App } from "./app.ts";
import leaderboard from "./templates/leaderboard.ejs";
import leaderboardError from "./templates/leaderboardError.ejs";
import loading from "./templates/loading.ejs";
import main from "./templates/main.ejs";

const templates = {
    loading,
    main,
    leaderboard,
    leaderboardError,
};

// Leaderboard map filter is limited to the competitive / special modes only.
const LEADERBOARD_MAP_IDS: number[] = [
    MapId.Comp,
    MapId.CompSolo,
    MapId.CompDuo,
    MapId.Scrims,
    MapId.TwoVsTwo,
    MapId.FourVsFour,
    MapId.Local,
];
const DEFAULT_MAP_ID = String(LEADERBOARD_MAP_IDS[0]);

//
// MainView
//
export class MainView {
    loading = false;
    error = false;
    data = {} as Partial<
        LeaderboardRequest & {
            data: {
                username: string;
                usernames: string[];
                slug: string;
                slugs: string[];
            }[];
        }
    >;
    el = $(
        templates.main({
            phoneDetected: device.mobile && !device.tablet,
            gameModes: helpers
                .getGameModes()
                .filter((m) => LEADERBOARD_MAP_IDS.includes(m.mapId)),
        }),
    );

    constructor(readonly app: App) {
        this.el.find(".leaderboard-opt").change(() => {
            this.onChangedParams();
        });
    }
    load() {
        this.loading = true;
        this.error = false;

        // Supported args so far:
        //   type:     most_kills, most_damage_dealt, kills, wins, kpg
        //   interval: daily, weekly, alltime
        //   teamMode: solo, duo, squad
        //   maxCount: 10, 100
        let type = helpers.getParameterByName<LeaderboardRequest["type"]>("type")
            || "most_kills";
        const interval = helpers.getParameterByName<LeaderboardRequest["interval"]>("t") || "daily";
        const teamMode = helpers.getParameterByName("team") || "solo";
        let mapId = helpers.getParameterByName("mapId") || DEFAULT_MAP_ID;
        // Fall back to the first allowed map if the URL points at a now-hidden one.
        if (!LEADERBOARD_MAP_IDS.includes(Number(mapId))) mapId = DEFAULT_MAP_ID;
        // Change to most_damage_dealt if faction mode and most_kills selected
        if (type == "most_kills" && Number(mapId) == 3) {
            type = "most_damage_dealt";
        }

        const args: LeaderboardRequest = {
            type: type,
            interval: interval,
            teamMode: teamMode as unknown as number,
            mapId: mapId as unknown as number,
        };

        $.ajax({
            url: api.resolveUrl("/api/leaderboard"),
            type: "POST",
            data: JSON.stringify(args),
            contentType: "application/json; charset=utf-8",
            success: (data) => {
                this.data = {
                    type: type,
                    interval: interval,
                    teamMode: teamMode as unknown as number,
                    mapId: mapId as unknown as number,
                    data: data,
                };
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
        const type = $("#leaderboard-type").val();
        const time = $("#leaderboard-time").val();
        const teamMode = $("#leaderboard-team-mode").val();
        const mapId = $("#leaderboard-map-id").val();
        window.history.pushState(
            "",
            "",
            `?type=${type}&team=${teamMode}&t=${time}&mapId=${mapId}`,
        );
        this.load();
    }
    render() {
        // Compute derived values
        const TypeToString = {
            most_kills: "stats-most-kills",
            most_damage_dealt: "stats-most-damage",
            kills: "stats-total-kills",
            wins: "stats-total-wins",
            kpg: "stats-kpg",
        } satisfies Record<LeaderboardRequest["type"], string>;
        let content = "";
        if (this.loading) {
            content = templates.loading({
                type: "leaderboard",
            });
        } else if (this.error || !this.data.data) {
            content = templates.leaderboardError({});
        } else {
            const statName = TypeToString[this.data.type as keyof typeof TypeToString] || "";

            content = templates.leaderboard({
                ...this.data,
                statName: statName,
            });

            // Set the select options
            $("#leaderboard-team-mode").val(this.data.teamMode!);
            $("#leaderboard-map-id").val(this.data.mapId!);
            $("#leaderboard-type").val(this.data.type!);
            $("#leaderboard-time").val(this.data.interval!);

            // Disable most kills option if 50v50 selected
            const factionMode = Number(this.data.mapId) == 3;
            if (factionMode) {
                $("#leaderboard-type option[value=\"most_kills\"]").attr(
                    "disabled",
                    "disabled",
                );
            } else {
                $("#leaderboard-type option[value=\"most_kills\"]").removeAttr("disabled");
            }
        }

        this.el.find(".content").html(content);
        this.app.localization.localizeIndex();
    }
}
