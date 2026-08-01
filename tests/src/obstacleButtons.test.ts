import { describe, expect, test, vi } from "vitest";
import { MapObjectDefs } from "../../shared/defs/register.ts";
import { ObjectType } from "../../shared/net/objectSerializeFns.ts";
import { Obstacle } from "../../server/src/game/objects/obstacle.ts";
import { v2 } from "../../shared/utils/v2.ts";

describe("Obstacle button interactions", () => {
    test("buttons flip state immediately and reject repeat interactions", () => {
        vi.useFakeTimers();

        try {
            const buttonObstacle = {
                button: {
                    onOff: false,
                    canUse: true,
                    seq: 1,
                    useOnce: false,
                    useType: "",
                    useDelay: 0.25,
                    useDir: v2.create(-1, 0),
                    useCooldown: 0.5,
                    useExpiration: 0,
                    resetAfterCooldown: true,
                    useImg: "",
                    sound: { on: "", off: "" },
                },
                parentBuilding: undefined,
                isButton: true,
                isPuzzlePiece: false,
                setDirty: vi.fn(),
                kill: vi.fn(),
                interactedBy: undefined,
                type: "control_panel_07",
            };

            Obstacle.prototype.useButton.call(buttonObstacle as any);
            Obstacle.prototype.useButton.call(buttonObstacle as any);

            // the press registers right away (that's the client's only feedback), and the
            // second press is rejected while the button is on cooldown
            expect(buttonObstacle.button.seq).toBe(2);
            expect(buttonObstacle.button.onOff).toBe(true);
            expect(buttonObstacle.button.canUse).toBe(false);

            vi.advanceTimersByTime(250);
            expect(buttonObstacle.button.canUse).toBe(false);
            expect(buttonObstacle.button.seq).toBe(2);

            vi.advanceTimersByTime(500);
            expect(buttonObstacle.button.canUse).toBe(true);
            expect(buttonObstacle.button.onOff).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
/*
    test("close-and-lock button effects reset after expiration", () => {
        vi.useFakeTimers();

        try {
            const doorState = {
                open: true,
                canUse: true,
                locked: false,
            };

            const targetDoor = {
                __type: ObjectType.Obstacle,
                type: "house_door_02",
                isDoor: true,
                dead: false,
                door: doorState,
                setDirty: vi.fn(),
                delayedToggle: vi.fn(),
                toggleDoor: vi.fn(function() {
                    this.door.open = !this.door.open;
                    this.setDirty();
                }),
                setDoorState: vi.fn(function(open: boolean) {
                    this.door.open = open;
                    this.setDirty();
                }),
            };

            const buttonObstacle = {
                button: {
                    onOff: false,
                    canUse: true,
                    seq: 1,
                    useOnce: false,
                    useType: "house_door_02",
                    useDelay: 0,
                    useDir: v2.create(-1, 0),
                    useStyle: "close",
                    useLock: "lock",
                    useCooldown: 5,
                    useExpiration: 1,
                    resetAfterCooldown: true,
                    useImg: "",
                    sound: { on: "", off: "" },
                },
                parentBuilding: {
                    childObjects: [targetDoor],
                },
                isButton: true,
                isPuzzlePiece: false,
                setDirty: vi.fn(),
                kill: vi.fn(),
                interactedBy: undefined,
                type: "control_panel_07",
            };

            Obstacle.prototype.useButton.call(buttonObstacle as any);

            expect(targetDoor.door.open).toBe(false);
            expect(targetDoor.door.locked).toBe(true);
            expect(buttonObstacle.button.canUse).toBe(false);

            vi.advanceTimersByTime(1000);

            expect(targetDoor.door.open).toBe(true);
            expect(targetDoor.door.locked).toBe(false);

            vi.advanceTimersByTime(4000);

            expect(buttonObstacle.button.canUse).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });*/

    // The weapon bench's effect is a 3s Modify action that draws its own progress bar,
    // so a useDelay in front of it was a dead pause between the click sound and any
    // visible feedback — the bench's useImg is its normal sprite, so nothing changes
    // during it either. Unlike an airdrop, whose useDelay drives the destroy timer.
    test("the weapon bench starts its action on the press", () => {
        vi.useFakeTimers();

        try {
            const benchDef = MapObjectDefs.typeToDef("table_04", "obstacle");
            expect(benchDef.button?.useDelay).toBe(0);

            const doAction = vi.fn();
            const player = {
                activeWeapon: "mac10", // has an `upgraded` entry
                weaponManager: { curWeapIdx: 0 },
                invManager: { get: () => 99 }, // enough construction items
                msgsToSend: [] as unknown[],
                doAction,
            };

            const bench = {
                button: {
                    onOff: false,
                    canUse: true,
                    seq: 1,
                    useOnce: false,
                    useType: "weapon_upgrade_bench",
                    useDelay: benchDef.button!.useDelay,
                    useDir: v2.create(0, -1),
                    useImg: "",
                    sound: { on: "", off: "" },
                },
                parentBuilding: undefined,
                isButton: true,
                isPuzzlePiece: false,
                setDirty: vi.fn(),
                kill: vi.fn(),
                interactedBy: player,
                pos: v2.create(0, 0),
                type: "table_04",
            };

            Obstacle.prototype.useButton.call(bench as any);

            // No timer advance: the upgrade action must already be running.
            expect(doAction).toHaveBeenCalledTimes(1);
            expect(doAction.mock.calls[0][0]).toBe("modified_mac10");
            // And the bench stays usable — nothing is pending behind a delay.
            expect(bench.button.canUse).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
