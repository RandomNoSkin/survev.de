import { beforeEach, expect, test, vi } from "vitest";
import { Config } from "../../server/src/config.ts";
import { GameConfig, TeamMode, WeaponSlot } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

beforeEach(() => {
    Config.bots.enabled = true;
    Config.bots.maxBotsPerGame = 8;
    // Bots must not depend on this - it only gates clients that tag themselves as bots.
    Config.debug.allowBots = false;
});

test("Bot spawns as a real player, independent of debug.allowBots", () => {
    const game = createGame(TeamMode.Solo, "test_normal");

    const [bot] = game.botBarn.spawn(1, "normal");

    expect(bot).toBeDefined();
    expect(bot.bot).toBe(true);
    expect(bot.botDifficulty).toBe("normal");
    expect(game.playerBarn.livingPlayers).toContain(bot);
    expect(game.botBarn.count).toBe(1);
});

test("Bot carries the [BOT] name tag", () => {
    const game = createGame(TeamMode.Solo, "test_normal");

    const [bot] = game.botBarn.spawn(1, "normal");

    expect(bot.roleTag).toBe("bot");
});

test("Bot names never collide with an existing player", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    Config.bots.names = ["Duplicate"];

    const first = game.playerBarn.addBotPlayer({ name: "Duplicate" });
    const second = game.playerBarn.addBotPlayer({ name: "Duplicate" });

    expect(second.name).not.toBe(first.name);
});

test("spawn() respects maxBotsPerGame", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    Config.bots.maxBotsPerGame = 2;

    expect(game.botBarn.spawn(5, "normal")).toHaveLength(2);
    expect(game.botBarn.spawn(1, "normal")).toHaveLength(0);
    expect(game.botBarn.count).toBe(2);
});

test("spawn() is a no-op while bots are disabled", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    Config.bots.enabled = false;

    expect(game.botBarn.spawn(3, "normal")).toHaveLength(0);
    expect(game.botBarn.count).toBe(0);
});

test("Bots are skipped in sendMsgs and never allocate a msgStream", () => {
    const game = createGame(TeamMode.Solo, "test_normal");

    const human = game.playerBarn.addTestPlayer({});
    const [bot] = game.botBarn.spawn(1, "normal");

    const humanSpy = vi.spyOn(human, "sendMsgs");
    const botSpy = vi.spyOn(bot, "sendMsgs");

    game.playerBarn.sendMsgs();

    expect(humanSpy).toHaveBeenCalled();
    expect(botSpy).not.toHaveBeenCalled();
    // The 64 KB stream is lazily created by the getter, so an untouched bot has none.
    expect(Reflect.get(bot, "_msgStream")).toBeUndefined();
});

test("Bots do not keep an abandoned game alive", () => {
    const game = createGame(TeamMode.Solo, "test_normal");

    game.botBarn.spawn(2, "normal");
    // No human ever joined, so the empty-game reaper must still fire.
    game.step(61);

    expect(game.stopped).toBe(true);
});

test("A connected human keeps the game alive", () => {
    const game = createGame(TeamMode.Solo, "test_normal");

    game.playerBarn.addTestPlayer({});
    game.botBarn.spawn(1, "normal");
    game.step(61);

    expect(game.stopped).toBe(false);
});

test("Bot matches are never persisted, but ranks stay correct", async () => {
    const game = createGame(TeamMode.Solo, "test_normal");

    const human = game.playerBarn.addTestPlayer({});
    const [bot] = game.botBarn.spawn(1, "normal");

    expect(game.hadBots).toBe(true);

    // Human loses the 1v1: the bot must rank #1 and the human #2.
    human.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.randomUnit(),
        source: bot,
    });

    const ranked = game.modeManager.getPlayersSortedByRank();
    expect(ranked.find((r) => r.player === bot)?.rank).toBe(1);
    expect(ranked.find((r) => r.player === human)?.rank).toBe(2);

    // ...while the save path bails out before touching the database.
    const info = vi.spyOn(game.logger, "info");
    game.stop();
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith("Skipping match save: game contained bots"));
});

