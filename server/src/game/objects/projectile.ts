import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import type { ThrowableDef } from "../../../../shared/defs/gameObjects/throwableDefs";
import { DamageType, GameConfig, type InventoryItem } from "../../../../shared/gameConfig";
import * as net from "../../../../shared/net/net";
import { ObjectType } from "../../../../shared/net/objectSerializeFns";
import { type AABB, coldet } from "../../../../shared/utils/coldet";
import { collider } from "../../../../shared/utils/collider";
import { math } from "../../../../shared/utils/math";
import { util } from "../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../shared/utils/v2";
import type { Game } from "../game";
import { BaseGameObject } from "./gameObject";

// 10.5 is based on the distance a potato cannon projectile traveled before hitting the floor
// and exploding, from recorded packets from the original game
const gravity = 10.5;

export class ProjectileBarn {
    projectiles: Projectile[] = [];
    constructor(readonly game: Game) {}

    update(dt: number) {
        for (let i = 0; i < this.projectiles.length; i++) {
            const proj = this.projectiles[i];
            if (proj.destroyed) {
                this.projectiles.splice(i, 1);
                i--;
                continue;
            }
            proj.update(dt);
        }
    }

    addProjectile(
        playerId: number,
        type: string,
        pos: Vec2,
        posZ: number,
        layer: number,
        vel: Vec2,
        fuseTime: number,
        damageType: DamageType,
        throwDir?: Vec2,
        weaponSourceType?: string,
        damageMultiplier?: number,
    ): Projectile {
        const proj = new Projectile(
            this.game,
            type,
            pos,
            layer,
            posZ,
            playerId,
            vel,
            fuseTime,
            damageType,
            throwDir,
            weaponSourceType,
            damageMultiplier,
        );

        this.projectiles.push(proj);
        this.game.objectRegister.register(proj);
        return proj;
    }
}

export class Projectile extends BaseGameObject {
    override readonly __type = ObjectType.Projectile;
    bounds: AABB;

    layer: number;

    posZ: number;
    dir: Vec2;
    throwDir: Vec2;

    type: string;
    // used for "heavy" potatos and snowballs
    // so the kill source is still the regular potato
    weaponSourceType: string;
    damageMultiplier: number;

    rad: number;

    playerId: number;
    fuseTime: number;
    damageType: DamageType;

    vel: Vec2;
    velZ: number;
    dead = false;

    obstacleBellowId = 0;

    // proximity mine state (see ThrowableDef.proximityMine)
    mineArmTimer = 0;
    mineArmed = false;
    // networked so the client can blink faster once the mine has been tripped
    mineTriggered = false;
    mineTriggerTimer = 0;
    // mines can't be placed inside another mine's detection radius
    minePlacementChecked = false;

    strobe?: {
        timeToPing: number;
        airstrikesTotal: number;
        airstrikesLeft: number;
        airstrikeTicker: number;
        airstrikeDelay: number;
        airstrikeOffset: number;
        rotAngle: number;
    };

    constructor(
        game: Game,
        type: string,
        pos: Vec2,
        layer: number,
        posZ: number,
        playerId: number,
        vel: Vec2,
        fuseTime: number,
        damageType: DamageType,
        throwDir?: Vec2,
        weaponSourceType?: string,
        damageMultiplier?: number,
    ) {
        super(game, pos);
        this.layer = layer;
        this.type = type;
        this.posZ = posZ;
        this.playerId = playerId;
        this.vel = vel;
        this.fuseTime = fuseTime;
        this.damageType = damageType;
        this.dir = v2.normalizeSafe(vel);
        this.throwDir = throwDir ?? v2.copy(this.dir);
        this.weaponSourceType = weaponSourceType || this.type;
        this.damageMultiplier = damageMultiplier || 1;
        const def = GameObjectDefs.typeToDefSafe(type) as ThrowableDef;
        this.velZ = def.throwPhysics.velZ;
        this.rad = def.rad * 0.5;
        this.bounds = collider.createAabbExtents(
            v2.create(0, 0),
            v2.create(this.rad, this.rad),
        );
    }

    updateStrobe(dt: number): void {
        if (!this.strobe) return;

        if (this.strobe.timeToPing > 0) {
            this.strobe.timeToPing -= dt;

            if (this.strobe.timeToPing <= 0) {
                this.game.playerBarn.addMapPing("ping_airstrike", this.pos);
                this.strobe.airstrikeTicker = 1;
            }
        }

        if (this.strobe.airstrikesLeft == 0) return;

        // airstrikes cannot drop until the strobe ticker is finished
        if (this.strobe.timeToPing >= 0) return;

        if (this.strobe.airstrikeTicker > 0) {
            this.strobe.airstrikeTicker -= dt;

            if (this.strobe.airstrikeTicker <= 0) {
                let rotAngle = this.strobe.rotAngle;
                if (this.strobe.airstrikesLeft % 2) {
                    rotAngle *= -1;
                }
                const nextDir = v2.rotate(this.throwDir, rotAngle);
                const newOffset =
                    Math.ceil(
                        (this.strobe.airstrikesTotal - this.strobe.airstrikesLeft) / 2,
                    ) * this.strobe.airstrikeOffset;
                const pos = v2.add(this.pos, v2.mul(nextDir, newOffset));
                this.game.planeBarn.addAirStrike(pos, this.throwDir, this.playerId);
                this.strobe.airstrikesLeft--;
                this.strobe.airstrikeTicker = this.strobe.airstrikeDelay;
            }
        }
    }

