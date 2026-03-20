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
        await interaction.deferReply({ ephemeral: true });

        const name = interaction.options.getString("name", true);
        const gameId = interaction.options.getString("game_id", false);

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

        const options = data.slice(0, 10).map((player, index) => {
            const date = player.createdAt
                ? new Date(player.createdAt).toLocaleString()
                : "unknown time";

            return {
                label: `${player.username ?? name}`.slice(0, 100),
                description: `${date} | ${player.teamMode ?? "unknown"}`.slice(0, 100),
                value: player.gameId ?? `fallback_${index}`, // WICHTIG: gameId behalten!
            };
        });

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
                    use_account_slug: false,
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

            await componentInteraction.update({
                content: [
                    `**Player info**`,
                    `Name: \`${player.username ?? "unknown"}\``,
                    `Game ID: \`${player.gameId ?? selectedGameId}\``,
                    `Encoded IP: \`${player.ip ?? "unknown"}\``,
                    `Account Slug: \`${player.slug ?? "none"}\``,
                    `Account Discord ID: \`${player.linkedDiscord ?? "none"}\``
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