test("A bot-free match still reaches the save path", async () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    game.playerBarn.addTestPlayer({});
    game.playerBarn.addTestPlayer({});

    expect(game.hadBots).toBe(false);

    const info = vi.spyOn(game.logger, "info");
    game.stop();
    // Give the async save a tick to run, then assert it did NOT take the bot shortcut.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(info).not.toHaveBeenCalledWith("Skipping match save: game contained bots");
});

test("Bots do not count toward the reported region population", () => {
    const game = createGame(TeamMode.Solo, "test_normal");

    game.playerBarn.addTestPlayer({});
    game.botBarn.spawn(3, "normal");

    expect(game.aliveCount).toBe(4);
    expect(game.humanAliveCount).toBe(1);
    expect(game.connectedHumanCount).toBe(1);
});

// `local` is the 1v1 arena map: arenaMode, pickup: false, and arenaLobbyRoles: 1 - the
// first player to pick locks the role pool for everyone (see Player.playerRoleSelect).
// Both Player.update() and handleInput() hard-return while `arenaMode && !role`, so a
// bot without a role is a statue.
test("Arena bot gets a role immediately instead of waiting out the role menu", () => {
    const game = createGame(TeamMode.Solo, "local");
    expect(game.map.arenaMode).toBe(true);

    const [bot] = game.botBarn.spawn(1, "normal");

    expect(bot.role).toBeTruthy();
    expect(bot.roleMenuTicker).toBe(0);
});

test("Arena bot takes the role the human already locked in", () => {
    const game = createGame(TeamMode.Solo, "local");

    const human = game.playerBarn.addTestPlayer({});
    human.playerRoleSelect("arena1");
    expect(game.arenaRoles).toEqual(["arena1"]);

    const [bot] = game.botBarn.spawn(1, "normal");

    // arenaLobbyRoles: 1 means everyone plays the same role - the bot must not be able
    // to pick something else, and must not have forced the human's choice either.
    expect(bot.role).toBe("arena1");
    expect(human.role).toBe("arena1");
});

test("Arena bot can move once it has its role", () => {
    const game = createGame(TeamMode.Solo, "local");

    game.playerBarn.addTestPlayer({}).playerRoleSelect("arena1");
    const [bot] = game.botBarn.spawn(1, "normal");

    const start = v2.copy(bot.pos);
    bot.touchMoveActive = true;
    bot.touchMoveDir = v2.create(1, 0);
    bot.touchMoveLen = 255;
    game.step(0.5);

    expect(v2.distance(bot.pos, start)).toBeGreaterThan(0.5);
});

// Regression test for a real bug found in manual play: `promoteToRole`/`setWeapon`
// assign a role's guns into the Primary/Secondary slots but never touch `curWeapIdx`
// (a human client auto-sends Input.EquipPrimary on spawn; bots never send input at
// all). Without `updateWeaponSelection`'s melee-fallback, a bot would stand there
// holding fists forever - it would walk, but never fight.
test("Arena bot equips its role's gun instead of standing there on fists", () => {
    const game = createGame(TeamMode.Solo, "local");
    game.playerBarn.addTestPlayer({}).playerRoleSelect("arena1");
    const [bot] = game.botBarn.spawn(1, "normal");

    // True immediately after role assignment - promoteToRole never switches curWeapIdx.
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Melee);

    game.step(1); // let the brain tick at least once

    expect(bot.weaponManager.curWeapIdx).not.toBe(WeaponSlot.Melee);
    expect(bot.weaponManager.activeWeapon).toBe("m870"); // arena1's primary
});

test("Dead bots are dropped from the barn but stay in the match", () => {
    const game = createGame(TeamMode.Solo, "test_normal");

    const human = game.playerBarn.addTestPlayer({});
    const [bot] = game.botBarn.spawn(1, "normal");

    bot.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.randomUnit(),
        source: human,
    });
    game.botBarn.update(0.1);

    expect(bot.dead).toBe(true);
    expect(game.botBarn.count).toBe(0);
    // Still a match participant, so kill credit and ranking behave normally.
    expect(game.playerBarn.players).toContain(bot);
    expect(human.kills).toBe(1);
});
