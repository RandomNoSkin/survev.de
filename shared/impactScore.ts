/**
 * "Impact score" for team-mode matches (Duo/Squad): a transparent, category-based
 * rating of a player's contribution beyond raw kills/damage, covering combat output
 * and teamplay (revives, peeling enemies off teammates, assists).
 *
 * Gated per-map via `MapDef.gameMode.impactWeight` (0 = disabled, see mapDefs.ts) so
 * arena/comp modes with different rulesets aren't scored unless explicitly opted in.
 */

export interface ImpactStats {
    kills: number;
    damageDealt: number;
    damageTaken: number;
    assists: number;
    revives: number;
    /** Times this player was covering (nearby + actively fighting) when a teammate
     *  completed a revive — counted the same as a revive in the share below, since
     *  holding an angle while someone revives is just as valuable as reviving. */
    covers: number;
    teammateSaves: number;
    /** Times this player was downed this match (liability signal). */
    timesDowned: number;
    /** Times a teammate got credited a "save" for peeling an enemy off this player
     *  (see `teammateSaves` in player.ts) — a noisier liability signal than a down,
     *  since drawing fire on purpose (baiting/tanking) looks the same. */
    timesNeededSaving: number;
    /** Number of enemy players in the match (full lobby minus own team). Used to scale
     *  kill points — a kill is worth less when the lobby has more enemies to find and
     *  worth more in a small lobby, so raw kill count alone isn't comparable across
     *  match sizes (e.g. duo vs squad comp lobbies). */
    enemyCount: number;
    /** Times a teammate (excluding self) went down this match — the total number of
     *  revives that were actually possible. Revive points are this player's share of
     *  that total, not a raw count, so a quiet match with few downs doesn't lock them
     *  out of a max score, and a chaotic one doesn't let raw revive count alone hit it. */
    reviveOpportunities: number;
    /** Times a teammate (excluding self) needed saving this match — the save-points
     *  equivalent of `reviveOpportunities`. */
    saveOpportunities: number;
}

export interface ImpactCategory {
    points: number;
    max: number;
    detail: string;
}

export interface ImpactBreakdown {
    combat: ImpactCategory;
    support: ImpactCategory;
}

export interface ImpactResult {
    score: number;
    breakdown: ImpactBreakdown;
}

export const IMPACT_WEIGHTS = {
    combat: {
        max: 60,
        pointsPerKill: 8,
        maxKillPoints: 24,
        // pointsPerKill above is tuned for a lobby with this many enemies (e.g. two
        // 4-player squads facing off); pointsPerKill scales down as the enemy count
        // rises above it and up as it drops below, so a kill counts for as much in a
        // 6-enemy duo lobby as in a 4-enemy squad one.
        referenceEnemyCount: 4,
        damagePerPoint: 25,
        maxDamagePoints: 24,
        maxEfficiencyPoints: 12,
    },
    support: {
        max: 40,
        // Revive/save points are awarded as a share of reviveOpportunities/
        // saveOpportunities (see computeImpactScore), not a flat rate per revive/save.
        maxRevivePoints: 16,
        maxSavePoints: 12,
        pointsPerAssist: 3,
        maxAssistPoints: 12,
        // Liability mali — clear signal (an actual down) costs more than the noisier
        // "someone had to peel for me but I never went down" signal.
        pointsPerDown: 4,
        maxDownPenalty: 12,
        pointsPerNeedSave: 2,
        maxNeedSavePenalty: 8,
    },
} as const;

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/** Impact-score letter ranks, worst → best, as even ~11-point bands over the 0-100
 *  score. First-guess thresholds — revisit once real rating distributions are
 *  observed (players may cluster more in some bands than others). */
export const IMPACT_RANKS = [
    { name: "F", min: 0 },
    { name: "E", min: 11 },
    { name: "D", min: 22 },
    { name: "C", min: 33 },
    { name: "B-", min: 44 },
    { name: "B", min: 55 },
    { name: "A-", min: 66 },
    { name: "A", min: 77 },
    { name: "S", min: 88 },
] as const;

