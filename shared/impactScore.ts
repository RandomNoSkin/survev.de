/**
 * "Impact score" for team-mode matches (Duo/Squad): a transparent, category-based
 * rating of a player's contribution beyond raw kills/damage, covering combat output
 * (kills, assists, damage) and reviving teammates.
 *
 * Gated per-map via `MapDef.gameMode.impactWeight` (0 = disabled, see mapDefs.ts) so
 * arena/comp modes with different rulesets aren't scored unless explicitly opted in.
 */

export interface ImpactStats {
    kills: number;
    assists: number;
    damageDealt: number;
    damageTaken: number;
    revives: number;
    /** Times this player was covering (nearby + actively fighting) when a teammate
     *  completed a revive — counted the same as a revive in the share below, since
     *  holding an angle while someone revives is just as valuable as reviving. */
    covers: number;
    /** Enemies this player damaged while that enemy was actively damaging a teammate
     *  (peel/save). Pure bonus, no penalty counterpart — landing a save takes a lucky
     *  angle/timing that not everyone gets, so missing one isn't held against anyone,
     *  unlike a missed revive where just standing nearby is enough. */
    teammateSaves: number;
    /** Total kills + assists by this player's own team (self included). Kill/assist
     *  points are this player's share of that total — being credited with half of
     *  your team's combined kills+assists earns full marks, so raw count alone isn't
     *  comparable across matches with different lobby sizes or teammates who carried
     *  more or less. Assists count the same as kills here since kill credit always
     *  goes to whoever lands the down, not whoever did the damage. */
    teamKillsAndAssists: number;
    /** Total damage dealt by this player's own team (self included). Damage points
     *  are this player's share of that total, the damage equivalent of
     *  teamKillsAndAssists. */
    teamDamageDealt: number;
    /** Total revives + covers by this player's own team (self included). Revive
     *  points are this player's share of that total. */
    teamReviveContribution: number;
    /** Total teammateSaves by this player's own team (self included). Save points are
     *  this player's share of that total — the save equivalent of
     *  teamReviveContribution, but bonus-only (see teammateSaves). */
    teamSaves: number;
    /** Times this player was within actual response range when a teammate went down
     *  and that teammate was later revived, but this player neither performed the
     *  revive nor got cover credit for it — i.e. they were in a position to help and
     *  did nothing. The only liability signal left in this category; going down
     *  yourself, or needing a save, isn't penalized on its own. See
     *  `nearbyRespondingTeammates` in player.ts. */
    missedRevives: number;
    /** Whether this player died this match. Gates the teamReviveContribution==0
     *  fallback below: a survivor whose team never needed a revive genuinely had
     *  nothing to do and shouldn't be penalized for it, but a player who died
     *  (especially early, having done nothing) had their shot and didn't take it — no
     *  free pass just because the match never got that far for them. */
    died: boolean;
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
        max: 80,
        maxKillAssistPoints: 36,
        // Fraction of the team's combined kills+assists a player must be responsible
        // for to earn full kill/assist points (see teamKillsAndAssists).
        targetKillAssistShare: 0.5,
        maxDamagePoints: 32,
        // Fraction of their own team's total damage output (see teamDamageDealt) a
        // player must be responsible for to earn full damage points.
        targetDamageShare: 0.5,
        maxEfficiencyPoints: 12,
    },
    support: {
        max: 28,
        maxRevivePoints: 20,
        // Fraction of the team's combined revives+covers a player must be
        // responsible for to earn full revive points (see teamReviveContribution).
        targetReviveShare: 0.5,
        // Penalty for being in position to help a revive and doing neither — see
        // missedRevives.
        pointsPerMissedRevive: 5,
        maxMissedRevivePenalty: 20,
        maxSavePoints: 8,
        // Fraction of the team's combined teammateSaves a player must be responsible
        // for to earn full save points (see teamSaves).
        targetSaveShare: 0.5,
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

    // Combat is scored as this player's share of their own team's output (kills+
    // assists, damage), not a flat rate — so it's comparable across matches with
    // different lobby sizes or teammates who carried more or less. A team with zero
    // of a stat means everyone (including this player) also has zero of it, so the
    // share is naturally 0 with no special-casing needed.
    const teamKillsAndAssists = Math.max(stats.teamKillsAndAssists, 1);
    const killAssistPoints = clamp(
        ((stats.kills + stats.assists) /
            (teamKillsAndAssists * w.combat.targetKillAssistShare)) *
            w.combat.maxKillAssistPoints,
        0,
        w.combat.maxKillAssistPoints,
    );
    const teamDamageDealt = Math.max(stats.teamDamageDealt, 1);
    const damagePoints = clamp(
        (stats.damageDealt / (teamDamageDealt * w.combat.targetDamageShare)) *
            w.combat.maxDamagePoints,
        0,
        w.combat.maxDamagePoints,
    );
    const efficiencyRatio = stats.damageDealt / Math.max(stats.damageTaken, 1);
    const efficiencyPoints = clamp((efficiencyRatio - 1) * 6, 0, w.combat.maxEfficiencyPoints);
    const combatPoints = clamp(
        killAssistPoints + damagePoints + efficiencyPoints,
        0,
        w.combat.max,
    );

    // Revive points: share of the team's combined revives+covers. No team revive
    // activity at all means nothing was there to convert, so award full points to
    // survivors (see died doc above) rather than penalizing a quiet match.
    const revivePoints =
        stats.teamReviveContribution > 0
            ? clamp(
                  ((stats.revives + stats.covers) /
                      (stats.teamReviveContribution * w.support.targetReviveShare)) *
                      w.support.maxRevivePoints,
                  0,
                  w.support.maxRevivePoints,
              )
            : stats.died
              ? 0
              : w.support.maxRevivePoints;
    const missedRevivePenalty = clamp(
        stats.missedRevives * w.support.pointsPerMissedRevive,
        0,
        w.support.maxMissedRevivePenalty,
    );
    // Save points: pure bonus, share of the team's combined saves. No fallback for a
    // team with zero saves — unlike revives there's no penalty to be fair about here,
    // so "nobody saved anyone" just contributes nothing, same as it would for a save
    // share of 0 either way.
    const teamSaves = Math.max(stats.teamSaves, 1);
    const savePoints =
        stats.teamSaves > 0
            ? clamp(
                  (stats.teammateSaves / (teamSaves * w.support.targetSaveShare)) *
                      w.support.maxSavePoints,
                  0,
                  w.support.maxSavePoints,
              )
            : 0;
    const supportPoints = clamp(
        revivePoints + savePoints - missedRevivePenalty,
        0,
        w.support.max,
    );

    const missedDetail = stats.missedRevives
        ? ` (−${Math.round(missedRevivePenalty)} for ${stats.missedRevives}x not helping a nearby revive)`
        : "";

    const breakdown: ImpactBreakdown = {
        combat: {
            points: Math.round(combatPoints),
            max: w.combat.max,
            detail: `${stats.kills} kills, ${stats.assists} assists, ${Math.round(stats.damageDealt)} dmg dealt (${Math.round(stats.damageTaken)} taken)`,
        },
        support: {
            points: Math.round(supportPoints),
            max: w.support.max,
            detail: `${stats.revives} revives${stats.covers ? ` (+${stats.covers} covering)` : ""}${stats.teammateSaves ? `, ${stats.teammateSaves} saves` : ""}${missedDetail}`,
        },
    };

    const score = clamp(
        Math.round((combatPoints + supportPoints) * impactWeight),
        0,
        100,
    );

    return { score, breakdown };
}
