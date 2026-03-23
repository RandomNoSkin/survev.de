console.log("[PLUGIN] lootPingNotification loaded");
import type { GamePlugin } from "../game/pluginManager";
import type { Player } from "../game/objects/player";
import { ObjectType } from "../../../shared/net/objectSerializeFns";
import { v2 } from "../../../shared/utils/v2";
import { collider } from "../../../shared/utils/collider";
import { GameObjectDefs } from "../../../shared/defs/gameObjectDefs";
// This whole plugin is for the loot ping showing up in the killfeed
// Helper: create a simple killfeed segment
function createSimpleSegment(text: string, color: string) {
    return { text, color };
}

export function attachLootPingNotification(
    plugin: GamePlugin,
    notifCooldown: number,
    maxPingToItemDist: number,
) {
    // key is player id, value is last time a successful item ping notif was sent by said player
    const lastItemPingNotif: Record<number, number> = {};
    plugin.on("pingDidOccur", (event) => {
        const { playerId, pos, type, isPing, itemType } = event.ping;
        if (type !== "ping_help") return;
        if (playerId === 0) return;
        if (!pos) return;
        const player = plugin.game.playerBarn.players.find(p => p.__id === playerId) as Player;
        if (!player) return;
        if (v2.distance(pos, player.pos) > player.zoom) return;
        const currentTime = player.timeAlive;
        if (currentTime - (lastItemPingNotif[playerId] || 0) < notifCooldown) return;

        const objs = plugin.game.grid
            .intersectCollider({
                type: collider.Type.Circle,
                pos,
                rad: maxPingToItemDist,
            })
            .filter(
                (obj: any) =>
                    obj.__type == ObjectType.Loot &&
                    (obj.layer === player.layer ||
                        obj.layer === 2 ||
                        player.layer === 2) &&
                    v2.distance(pos, obj.pos) < maxPingToItemDist
            );
        if (objs.length === 0) return;

        let minDist = 9999;
        let closestItemType = "";
        for (const obj of objs) {
            const d = v2.distance(obj.pos, pos);
            if (d < minDist) {
                minDist = d;
                // Prefer lootType or itemType, fallback to type
                closestItemType = (obj as any).lootType || (obj as any).itemType || (obj as any).type;
            }
        }

        if (!closestItemType) return;
        const itemDef = GameObjectDefs[closestItemType];
        const itemName = (itemDef && (itemDef as any).name) ? (itemDef as any).name : closestItemType;
        // Send loot ping notification to all players in the group
        for (const p of plugin.game.playerBarn.players) {
            if (p.groupId === player.groupId && p.socketId) {
                const notif = {
                    t: "lootPingNotification",
                    playerName: player.name,
                    itemName,
                };
                const encoded = new TextEncoder().encode(JSON.stringify(notif));
                plugin.game.sendSocketMsg(
                    p.socketId,
                    encoded
                );
            }
        }
        lastItemPingNotif[playerId] = currentTime;
    });
}

// Example plugin class for auto-registration
import { GamePlugin as BaseGamePlugin } from "../game/pluginManager";
export default class LootPingNotificationPlugin extends BaseGamePlugin {
    protected initListeners(): void {
        // Configurable detection radius for loot pings (configure the second digit)
        attachLootPingNotification(this, 0.5, 3);
    }
}
