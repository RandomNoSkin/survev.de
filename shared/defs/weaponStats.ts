import type { BulletDef } from "./gameObjects/bulletDefs.ts";
import type { GunDef } from "./gameObjects/gunDefs.ts";
import type { MeleeDef } from "./gameObjects/meleeDefs.ts";
import { GameObjectDefs } from "./register.ts";

/**
 * Per-lobby weapon stat changes (Advanced Settings). Only stats the server alone
 * decides - bullet speed and range are simulated by the client too and stay as they are.
 * Unset fields keep the weapon's own value.
 */
export interface WeaponStatOverride {
    /** guns: damage per bullet; melee: damage per hit */
    damage?: number;
    /** guns: seconds between shots */
    fireDelay?: number;
    /** guns: magazine size */
    maxClip?: number;
    /** guns: seconds per reload */
    reloadTime?: number;
    /** guns: spread in degrees while standing */
    shotSpread?: number;
    /** guns: projectiles per shot (shotguns) */
    bulletCount?: number;
    /** guns: seconds before it can fire after switching to it */
    switchDelay?: number;
    /** melee: seconds between swings */
    cooldown?: number;
}

export type WeaponStats = Record<string, WeaponStatOverride>;

export type WeaponStatKey = keyof WeaponStatOverride;

/** Editable stats per weapon kind with their limits. */
export const WEAPON_STAT_FIELDS: Record<"gun" | "melee", Array<{ key: WeaponStatKey; label: string; min: number; max: number; step: number; unit?: string; int?: boolean }>> = {
    gun: [
        { key: "damage", label: "Damage", min: 0, max: 500, step: 1 },
        { key: "fireDelay", label: "Time between shots", min: 0.02, max: 5, step: 0.01, unit: "s" },
        // ammo in the clip goes over the network as a uint8
        { key: "maxClip", label: "Magazine size", min: 1, max: 255, step: 1, int: true },
        { key: "reloadTime", label: "Reload time", min: 0.1, max: 20, step: 0.05, unit: "s" },
        { key: "shotSpread", label: "Spread", min: 0, max: 60, step: 0.5, unit: "°" },
        { key: "bulletCount", label: "Bullets per shot", min: 1, max: 30, step: 1, int: true },
        { key: "switchDelay", label: "Switch delay", min: 0, max: 5, step: 0.05, unit: "s" },
    ],
    melee: [
        { key: "damage", label: "Damage", min: 0, max: 500, step: 1 },
        { key: "cooldown", label: "Time between swings", min: 0.05, max: 5, step: 0.01, unit: "s" },
    ],
};

export const WEAPON_STATS_MAX_WEAPONS = 200;
export const WEAPON_STATS_NAME_MAX_LEN = 24;
/** saved profiles per player */
export const WEAPON_STATS_MAX_PROFILES = 20;

/** A saved, named set of weapon stat changes (kept in the player's config). */
export interface WeaponStatsProfile {
    name: string;
    stats: WeaponStats;
}

export function validateWeaponStatsProfile(input: unknown): WeaponStatsProfile {
    const src = (input && typeof input === "object" ? input : {}) as Partial<WeaponStatsProfile>;
    const name = typeof src.name === "string" ? src.name.trim().slice(0, WEAPON_STATS_NAME_MAX_LEN) : "";
    return { name: name || "Weapon stats", stats: validateWeaponStats(src.stats) };
}

const weaponNameOf = (type: string) => (GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined)?.name;

let skinBases: Map<string, string> | undefined;
/**
 * Pure skins share their weapon's name and type ("awc" -> "awc_winter"); they have no
 * stats of their own here, the weapon's changes apply to them.
 */
export function weaponSkinBase(type: string): string | undefined {
    if (!skinBases) {
        skinBases = new Map();
        const weapons = GameObjectDefs.getAllTypes().filter((t) => weaponKind(t));
        // a gun's alt-fire mode (the [+] grenade launchers) is named like it but has its own stats
        const altModes = new Set(weapons.map((t) => (GameObjectDefs.typeToDefSafe(t) as { secondAmmo?: string }).secondAmmo));
        for (const t of weapons) {
            if (altModes.has(t)) continue;
            const base = weapons.find((b) => b !== t && t.startsWith(`${b}_`) && weaponNameOf(b) === weaponNameOf(t));
            if (base) skinBases.set(t, base);
        }
    }
    return skinBases.get(type);
}

