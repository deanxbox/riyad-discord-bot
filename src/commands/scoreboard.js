import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';

const MEDALS = ['🥇', '🥈', '🥉'];

export const scoreboardCommand = {
  data: new SlashCommandBuilder()
    .setName('scoreboard')
    .setDescription('Show the trivia scoreboard for this server'),

  async execute({ interaction, store }) {
    const guild = interaction.guild;

    if (!guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }

    const rows = store.triviaGetLeaderboard(guild.id, 10);

    if (rows.length === 0) {
      await interaction.reply({
        content: 'No trivia scores yet! Start a game with `/trivia`.',
        ephemeral: true,
      });
      return;
    }

    await guild.members.fetch();

    const lines = rows.map((row, i) => {
      const member = guild.members.cache.get(row.user_id);
      const name = member?.displayName ?? `<@${row.user_id}>`;
      const medal = MEDALS[i] ?? `**${i + 1}.**`;
      const pts = row.score === 1 ? '1 pt' : `${row.score} pts`;
      return `${medal}  ${name} — ${pts}`;
    });

    const embed = new EmbedBuilder()
      .setTitle('🏆 Trivia Scoreboard')
      .setDescription(lines.join('\n'))
      .setColor(0xF1C40F)
      .setFooter({ text: 'Play trivia with /trivia' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