/** Maps an impact score (0-100) to its letter rank. Null in/out (no games with a
 *  score yet, e.g. solo-only or a filter with no matching matches). */
export function getImpactRank(score: number | null | undefined): string | null {
    if (score === null || score === undefined) return null;
    let rank: string = IMPACT_RANKS[0].name;
    for (const tier of IMPACT_RANKS) {
        if (score >= tier.min) rank = tier.name;
    }
    return rank;
}

/**
 * Computes the impact score for one player's match. Returns `null` when the map
 * doesn't participate (`impactWeight` unset/0) — callers should store `null` rather
 * than a zero score, so it's excluded from lifetime averages.
 */
export function computeImpactScore(
    stats: ImpactStats,
    impactWeight: number | undefined,
): ImpactResult | null {
    if (!impactWeight) return null;

    const w = IMPACT_WEIGHTS;

    // More enemies in the lobby means more targets to find kills/damage on, so both
    // are scaled down as enemyCount rises above the reference (and up below it) —
    // otherwise a big lobby would make combat points trivially easy to max out.
    const enemyCount = Math.max(stats.enemyCount, 1);
    const lobbyScale = w.combat.referenceEnemyCount / enemyCount;

    const killPoints = clamp(
        stats.kills * w.combat.pointsPerKill * lobbyScale,
        0,
        w.combat.maxKillPoints,
    );
    const damagePoints = clamp(
        (stats.damageDealt / w.combat.damagePerPoint) * lobbyScale,
        0,
        w.combat.maxDamagePoints,
    );
    const efficiencyRatio = stats.damageDealt / Math.max(stats.damageTaken, 1);
    const efficiencyPoints = clamp((efficiencyRatio - 1) * 6, 0, w.combat.maxEfficiencyPoints);
    const combatPoints = clamp(killPoints + damagePoints + efficiencyPoints, 0, w.combat.max);

    // Score as a share of the opportunities that actually existed this match. No
    // opportunities (nobody went down / needed saving) means nothing was missed, so
    // award full points rather than locking the player out of a max score.
    const revivePoints =
        stats.reviveOpportunities > 0
            ? clamp(
                  ((stats.revives + stats.covers) / stats.reviveOpportunities) *
                      w.support.maxRevivePoints,
                  0,
                  w.support.maxRevivePoints,
              )
            : w.support.maxRevivePoints;
    const savePoints =
        stats.saveOpportunities > 0
            ? clamp(
                  (stats.teammateSaves / stats.saveOpportunities) * w.support.maxSavePoints,
                  0,
                  w.support.maxSavePoints,
              )
            : w.support.maxSavePoints;
    const assistPoints = clamp(
        stats.assists * w.support.pointsPerAssist,
        0,
        w.support.maxAssistPoints,
    );
    const downPenalty = clamp(
        stats.timesDowned * w.support.pointsPerDown,
        0,
        w.support.maxDownPenalty,
    );
    const needSavePenalty = clamp(
        stats.timesNeededSaving * w.support.pointsPerNeedSave,
        0,
        w.support.maxNeedSavePenalty,
    );
    const supportPoints = clamp(
        revivePoints + savePoints + assistPoints - downPenalty - needSavePenalty,
        0,
        w.support.max,
    );

    const penaltyDetail = downPenalty || needSavePenalty
        ? ` (−${Math.round(downPenalty + needSavePenalty)} for ${stats.timesDowned} downs, ${stats.timesNeededSaving}x needed saving)`
        : "";

    const breakdown: ImpactBreakdown = {
        combat: {
            points: Math.round(combatPoints),
            max: w.combat.max,
            detail: `${stats.kills} kills, ${Math.round(stats.damageDealt)} dmg dealt (${Math.round(stats.damageTaken)} taken)`,
        },
        support: {
            points: Math.round(supportPoints),
            max: w.support.max,
            detail: `${stats.revives} revives${stats.covers ? ` (+${stats.covers} covering)` : ""}, ${stats.teammateSaves} saves, ${stats.assists} assists${penaltyDetail}`,
        },
    };

    const score = clamp(
        Math.round((combatPoints + supportPoints) * impactWeight),
        0,
        100,
    );

    return { score, breakdown };
}
