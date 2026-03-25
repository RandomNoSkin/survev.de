import { ActionRowBuilder, ChatInputCommandInteraction, ComponentType, SlashCommandBuilder, StringSelectMenuBuilder } from "discord.js";
import { Command, hasBotPermission, honoClient, isAdmin } from "../utils";

export const getPlayerHandler = {
    command: new SlashCommandBuilder()
        .setName(Command.GetPlayer)
        .setDescription("Get player info by their name.")
        .addStringOption((option) =>
            option
                .setName("name")
                .setDescription("The name of the player to search for")
                .setRequired(true),
        )
        .addBooleanOption((option)=>
            option
                .setName("account_slug")
                .setDescription("If the name is acc slug = true")
                .setRequired(false)
        )
        .addStringOption((option) =>
            option
                .setName("game_id")
                .setDescription("Specify a specific game to search for")
                .setRequired(false),
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        if(!hasBotPermission(interaction)){
            interaction.reply({
                content: "No Permission",
            });
            return;
        }
        await interaction.deferReply({ ephemeral: false });

        const name = interaction.options.getString("name", true);
        const gameId = interaction.options.getString("game_id", false);
        const accSlug = interaction.options.getBoolean("account_slug", false);

        if(accSlug){
            const res = await honoClient.moderation.get_player_ip.$post({
                json: {
                    name,
                    use_account_slug: true,
                },
            });

            const data = await res.json();

        if (!Array.isArray(data)) {
            await interaction.editReply(data.message ?? "Unexpected response from server.");
            return;
        }

        if (data.length === 0) {
            await interaction.editReply(`No recent player entries found for \`${name}\`.`);
            return;
        }

        const gameIds: string[] = [];
        const optionsBuilder = data.slice(0, 10).map((player, index) => {
            const date = player.createdAt
                ? new Date(player.createdAt).toLocaleString()
                : "unknown time";

            if(gameIds.includes(player.gameId)) return;
            gameIds.push(player.gameId);
            return {
                label: `${player.username ?? name}`.slice(0, 100),
                description: `${date} | ${player.teamMode ?? "unknown"}`.slice(0, 100),
                value: player.gameId ?? `fallback_${index}`,
            };
        });

        const options = optionsBuilder.filter(o => o !== undefined);

        const select = new StringSelectMenuBuilder()
            .setCustomId(`get_player_select:${interaction.user.id}:${name}`)
            .setPlaceholder("Choose one of the last 10 matching players")
            .addOptions(options);

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

        await interaction.editReply({
            content: `Found ${data.length} recent entries for \`${name}\`. Choose one:`,
            components: [row],
        });

        const reply = await interaction.fetchReply();

        try {
            const componentInteraction = await reply.awaitMessageComponent({
                componentType: ComponentType.StringSelect,
                time: 60_000,
                filter: (i) =>
                    i.user.id === interaction.user.id &&
                    i.customId === `get_player_select:${interaction.user.id}:${name}`,
            });

            const selectedGameId = componentInteraction.values[0];

            const detailsRes = await honoClient.moderation.get_player_ip.$post({
                json: {
                    name,
                    game_id: selectedGameId,
                },
            });

            const detailsData = await detailsRes.json();

            if (!Array.isArray(detailsData) || detailsData.length === 0) {
                await componentInteraction.update({
                    content: `No details found for selected entry.`,
                    components: [],
                });
                return;
            }

            const player = detailsData[0];
            const associatedIps = [player.ip];
            if (player.findGameIp !== player.ip) {
                associatedIps.push(player.findGameIp);
            }
            let playerIps = "";
            for(const ip of associatedIps){
                playerIps += `${ip} | `
            }

            await componentInteraction.update({
                content: [
                    `**Player info**`,
                    `Name: \`${player.username ?? "unknown"}\``,
                    `Game ID: \`${player.gameId ?? selectedGameId}\``,
                    `Encoded IP: \`${playerIps}\``,
                    `Account Slug: \`${player.slug ?? "none"}\``,
                        ].join("\n"),
                        components: [],
                    });
            } catch {
                await interaction.editReply({
                    content: "Selection expired.",
                    components: [],
                });
            }
        }

        // Falls direkt eine game_id mitgegeben wurde -> direkt 1 exakten Treffer holen
        if (gameId) {
            const res = await honoClient.moderation.get_player_ip.$post({
                json: {
                    name,
                    game_id: gameId,
                    use_account_slug: false,
                },
            });

            const data = await res.json();

            if (!Array.isArray(data) || data.length === 0) {
                await interaction.editReply(`No player entry found for \`${name}\` in game \`${gameId}\`.`);
                return;
            }

            const player = data[0];

            await interaction.editReply(
                [
                    `**Player info**`,
                    `Name: \`${player.username ?? "unknown"}\``,
                    `Game ID: \`${player.gameId ?? gameId}\``,
                    `Encoded IP: \`${player.ip ?? "unknown"}\``,
                ].join("\n"),
            );
            return;
        }

        // Sonst letzte 10 Einträge anhand des Namens holen
        const res = await honoClient.moderation.get_player_ip.$post({
            json: {
                name,
                use_account_slug: false,
            },
        });

        const data = await res.json();

        if (!Array.isArray(data)) {
            await interaction.editReply(data.message ?? "Unexpected response from server.");
            return;
        }

        if (data.length === 0) {
            await interaction.editReply(`No recent player entries found for \`${name}\`.`);
            return;
        }

        const gameIds: string[] = [];
        const optionsBuilder = data.slice(0, 10).map((player, index) => {
            const date = player.createdAt
                ? new Date(player.createdAt).toLocaleString()
                : "unknown time";

            if(gameIds.includes(player.gameId)) return;
            gameIds.push(player.gameId);
            return {
                label: `${player.username ?? name}`.slice(0, 100),
                description: `${date} | ${player.teamMode ?? "unknown"}`.slice(0, 100),
                value: player.gameId ?? `fallback_${index}`,
            };
        });

        const options = optionsBuilder.filter(o => o !== undefined);

        const select = new StringSelectMenuBuilder()
            .setCustomId(`get_player_select:${interaction.user.id}:${name}`)
            .setPlaceholder("Choose one of the last 10 matching players")
            .addOptions(options);

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

        await interaction.editReply({
            content: `Found ${data.length} recent entries for \`${name}\`. Choose one:`,
            components: [row],
        });

        const reply = await interaction.fetchReply();

        try {
            const componentInteraction = await reply.awaitMessageComponent({
                componentType: ComponentType.StringSelect,
                time: 60_000,
                filter: (i) =>
                    i.user.id === interaction.user.id &&
                    i.customId === `get_player_select:${interaction.user.id}:${name}`,
            });

            const selectedGameId = componentInteraction.values[0];

            const detailsRes = await honoClient.moderation.get_player_ip.$post({
                json: {
                    name,
                    game_id: selectedGameId,
                },
            });

            const detailsData = await detailsRes.json();

            if (!Array.isArray(detailsData) || detailsData.length === 0) {
                await componentInteraction.update({
                    content: `No details found for selected entry.`,
                    components: [],
                });
                return;
            }

            const player = detailsData[0];
            const associatedIps = [player.ip];
            if (player.findGameIp !== player.ip) {
                associatedIps.push(player.findGameIp);
            }
            let playerIps = "";
            for(const ip of associatedIps){
                playerIps += `${ip} | `
            }

            await componentInteraction.update({
                content: [
                    `**Player info**`,
                    `Name: \`${player.username ?? "unknown"}\``,
                    `Game ID: \`${player.gameId ?? selectedGameId}\``,
                    `Encoded IP: \`${playerIps}\``,
                    `Account Slug: \`${player.slug ?? "none"}\``,
                ].join("\n"),
                components: [],
            });
        } catch {
            await interaction.editReply({
                content: "Selection expired.",
                components: [],
            });
        }
    },
};