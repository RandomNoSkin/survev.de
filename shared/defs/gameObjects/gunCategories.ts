import { type GunDef, GunDefs } from "./gunDefs";

/** How players think about guns; gun defs themselves only carry ammo / fire mode. */
export type GunCategory = "rifle" | "smg" | "shotgun" | "sniper" | "pistol" | "special";

export function gunCategory(type: string): GunCategory {
    const def = GunDefs[type] as GunDef & { pistol?: boolean; isLauncher?: boolean };
    const ammo = def.ammo as string;
    if (def.isLauncher || ["flare", "potato_ammo", "bugle_ammo"].includes(ammo)) return "special";
    if (def.pistol) return "pistol";
    if (ammo === "12gauge") return "shotgun";
    if (ammo === "9mm" || ammo === "45acp") {
        return def.fireMode === "single" && ammo === "45acp" ? "sniper" : "smg";
    }
    return def.fireMode === "single" ? "sniper" : "rifle";
}