    updateMine(dt: number): void {
        const def = GameObjectDefs.typeToDefSafe(this.type) as ThrowableDef;
        if (!def.proximityMine) return;

        // once it has landed, plant it firmly so it doesn't slide on the ground
        if (this.posZ <= 0) {
            this.vel = v2.create(0, 0);
            // reject placement if it landed inside another mine's detection radius
            if (!this.minePlacementChecked) {
                this.minePlacementChecked = true;
                if (this.rejectMineIfOverlapping(def.proximityMine.triggerRad)) {
                    return;
                }
            }
        }

        // once tripped, count down before detonating (committed even if the
        // enemy walks back out of range)
        if (this.mineTriggered) {
            this.mineTriggerTimer += dt;
            if (this.mineTriggerTimer >= def.proximityMine.triggerDelay) {
                this.explode();
            }
            return;
        }

        // only start arming once the mine has settled on the ground
        if (this.posZ > 0) return;

        if (!this.mineArmed) {
            this.mineArmTimer += dt;
            if (this.mineArmTimer >= def.proximityMine.armTime) {
                this.mineArmed = true;
            }
            return;
        }

        // armed: trip when ANY player enters the trigger radius
        // (the thrower and their teammates included, by design)
        const triggerRad = def.proximityMine.triggerRad;
        const objs = this.game.grid.intersectCollider(
            collider.createCircle(this.pos, triggerRad),
        );
        for (const obj of objs) {
            if (
                obj.__type !== ObjectType.Player ||
                obj.dead ||
                !util.sameLayer(this.layer, obj.layer)
            ) {
                continue;
            }
            if (coldet.testCircleCircle(this.pos, triggerRad, obj.pos, obj.rad)) {
                this.triggerMine();
                return;
            }
        }
    }

    /**
     * Mines can't be placed inside another mine's detection radius. If this mine
     * landed too close to an existing one, refund it to the thrower, notify them,
     * and remove it. Returns true if the mine was rejected.
     */
    rejectMineIfOverlapping(radius: number): boolean {
        const objs = this.game.grid.intersectCollider(
            collider.createCircle(this.pos, radius),
        );
        for (const obj of objs) {
            if (obj.__type !== ObjectType.Projectile) continue;
            if (obj.__id === this.__id || obj.dead) continue;
            const otherDef = GameObjectDefs.typeToDefSafe(obj.type) as ThrowableDef;
            if (!otherDef.proximityMine) continue;
            if (v2.distance(this.pos, obj.pos) > radius) continue;

            // give the mine back to the thrower and tell them why
            const owner = this.game.objectRegister.getById(this.playerId);
            if (owner?.__type === ObjectType.Player) {
                owner.invManager.give(this.weaponSourceType as InventoryItem, 1);
                const msg = new net.PickupMsg();
                msg.type = net.PickupMsgType.AlreadyMined;
                msg.item = this.weaponSourceType;
                owner.msgsToSend.push({ type: net.MsgType.Pickup, msg });
            }
            this.dead = true;
            this.destroy();
            return true;
        }
        return false;
    }

    /** Trip an armed proximity mine; also called when a bullet hits it. */
    triggerMine(): void {
        if (this.mineTriggered) return;
        this.mineTriggered = true;
        this.mineTriggerTimer = 0;
        this.setPartDirty();
    }

