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
    teammateSaves: number;
    /** Times this player was downed this match (liability signal). */
    timesDowned: number;
    /** Times a teammate got credited a "save" for peeling an enemy off this player
     *  (see `teammateSaves` in player.ts) — a noisier liability signal than a down,
     *  since drawing fire on purpose (baiting/tanking) looks the same. */
    timesNeededSaving: number;
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
        damagePerPoint: 25,
        maxDamagePoints: 24,
        maxEfficiencyPoints: 12,
    },
    support: {
        max: 40,
        pointsPerRevive: 8,
        maxRevivePoints: 16,
        pointsPerSave: 4,
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

    const killPoints = clamp(stats.kills * w.combat.pointsPerKill, 0, w.combat.maxKillPoints);
    const damagePoints = clamp(
        stats.damageDealt / w.combat.damagePerPoint,
        0,
        w.combat.maxDamagePoints,
    );
    const efficiencyRatio = stats.damageDealt / Math.max(stats.damageTaken, 1);
    const efficiencyPoints = clamp((efficiencyRatio - 1) * 6, 0, w.combat.maxEfficiencyPoints);
    const combatPoints = clamp(killPoints + damagePoints + efficiencyPoints, 0, w.combat.max);

    const revivePoints = clamp(
        stats.revives * w.support.pointsPerRevive,
        0,
        w.support.maxRevivePoints,
    );
    const savePoints = clamp(
        stats.teammateSaves * w.support.pointsPerSave,
        0,
        w.support.maxSavePoints,
    );
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
            detail: `${stats.revives} revives, ${stats.teammateSaves} saves, ${stats.assists} assists${penaltyDetail}`,
        },
    };

    const score = clamp(
        Math.round((combatPoints + supportPoints) * impactWeight),
        0,
        100,
    );

    return { score, breakdown };
}
