import "./testHelpers.ts";
import { expect, test } from "vitest";
import { TeamMode } from "../../shared/gameConfig.ts";
import { IDAllocator } from "../../server/src/utils/IDAllocator.ts";
import { createGame } from "./gameTestHelpers.ts";

// Group IDs used to leak: activatePlayer allocates one per group-less player (solo modes
// and spectators) and removePlayer never gave any back, so an arena with joins/leaves ran
// the allocator dry and crashed the game process with "Ran out of ID's".

test("Allocator reuses returned IDs", () => {
    const alloc = new IDAllocator(3);

    const ids = [alloc.getNextId(), alloc.getNextId(), alloc.getNextId()];
    expect(ids).toEqual([1, 2, 3]);
    expect(() => alloc.getNextId()).toThrow("Ran out of ID's");

    alloc.give(2);
    expect(alloc.getNextId()).toBe(2);
    expect(() => alloc.getNextId()).toThrow("Ran out of ID's");
});

test("Giving the same ID back twice hands it out once", () => {
    const alloc = new IDAllocator(1);

    expect(alloc.getNextId()).toBe(1);
    alloc.give(1);
    alloc.give(1);

    expect(alloc.getNextId()).toBe(1);
    expect(() => alloc.getNextId()).toThrow("Ran out of ID's");
});

test("Solo join/leave churn doesn't exhaust group IDs", () => {
    const game = createGame(TeamMode.Solo, "test_normal");

    const teamIds = new Set<number>();

    // Well past the 255 IDs the allocator holds — without recycling this throws.
    for (let i = 0; i < 600; i++) {
        // No net tick runs in this harness, so drain the broadcast buffer the join feed
        // writes into; otherwise the test dies on a full stream instead of on ID's.
        game.msgsToSend.stream.index = 0;

        const player = game.playerBarn.addTestPlayer({});
        teamIds.add(player.teamId);
        // Leave as a spectator would: removePlayer skips the game-over bookkeeping, which
        // is what churns through IDs on the arena servers.
        player.spectator = true;
        game.playerBarn.removePlayer(player);
    }

    expect(game.playerBarn.players.length).toBe(0);
    // The allocator counts up to maxId before it touches the free list, so 600 joins over
    // only 255 distinct IDs is the recycling: without it, join 256 throws.
    expect(teamIds.size).toBe(255);
});

test("Group IDs stay unique while players are in the game", () => {
    const game = createGame(TeamMode.Solo, "test_normal");

    const players = [];
    for (let i = 0; i < 40; i++) {
        players.push(game.playerBarn.addTestPlayer({}));
    }

    const teamIds = players.map((p) => p.teamId);
    expect(new Set(teamIds).size).toBe(players.length);
});
