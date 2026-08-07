/**
 * "Impact score" for team-mode matches (Duo/Squad): a transparent, category-based
 * rating of a player's contribution beyond raw kills/damage, covering combat output
 * (kills, assists, damage) and reviving teammates.
 *
 * Gated per-map via `MapDef.gameMode.impactWeight` (0 = disabled, see mapDefs.ts) so
 * arena/comp modes with different rulesets aren't scored unless explicitly opted in.
 */

export interface ImpactStats {
    /** Raw kill count — display only. Scoring uses weightedKills instead. */
    kills: number;
    /** Kills weighted by how outnumbered this player's team was at the moment of each
     *  knock (1x team had the advantage, 1.5x even, 2x team was outnumbered) — see
     *  `pendingKillWeight` in player.ts. Used instead of `kills` in the kill/assist
     *  share below, so a clutch kill while outnumbered counts for more than a mop-up
     *  kill while already ahead. */
    weightedKills: number;
    assists: number;
    damageDealt: number;
    damageTaken: number;
    revives: number;
    /** Times this player was covering (nearby + actively fighting) when a teammate
     *  completed a revive — counted the same as a revive in the share below, since
     *  holding an angle while someone revives is just as valuable as reviving. */
    covers: number;
    /** Enemies this player damaged while that enemy was actively damaging a teammate
     *  who was below half health (peel/save). Pure bonus, no penalty counterpart —
     *  landing a save takes a lucky angle/timing that not everyone gets, so missing
     *  one isn't held against anyone, unlike a missed revive where just standing
     *  nearby is enough. */
    teammateSaves: number;
    /** Number of players on this player's own team (self included). Every share
     *  target below (kills+assists, damage, revives+covers, saves) is relative to
     *  1/teamSize — an even split — not a fixed fraction, so a duo player and a
     *  squad player need the same *relative* level of over-performance to max a
     *  category, instead of a flat 50% share that's trivial in duos (an even 2-way
     *  split already hits it) and unreachable by an average player in squads (an
     *  even 4-way split is only 25%). */
    teamSize: number;
    /** Total weightedKills + assists by this player's own team (self included).
     *  Kill/assist points are this player's share of that total — being credited
     *  with half of your team's combined weighted-kills+assists earns full marks, so
     *  raw count alone isn't comparable across matches with different lobby sizes or
     *  teammates who carried more or less. Assists count the same as an unweighted
     *  kill here since kill credit always goes to whoever lands the down, not
     *  whoever did the damage. */
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
     *  did nothing. See `nearbyRespondingTeammates` in player.ts. */
    missedRevives: number;
    /** Points lost this match for being knocked and/or killed, weighted by how
     *  outnumbered this player's own team was at each moment (see `lossPenalty` in
     *  player.ts) — losing a fight your team should have been winning costs more
     *  than one you were already outnumbered in. Deducted straight from combat. */
    lossPenalty: number;
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
    // Every share category's target is relativeShareTarget/teamSize — this many times
    // an even split earns full points, for kills+assists, damage, revives+covers, and
    // saves alike. 1.5 is a first guess: an even 4-way squad split (25% each) lands at
    // share/target = 0.25/0.375 = 67% of that category's points, and reaching 1.5x
    // your fair share (37.5% in a squad, 75% in a duo) maxes it out. Revisit if this
    // still clusters scores too tightly or spreads them too wide in practice.
    relativeShareTarget: 1.5,
    // Combat is the whole 0-100 scale, and can reach all 100 on its own — kills/
    // assists/damage/efficiency sub-maxes already sum to 100 (45+40+15) at exactly
    // their target share. Support (revive+save, below) only backfills whatever combat
    // *didn't* fill; it never adds separate headroom on top.
    combat: {
        max: 100,
        maxKillAssistPoints: 45,
        // Weighted kills+assists needed for the share above to count at full
        // strength — below this it scales down proportionally. Without this, being
        // your team's *only* kill (common on a team that barely fought) is a trivial
        // 100% share and blows straight past maxKillAssistPoints via the overflow
        // above, even though 1 kill is 1 kill in absolute terms.
        killAssistVolumeThreshold: 3,
        maxDamagePoints: 40,
        // Same idea as killAssistVolumeThreshold, for damage share.
        damageVolumeThreshold: 200,
        maxEfficiencyPoints: 15,
        // Dealt/taken ratio for full efficiency points. Unlike the share categories
        // above, efficiency is hard-capped here (no growth past this ratio) — it's a
        // secondary signal, not something that should be able to dominate the score.
        targetEfficiencyRatio: 2,
        // Damage dealt needed for the ratio above to count at full strength — below
        // this it scales down proportionally, so winning one or two small skirmishes
        // by a good margin doesn't earn the same efficiency credit as sustaining a
        // good ratio across real volume. A player who barely fought shouldn't get a
        // maxed-out "good fighter" signal off a tiny sample.
        efficiencyVolumeThreshold: 100,
    },
    // Support only ever fills the gap combat left under combat.max — see
    // computeImpactScore. Its own max here just bounds display, not a separate slice
    // of the final score.
    support: {
        max: 20,
        maxRevivePoints: 8,
        // Penalty for being in position to help a revive and doing neither — see
        // missedRevives. Capped at maxRevivePoints so a bad revive-response streak
        // can only zero out the revive points, not the save points.
        pointsPerMissedRevive: 4,
        maxMissedRevivePenalty: 8,
        // Same weight as revives — landing a save is harder/more opportunistic, but
        // not so much that it should outweigh actually reviving a teammate.
        maxSavePoints: 8,
    },
} as const;

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/**
 * Points for a share (numerator/denominator) of a pool, uncapped past `target` — no
 * individual category has its own hard ceiling. Reaching `target` share earns
 * `maxPoints` exactly (e.g. half your team's kills+assists = full kill/assist
 * points); every share point beyond that keeps adding more at the same `maxPoints`-
 * per-100%-share rate, so one category dominating (e.g. 90% of the team's damage
 * with 0 kills) can still carry the score well past what that category's "max" would
 * otherwise suggest. The real ceiling is the overall combat.max clamp applied once
 * everything's summed, not this function.
 */
