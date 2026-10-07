import { commandCollection } from '../commands/index.js';
import { handleTriviaButton, handleTriviaNewButton, TRIVIA_BUTTON_PREFIX, TRIVIA_NEW_ID } from '../commands/trivia.js';
import { handleScoreboardSort, SCOREBOARD_SORT_ID } from '../commands/scoreboard.js';

export async function handleInteractionCreate(interaction, context) {
  if (interaction.isStringSelectMenu() && interaction.customId === SCOREBOARD_SORT_ID) {
    await handleScoreboardSort(interaction, context);
    return;
  }

  if (interaction.isButton() && interaction.customId === TRIVIA_NEW_ID) {
    try {
      await handleTriviaNewButton(interaction, context);
    } catch (error) {
      console.error('New trivia button failed', error);
      const response = { content: 'Could not start a new trivia.', ephemeral: true };
      await (interaction.deferred || interaction.replied ? interaction.followUp(response) : interaction.reply(response)).catch(() => {});
    }
    return;
  }

  if (interaction.isButton()) {
    const handled = await context.downloadJobs.handleButton(interaction);

    if (handled) {
      return;
    }

    if (interaction.customId.startsWith(TRIVIA_BUTTON_PREFIX)) {
      await handleTriviaButton(interaction, context);
      return;
    }
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = commandCollection.get(interaction.commandName);

  if (!command) {
    return;
  }

  try {
    await command.execute({
      interaction,
      ...context,
    });
  } catch (error) {
    console.error(`Command failed: ${interaction.commandName}`, error);

    const response = {
      content: 'That command failed unexpectedly.',
      ephemeral: true,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(response).catch(() => {});
    } else {
      await interaction.reply(response).catch(() => {});
    }
  }
}
