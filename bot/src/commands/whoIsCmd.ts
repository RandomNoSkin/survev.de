import { ActionRowBuilder, ChatInputCommandInteraction, ComponentType, EmbedBuilder, SlashCommandBuilder, StringSelectMenuBuilder } from "discord.js";
import { Command, hasBotPermission, honoClient, isAdmin } from "../utils";

export const whoIsCmd = {
    command: new SlashCommandBuilder()
        .setName(Command.WhoIs)
        .setDescription("Get IP Info.")
        .addStringOption((option) =>
            option
                .setName("ip")
                .setDescription("The Encoded IP of the player you want to search for.")
                .setRequired(true),
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        if(!hasBotPermission(interaction)){
            interaction.reply({
                content: "No Permission",
            });
            return;
        }
        await interaction.deferReply({ ephemeral: false });

        const ip = interaction.options.getString("ip", true);

        // Sonst letzte 20 Einträge anhand der ip holen
        const res = await honoClient.moderation.who_is.$post({
            json: {
                ip,
            },
        });


        const data = await res.json();

        if (!Array.isArray(data)) {
            await interaction.editReply(data.message ?? "Unexpected response from server.");
            return;
        }

        if (data.length === 0) {
        await interaction.editReply(`No recent ip entries found for \`${ip}\`.`);
        return;
    }

    const lines = data.map((entry, index) => {
        const username = entry.username ?? "Unknown";
        const slug = entry.slug ? ` · \`${entry.slug}\`` : "";

        return `**${index + 1}.** ${username} || Acc: ${slug} DiscordId: ${entry.discordId}`;
    });

    const embed = new EmbedBuilder()
        .setTitle(`Who is: ${ip}`)
        .setDescription(lines.join("\n"))
        .setFooter({
            text: `${data.length} unique player${data.length === 1 ? "" : "s"} found`,
        })
        .setTimestamp();

    await interaction.editReply({
        embeds: [embed],
    });

        

        
    },
};