function shareScore(
    numerator: number,
    denominator: number,
    target: number,
    maxPoints: number,
): number {
    const share = numerator / Math.max(denominator, 1);
    if (share <= target) {
        return (share / target) * maxPoints;
    }
    return maxPoints + (share - target) * maxPoints;
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

    // Every share category targets this many times an even split (1/teamSize) — see
    // relativeShareTarget doc above.
    const targetShare = w.relativeShareTarget / Math.max(stats.teamSize, 1);

    // Combat is scored as this player's share of their own team's output (kills+
    // assists, damage), not a flat rate — so it's comparable across matches with
    // different lobby sizes or teammates who carried more or less. A team with zero
    // of a stat means everyone (including this player) also has zero of it, so the
    // share is naturally 0 with no special-casing needed.
    const killAssistVolume = Math.min(
        (stats.weightedKills + stats.assists) / w.combat.killAssistVolumeThreshold,
        1,
    );
    const killAssistPoints =
        Math.max(
            shareScore(
                stats.weightedKills + stats.assists,
                stats.teamKillsAndAssists,
                targetShare,
                w.combat.maxKillAssistPoints,
            ),
            0,
        ) * killAssistVolume;
    const damageVolume = Math.min(
        stats.damageDealt / w.combat.damageVolumeThreshold,
        1,
    );
    const damagePoints =
        Math.max(
            shareScore(
                stats.damageDealt,
                stats.teamDamageDealt,
                targetShare,
                w.combat.maxDamagePoints,
            ),
            0,
        ) * damageVolume;
    const efficiencyRatio = stats.damageDealt / Math.max(stats.damageTaken, 1);
    const efficiencyRate =
        w.combat.maxEfficiencyPoints / (w.combat.targetEfficiencyRatio - 1);
    const efficiencyVolume = Math.min(
        stats.damageDealt / w.combat.efficiencyVolumeThreshold,
        1,
    );
    const efficiencyPoints =
        clamp((efficiencyRatio - 1) * efficiencyRate, 0, w.combat.maxEfficiencyPoints) *
        efficiencyVolume;
    // Kill/assist and damage have no per-category cap — a player can carry combat
    // through either one of those alone. Efficiency does stay hard-capped (above).
    // lossPenalty (getting knocked/killed) comes straight off combat, not support.
    // The overall ceiling (combat.max) is applied once, below, after summing.
    const combatPointsRaw =
        killAssistPoints + damagePoints + efficiencyPoints - stats.lossPenalty;
    const combatPoints = clamp(combatPointsRaw, 0, w.combat.max);

    // Revive points: share of the team's combined revives+covers. Revive points
    // aren't required to reach combat.max (100) on their own, so there's no fairness
    // case for a fallback here — no team revive activity just means 0, same as any
    // other empty share.
    const revivePoints =
        stats.teamReviveContribution > 0
            ? Math.max(
                  shareScore(
                      stats.revives + stats.covers,
                      stats.teamReviveContribution,
                      targetShare,
                      w.support.maxRevivePoints,
                  ),
                  0,
              )
            : 0;
    const missedRevivePenalty = clamp(
        stats.missedRevives * w.support.pointsPerMissedRevive,
        0,
        w.support.maxMissedRevivePenalty,
    );
    // Save points: pure bonus, share of the team's combined saves, hard-capped at
    // maxSavePoints (no overflow past targetShare, unlike the other categories). No
    // fallback for a team with zero saves — unlike revives there's no penalty to be
    // fair about here, so "nobody saved anyone" just contributes nothing, same as it
    // would for a save share of 0 either way.
    const savePoints =
        stats.teamSaves > 0
            ? clamp(
                  shareScore(
                      stats.teammateSaves,
                      stats.teamSaves,
                      targetShare,
                      w.support.maxSavePoints,
                  ),
                  0,
                  w.support.maxSavePoints,
              )
            : 0;
    // What this player earned from revive/save, independent of whether combat left
    // any room for it — shown as-is in the breakdown; the final score clamp below is
    // what actually enforces "only counts if combat isn't already full".
    const supportPoints = clamp(
        revivePoints + savePoints - missedRevivePenalty,
        0,
        w.support.max,
    );

    const missedDetail = stats.missedRevives
        ? ` (−${Math.round(missedRevivePenalty)} for ${stats.missedRevives}x not helping a nearby revive)`
        : "";
    const lossDetail = stats.lossPenalty
        ? ` (−${Math.round(stats.lossPenalty)} for being knocked/killed)`
        : "";

    const breakdown: ImpactBreakdown = {
        combat: {
            points: Math.round(combatPoints),
            max: w.combat.max,
            detail: `${stats.kills} kills, ${stats.assists} assists, ${Math.round(stats.damageDealt)} dmg dealt (${Math.round(stats.damageTaken)} taken)${lossDetail}`,
        },
        support: {
            points: Math.round(supportPoints),
            max: w.support.max,
            detail: `${stats.revives} revives${stats.covers ? ` (+${stats.covers} covering)` : ""}${stats.teammateSaves ? `, ${stats.teammateSaves} saves` : ""}${missedDetail}`,
        },
    };

    // Support only ever backfills the gap combat left under combat.max — never adds
    // separate headroom on top of a combat performance that already maxed it out.
    const score = clamp(
        Math.round((combatPoints + supportPoints) * impactWeight),
        0,
        w.combat.max,
    );

    return { score, breakdown };
}
