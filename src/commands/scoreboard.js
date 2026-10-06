import { ActionRowBuilder, EmbedBuilder, SlashCommandBuilder, StringSelectMenuBuilder } from 'discord.js';

export const SCOREBOARD_SORT_ID = 'scoreboard:sort';
const MEDALS = ['🥇', '🥈', '🥉'];
const SORTS = {
  points_desc: 'Points — High to Low',
  points_asc: 'Points — Low to High',
  ratio_desc: 'W/L Ratio — High to Low',
  ratio_asc: 'W/L Ratio — Low to High',
};
const normalizeSort = value => (value === 'ratio' ? 'ratio_desc' : value in SORTS ? value : 'points_desc');

export const scoreboardCommand = {
  data: new SlashCommandBuilder()
    .setName('scoreboard')
    .setDescription('Show the trivia scoreboard for this server')
    .addStringOption(option => option.setName('sort').setDescription('Sort order (default: points, high to low)')
      .addChoices(...Object.entries(SORTS).map(([value, name]) => ({ name, value })))),

  async execute({ interaction, store }) {
    const guild = interaction.guild;

    if (!guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }

    const sort = normalizeSort(interaction.options?.getString('sort'));
    if (store.triviaGetLeaderboard(guild.id, 1).length === 0) {
      await interaction.reply({ content: 'No trivia scores yet! Start a game with `/trivia`.', ephemeral: true });
      return;
    }

    await interaction.deferReply();
    await interaction.editReply(await buildScoreboard(guild, store, sort));
  },
};

export async function handleScoreboardSort(interaction, { store }) {
  await interaction.deferUpdate();
  await interaction.editReply(await buildScoreboard(interaction.guild, store, normalizeSort(interaction.values[0])));
}

async function buildScoreboard(guild, store, sort) {
  const rows = store.triviaGetLeaderboard(guild.id, 10, sort);
  const members = await Promise.all(rows.map(async row =>
    guild.members.cache.get(row.user_id) ?? await guild.members.fetch(row.user_id).catch(() => null)));
  const nameOf = (id, member) => (member?.displayName ?? `User …${id.slice(-4)}`);

  // Monospace table so the columns line up
  const table = rows.map((row, i) => {
    const name = nameOf(row.user_id, members[i]).replace(/`/g, "'");
    const shown = name.length > 14 ? `${name.slice(0, 13)}…` : name;
    const ratio = row.ratio == null ? '  —' : row.ratio.toFixed(2).padStart(5);
    return `${String(i + 1).padStart(2)}. ${shown.padEnd(14)} ${String(row.score).padStart(4)}  ${`${row.wins}W-${row.losses}L`.padEnd(9)} ${ratio}`;
  });
  const header = ` #  ${'Player'.padEnd(14)} ${'Pts'.padStart(4)}  ${'W-L'.padEnd(9)} ${'Ratio'.padStart(5)}`;
  const podium = rows.slice(0, 3).map((row, i) => `${MEDALS[i]} **${nameOf(row.user_id, members[i])}** — ${row.score} pt${row.score === 1 ? '' : 's'}`);

  const records = store.triviaGetRecords?.(guild.id) ?? {};
  const who = r => guild.members.cache.get(r.user_id)?.displayName ?? `<@${r.user_id}>`;
  const extra = [
    records.winStreak && `🔥 Best win streak: **${records.winStreak.value}** (${who(records.winStreak)})`,
    records.lossStreak && `🧊 Worst loss streak: **${records.lossStreak.value}** (${who(records.lossStreak)})`,
    records.firstGuesses && `⚡ Fastest most often: **${who(records.firstGuesses)}** (${records.firstGuesses.value}x)`,
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setTitle('🏆 Trivia Scoreboard')
    .setDescription([
      podium.join('\n'),
      rows.length ? `\`\`\`\n${header}\n${table.join('\n')}\n\`\`\`` : '*No players match this sort yet — W/L ratio needs 10+ guesses.*',
      extra.join('\n'),
    ].filter(Boolean).join('\n'))
    .setColor(0xF1C40F)
    .setFooter({ text: `Sorted by ${SORTS[sort]} · W/L ratio needs 10+ guesses` })
    .setTimestamp();

  const menu = new StringSelectMenuBuilder().setCustomId(SCOREBOARD_SORT_ID).setPlaceholder('Sort scoreboard')
    .addOptions(Object.entries(SORTS).map(([value, label]) => ({ label, value, default: value === sort })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}