/** The skins of a weapon (they follow its stat changes). */
export function weaponSkins(type: string): string[] {
    weaponSkinBase(type);
    return [...skinBases!.entries()].filter(([, base]) => base === type).map(([skin]) => skin);
}

/** "awc_winter" -> "Winter skin" */
export function skinLabel(skin: string, base: string): string {
    const suffix = skin.slice(base.length + 1).replace(/_/g, " ");
    return `${suffix.charAt(0).toUpperCase()}${suffix.slice(1)} skin`;
}

/** Same-named weapons that are their own thing. */
const VARIANT_LABELS: Record<string, string> = {
    special_shotgun: "Special edition (5 pellets, ultra-rare drop)",
};

/**
 * Tells weapons with the same name apart: an alt-fire mode of another gun (the [+]
 * launchers' grenade mode), else the internal type.
 */
export function weaponVariantLabel(type: string): string | undefined {
    const name = weaponNameOf(type);
    const all = GameObjectDefs.getAllTypes().filter((t) => weaponKind(t) && !weaponSkinBase(t));
    const twins = all.filter((t) => weaponNameOf(t) === name);
    if (twins.length < 2) return undefined;
    if (VARIANT_LABELS[type]) return VARIANT_LABELS[type];
    // the plain weapon next to a labelled special one needs no label
    if (twins.some((t) => t !== type && VARIANT_LABELS[t])) return undefined;
    // the [+] guns and their grenade mode point at each other; the mode is "<gun>_..."
    const altOf = (t: string) => (GameObjectDefs.typeToDefSafe(t) as { secondAmmo?: string }).secondAmmo;
    const owner = all.find((t) => t !== type && type.startsWith(`${t}_`) && altOf(t) === type);
    if (owner) return "Grenade mode (alt fire)";
    const alt = altOf(type);
    if (alt?.startsWith(`${type}_`)) return "Normal fire";
    return `variant: ${type}`;
}

export function weaponKind(type: string): "gun" | "melee" | undefined {
    const t = (GameObjectDefs.typeToDefSafe(type) as { type?: string } | undefined)?.type;
    return t === "gun" || t === "melee" ? t : undefined;
}

/** The weapon's own value of a stat (what an unset field means). */
export function baseWeaponStat(type: string, key: WeaponStatKey): number | undefined {
    const def = GameObjectDefs.typeToDefSafe(type) as (GunDef | MeleeDef) | undefined;
    if (!def) return undefined;
    if (def.type === "melee") {
        if (key === "damage") return def.damage;
        if (key === "cooldown") return def.attack.cooldownTime;
        return undefined;
    }
    if (def.type !== "gun") return undefined;
    if (key === "damage") {
        return (GameObjectDefs.typeToDefSafe(def.bulletType) as BulletDef | undefined)?.damage;
    }
    if (key === "cooldown") return undefined;
    return def[key];
}

/** Clamps everything into the limits and drops what isn't a gun/melee stat; safe on untrusted input. */
export function validateWeaponStats(input: unknown): WeaponStats {
    const out: WeaponStats = {};
    if (!input || typeof input !== "object") return out;
    for (const [type, raw] of Object.entries(input as Record<string, unknown>).slice(0, WEAPON_STATS_MAX_WEAPONS)) {
        const kind = weaponKind(type);
        // skins follow their weapon, they have no entry of their own
        if (!kind || weaponSkinBase(type) || !raw || typeof raw !== "object") continue;
        const override: WeaponStatOverride = {};
        for (const f of WEAPON_STAT_FIELDS[kind]) {
            const v = (raw as Record<string, unknown>)[f.key];
            if (typeof v !== "number" || !Number.isFinite(v)) continue;
            const clamped = Math.min(f.max, Math.max(f.min, v));
            override[f.key] = f.int ? Math.round(clamped) : Math.round(clamped * 1000) / 1000;
        }
        if (Object.keys(override).length) out[type] = override;
    }
    return out;
}
