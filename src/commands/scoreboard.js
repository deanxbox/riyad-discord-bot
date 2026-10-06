import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';

const MEDALS = ['🥇', '🥈', '🥉'];

export const scoreboardCommand = {
  data: new SlashCommandBuilder()
    .setName('scoreboard')
    .setDescription('Show the trivia scoreboard for this server')
    .addStringOption(option => option.setName('sort').setDescription('Sort order (default: points)')
      .addChoices({ name: 'Points', value: 'points' }, { name: 'W/L ratio (10+ guesses)', value: 'ratio' })),

  async execute({ interaction, store }) {
    const guild = interaction.guild;

    if (!guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }

    const sort = interaction.options?.getString('sort') === 'ratio' ? 'ratio' : 'points';
    const rows = store.triviaGetLeaderboard(guild.id, 10, sort);

    if (rows.length === 0) {
      await interaction.reply({
        content: 'No trivia scores yet! Start a game with `/trivia`.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();
    const members = await Promise.all(rows.map(async row =>
      guild.members.cache.get(row.user_id) ?? await guild.members.fetch(row.user_id).catch(() => null)));
    const lines = rows.map((row, i) => {
      const member = members[i];
      const name = member?.displayName ?? `<@${row.user_id}>`;
      const medal = MEDALS[i] ?? `**${i + 1}.**`;
      const pts = row.score === 1 ? '1 pt' : `${row.score} pts`;
      const record = row.ratio == null ? `${row.wins ?? 0}W/${row.losses ?? 0}L` : `${row.wins}W/${row.losses}L (${row.ratio.toFixed(2)})`;
      return `${medal}  ${name} — ${pts} · ${record}`;
    });

    const records = store.triviaGetRecords?.(guild.id) ?? {};
    const who = r => guild.members.cache.get(r.user_id)?.displayName ?? `<@${r.user_id}>`;
    const extra = [
      records.winStreak && `🔥 Best win streak: **${records.winStreak.value}** (${who(records.winStreak)})`,
      records.lossStreak && `🧊 Worst loss streak: **${records.lossStreak.value}** (${who(records.lossStreak)})`,
      records.firstGuesses && `⚡ Fastest most often: ${who(records.firstGuesses)} (${records.firstGuesses.value}x)`,
    ].filter(Boolean);

    const embed = new EmbedBuilder()
      .setTitle('🏆 Trivia Scoreboard')
      .setDescription(lines.join('\n') + (extra.length ? `\n\n${extra.join('\n')}` : ''))
      .setColor(0xF1C40F)
      .setFooter({ text: 'Play trivia with /trivia' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