    update(dt: number) {
        if (this.strobe) {
            this.updateStrobe(dt);
        }

        const def = GameObjectDefs.typeToDefSafe(this.type) as ThrowableDef;
        //
        // Velocity
        //
        if (!def.forceMaxThrowDistance) {
            // velocity needs to stay constant to reach max throw dist
            this.vel = v2.mul(this.vel, 1 / (1 + dt * (this.posZ != 0 ? 1.2 : 2)));
        }
        const posOld = v2.copy(this.pos);
        this.pos = v2.add(this.pos, v2.mul(this.vel, dt));

        //
        // Height / posZ
        //
        this.velZ -= gravity * dt;
        this.posZ += this.velZ * dt;
        this.posZ = math.clamp(this.posZ, 0, GameConfig.projectile.maxHeight);
        let height = this.posZ;
        if (def.throwPhysics.fixedCollisionHeight) {
            height = def.throwPhysics.fixedCollisionHeight;
        }

        //
        // Collision and changing layers on stair
        //
        const objs = this.game.grid.intersectGameObject(this);

        for (const obj of objs) {
            if (
                obj.__type === ObjectType.Obstacle &&
                util.sameLayer(this.layer, obj.layer) &&
                !obj.dead
            ) {
                const intersection = collider.intersectCircle(
                    obj.collider,
                    this.pos,
                    this.rad,
                );
                const lineIntersection = collider.intersectSegment(
                    obj.collider,
                    posOld,
                    this.pos,
                );

                if (intersection || lineIntersection) {
                    if (obj.height >= height && obj.__id !== this.obstacleBellowId) {
                        let damage = 1;
                        if (def.destroyNonCollidables && !obj.collidable) {
                            damage = 999;
                        }

                        obj.damage({
                            amount: damage,
                            damageType: this.damageType,
                            gameSourceType: this.type,
                            weaponSourceType: this.weaponSourceType,
                            source: this.game.objectRegister.getById(this.playerId),
                            mapSourceType: "",
                            dir: this.dir,
                        });

                        if (obj.dead || !obj.collidable) continue;

                        if (lineIntersection) {
                            this.pos = v2.add(
                                lineIntersection.point,
                                v2.mul(lineIntersection.normal, this.rad + 0.1),
                            );
                        } else if (intersection) {
                            this.pos = v2.add(
                                this.pos,
                                v2.mul(intersection.dir, intersection.pen + 0.1),
                            );
                        }

                        if (def.explodeOnImpact) {
                            this.explode();
                        } else {
                            const len = math.max(v2.length(this.vel), 0.000001);
                            const dir = v2.div(this.vel, len);
                            const normal = intersection
                                ? intersection.dir
                                : lineIntersection!.normal;
                            const dot = v2.dot(dir, normal);
                            const newDir = v2.add(v2.mul(normal, dot * -2), dir);
                            this.vel = v2.mul(newDir, len * 0.3);
                            this.dir = v2.normalizeSafe(this.vel);
                        }
                    } else if (obj.collidable) {
                        this.obstacleBellowId = obj.__id;
                    }
                }
            } else if (
                obj.__type === ObjectType.Player &&
                def.playerCollision &&
                !obj.dead &&
                util.sameLayer(this.layer, obj.layer) &&
                obj.__id !== this.playerId
            ) {
                if (coldet.testCircleCircle(this.pos, this.rad, obj.pos, obj.rad)) {
                    this.explode();
                }
            }
        }

        this.game.map.clampToMapBounds(this.pos, this.rad);

        if (this.destroyed) return;

        const originalLayer = this.layer;
        this.checkStairs(objs, this.rad);

        if (!this.dead) {
            if (this.layer !== originalLayer) {
                this.setDirty();
            } else {
                this.setPartDirty();
            }

            this.game.grid.updateObject(this);

            if (def.proximityMine) {
                this.updateMine(dt);
            }

            if (this.posZ === 0 && def.explodeOnImpact) {
                this.explode();
            }

            //
            // Fuse time
            //

            this.fuseTime -= dt;
            if (this.fuseTime <= 0) {
                this.explode();
            }
        }
    }

    /**
     * only used for bomb_iron projectiles, they CANNOT explode inside indestructable buildings
     */
    canBombIronExplode(): boolean {
        const objs = this.game.grid.intersectGameObject(this);

        for (const obj of objs) {
            if (obj.__type != ObjectType.Building) continue;
            if (!util.sameLayer(obj.layer, this.layer)) continue;
            if (obj.wallsToDestroy < Infinity) continue; // building is destructable and bomb irons can explode on it
            for (let i = 0; i < obj.zoomRegions.length; i++) {
                const zoomRegion = obj.zoomRegions[i];

                if (
                    zoomRegion.zoomIn &&
                    coldet.testCircleAabb(
                        this.pos,
                        this.rad,
                        zoomRegion.zoomIn.min,
                        zoomRegion.zoomIn.max,
                    )
                ) {
                    return false;
                }
            }
        }
        return true;
    }

    explode() {
        if (this.dead) return;
        this.dead = true;
        const def = GameObjectDefs.typeToDefSafe(this.type) as ThrowableDef;

        // courtesy of kaklik
        if (def.splitType && def.numSplit) {
            for (let i = 0; i < def.numSplit; i++) {
                const splitDef = GameObjectDefs.typeToDefSafe(def.splitType) as ThrowableDef;
                const velocity = v2.add(this.vel, v2.mul(v2.randomUnit(), 5));
                this.game.projectileBarn.addProjectile(
                    this.playerId,
                    def.splitType,
                    this.pos,
                    1,
                    this.layer,
                    velocity,
                    splitDef.fuseTime,
                    DamageType.Player,
                    undefined,
                    this.weaponSourceType,
                    this.damageMultiplier,
                );
            }
        }

        if (this.type == "bomb_iron" && !this.canBombIronExplode()) {
            this.destroy();
            return;
        }

        const explosionType = def.explosionType;
        if (explosionType) {
            const source = this.game.objectRegister.getById(this.playerId);
            this.game.explosionBarn.addExplosion(
                explosionType,
                this.damageMultiplier,
                this.pos,
                this.layer,
                {
                    gameSourceType: this.type,
                    weaponSourceType: this.weaponSourceType,
                    damageType: this.damageType,
                    source,
                },
                this.obstacleBellowId,
            );
        }
        this.destroy();
    }
}
