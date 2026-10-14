import type { BulletDef } from "../../../shared/defs/gameObjects/bulletDefs";
import type { GunDef } from "../../../shared/defs/gameObjects/gunDefs";
import type { MeleeDef } from "../../../shared/defs/gameObjects/meleeDefs";
import { GameObjectDefs } from "../../../shared/defs/register";
import { type WeaponStatOverride, type WeaponStats, weaponSkinBase } from "../../../shared/defs/weaponStats";

/** Ammo in the clip goes over the network as a uint8. */
const MAX_CLIP = 255;
const MAX_BULLETS_PER_SECOND = 300;

/**
 * A game's weapon definitions with the lobby's stat changes applied. Weapon code asks
 * this instead of GameObjectDefs so the changes stay within the one game; weapons
 * without changes come back as the shared definitions themselves.
 */
export class GameWeaponStats {
    private cache = new Map<string, unknown>();
    private damageMults = new Map<string, number>();

    constructor(private overrides: WeaponStats = {}) {}

    get any() {
        return Object.keys(this.overrides).length > 0;
    }

    /** A skin uses its weapon's changes. */
    private overrideFor(type: string): WeaponStatOverride | undefined {
        if (this.overrides[type]) return this.overrides[type];
        const base = weaponSkinBase(type);
        return base ? this.overrides[base] : undefined;
    }

    /** The definition of any game object type, with this game's weapon stats. */
    def(type: string): ReturnType<typeof GameObjectDefs.typeToDefSafe> {
        if (!this.overrideFor(type)) return GameObjectDefs.typeToDefSafe(type);
        let hit = this.cache.get(type);
        if (!hit) {
            hit = this.build(type);
            this.cache.set(type, hit);
        }
        return hit as ReturnType<typeof GameObjectDefs.typeToDefSafe>;
    }

    /** Factor on a gun's bullet damage (bullets keep their type, so damage goes through damageMult). */
    damageMult(type: string): number {
        this.def(type);
        return this.damageMults.get(type) ?? 1;
    }

    private build(type: string): unknown {
        const base = GameObjectDefs.typeToDefSafe(type) as GunDef | MeleeDef | undefined;
        const o = this.overrideFor(type);
        if (!base || !o) return base;

        if (base.type === "melee") {
            return {
                ...base,
                damage: o.damage ?? base.damage,
                attack: { ...base.attack, cooldownTime: o.cooldown ?? base.attack.cooldownTime },
            } satisfies MeleeDef;
        }
        if (base.type !== "gun") return base;

        const gun: GunDef = { ...base };
        if (o.maxClip !== undefined) {
            // the extended (perk) clip and full-mag reloads grow along; shell-by-shell
            // reloads (maxReload smaller than the clip) stay as they are
            const ratio = o.maxClip / base.maxClip;
            gun.maxClip = o.maxClip;
            gun.extendedClip = Math.min(MAX_CLIP, Math.max(o.maxClip, Math.round(base.extendedClip * ratio)));
            if (base.maxReload >= base.maxClip) {
                gun.maxReload = gun.maxClip;
                gun.extendedReload = gun.extendedClip;
            }
        }
        if (o.reloadTime !== undefined) {
            if (base.reloadTimeAlt !== undefined) {
                gun.reloadTimeAlt = base.reloadTimeAlt * (o.reloadTime / base.reloadTime);
            }
            gun.reloadTime = o.reloadTime;
        }
        if (o.fireDelay !== undefined) gun.fireDelay = o.fireDelay;
        if (o.shotSpread !== undefined) gun.shotSpread = o.shotSpread;
        if (o.bulletCount !== undefined) gun.bulletCount = o.bulletCount;
        // keep the bullet count per second sane - 30 pellets every 0.02 s would bog the
        // game down; the stock guns stay far below this
        if (o.fireDelay !== undefined || o.bulletCount !== undefined) {
            gun.fireDelay = Math.max(gun.fireDelay, gun.bulletCount / MAX_BULLETS_PER_SECOND);
        }
        if (o.switchDelay !== undefined) gun.switchDelay = o.switchDelay;
        if (o.damage !== undefined) {
            const bulletDamage = (GameObjectDefs.typeToDefSafe(base.bulletType) as BulletDef | undefined)?.damage;
            if (bulletDamage) this.damageMults.set(type, o.damage / bulletDamage);
        }
        return gun;
    }
}
