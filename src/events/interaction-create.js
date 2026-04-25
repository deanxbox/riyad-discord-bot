import { commandCollection } from '../commands/index.js';
import { handleTriviaButton, TRIVIA_BUTTON_PREFIX } from '../commands/trivia.js';

export async function handleInteractionCreate(interaction, context) {
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
