import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { DownloadCancelledError, downloadUserHistory } from './history-downloader.js';

const CANCEL_PREFIX = 'download-cancel:';
const RENDER_INTERVAL_MS = 1500;

function formatCount(value) {
  return new Intl.NumberFormat('en-GB').format(value);
}

function buildProgressBar(downloadedCount, goalCount) {
  if (!goalCount || goalCount <= 0) {
    return '[discovering total results]';
  }

  const width = 12;
  const ratio = Math.max(0, Math.min(1, downloadedCount / goalCount));
  const filled = Math.round(width * ratio);

  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${Math.round(ratio * 100)}%`;
}

function resolveGoalCount(job) {
  if (job.limit === null) {
    return job.totalResults;
  }

  if (job.totalResults === null) {
    return job.limit;
  }

  return Math.min(job.limit, job.totalResults);
}

function formatStatus(job) {
  const goalCount = resolveGoalCount(job);
  const progressLine = goalCount === null
    ? `${formatCount(job.downloadedCount)} messages stored so far`
    : `${formatCount(job.downloadedCount)} / ${formatCount(goalCount)} messages`;

  let statusLine = 'Starting download...';

  if (job.status === 'running') {
    statusLine = "Searching Discord for that user's messages...";
  } else if (job.status === 'cancel_requested') {
    statusLine = 'Cancellation requested. Finishing the current request...';
  } else if (job.status === 'indexing') {
    statusLine = `Discord is still indexing searchable messages. Retrying in ${job.retryAfterSeconds}s...`;
  } else if (job.status === 'cancelled') {
    statusLine = 'Download cancelled. Stored archive was left unchanged.';
  } else if (job.status === 'completed') {
    statusLine = 'Download completed and archive replaced.';
  } else if (job.status === 'failed') {
    statusLine = `Download failed: ${job.errorMessage}`;
  }

  return [
    `**Download job for <@${job.targetUserId}>**`,
    statusLine,
    buildProgressBar(job.downloadedCount, goalCount),
    `Progress: ${progressLine}`,
    `Search requests: ${formatCount(job.requestsMade)}`,
    `Last page added: ${formatCount(job.lastPageCount)}`,
    job.status === 'indexing' ? `Indexed documents so far: ${formatCount(job.documentsIndexed)}` : null,
    'Source: Discord guild search API filtered by author ID',
    job.status === 'completed' || job.status === 'cancelled'
      ? null
      : 'The existing saved archive will only be replaced if this download finishes successfully.',
  ].filter(Boolean).join('\n');
}

function buildComponents(job, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CANCEL_PREFIX}${job.id}`)
        .setLabel('Cancel Download')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(
          disabled ||
          (
            job.status !== 'running' &&
            job.status !== 'starting' &&
            job.status !== 'indexing' &&
            job.status !== 'cancel_requested'
          ),
        ),
    ),
  ];
}

export class DownloadJobManager {
  constructor({ client, config, store }) {
    this.client = client;
    this.config = config;
    this.store = store;
    this.jobs = new Map();
    this.jobsByTarget = new Map();
  }

  targetKey(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  getActiveJob(guildId, userId) {
    const jobId = this.jobsByTarget.get(this.targetKey(guildId, userId));
    return jobId ? this.jobs.get(jobId) ?? null : null;
  }

  async start({ interaction, targetUserId, limit }) {
    const existingJob = this.getActiveJob(interaction.guildId, targetUserId);

    if (existingJob) {
      await interaction.editReply({
        content: `${formatStatus(existingJob)}\n\nA download for this user is already running.`,
        components: buildComponents(existingJob),
      });
      return existingJob;
    }

    const job = {
      id: randomUUID(),
      guildId: interaction.guildId,
      requestedById: interaction.user.id,
      targetUserId,
      limit,
      downloadedCount: 0,
      totalResults: null,
      requestsMade: 0,
      lastPageCount: 0,
      retryAfterSeconds: 0,
      documentsIndexed: 0,
      status: 'starting',
      errorMessage: null,
      abortController: new AbortController(),
      progressMessage: null,
      lastRenderedAt: 0,
    };

    this.jobs.set(job.id, job);
    this.jobsByTarget.set(this.targetKey(job.guildId, job.targetUserId), job.id);

    await interaction.editReply({
      content: formatStatus(job),
      components: buildComponents(job),
    });

    job.progressMessage = await interaction.fetchReply();

    void this.run(job);

    return job;
  }

  async handleButton(interaction) {
    if (!interaction.customId.startsWith(CANCEL_PREFIX)) {
      return false;
    }

    const jobId = interaction.customId.slice(CANCEL_PREFIX.length);
    const job = this.jobs.get(jobId);

    if (!job) {
      await interaction.reply({
        content: 'That download job no longer exists.',
        ephemeral: true,
      });
      return true;
    }

    if (interaction.user.id !== job.requestedById && interaction.user.id !== this.config.specialUserId) {
      await interaction.reply({
        content: 'You do not have permission to cancel this download.',
        ephemeral: true,
      });
      return true;
    }

    if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') {
      await interaction.reply({
        content: 'That download is already finished.',
        ephemeral: true,
      });
      return true;
    }

    job.status = 'cancel_requested';
    job.abortController.abort();

    await interaction.deferUpdate();
    await this.render(job, { force: true });
    return true;
  }

  async run(job) {
    try {
      const result = await downloadUserHistory({
        client: this.client,
        guildId: job.guildId,
        targetUserId: job.targetUserId,
        limit: job.limit,
        store: this.store,
        jobId: job.id,
        signal: job.abortController.signal,
        onProgress: async ({
          status,
          downloadedCount,
          totalResults,
          requestsMade,
          lastPageCount,
          retryAfterSeconds = 0,
          documentsIndexed = 0,
        }) => {
          job.status = status;
          job.downloadedCount = downloadedCount;
          job.totalResults = totalResults ?? job.totalResults;
          job.requestsMade = requestsMade;
          job.lastPageCount = lastPageCount;
          job.retryAfterSeconds = retryAfterSeconds;
          job.documentsIndexed = documentsIndexed;

          await this.render(job);
        },
      });

      job.status = 'completed';
      job.downloadedCount = result.downloadedCount;
      job.totalResults = result.totalResults ?? job.totalResults;
      job.requestsMade = result.requestsMade;
      job.lastPageCount = 0;
      job.retryAfterSeconds = 0;
      job.documentsIndexed = 0;

      await this.render(job, { force: true, disableButtons: true });
    } catch (error) {
      if (error instanceof DownloadCancelledError) {
        job.status = 'cancelled';
        await this.render(job, { force: true, disableButtons: true });
      } else {
        console.error(`Download job ${job.id} failed`, error);
        job.status = 'failed';
        job.errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await this.render(job, { force: true, disableButtons: true });
      }
    } finally {
      this.jobsByTarget.delete(this.targetKey(job.guildId, job.targetUserId));
    }
  }

  async render(job, { force = false, disableButtons = false } = {}) {
    if (!job.progressMessage) {
      return;
    }

    const now = Date.now();

    if (!force && now - job.lastRenderedAt < RENDER_INTERVAL_MS) {
      return;
    }

    job.lastRenderedAt = now;

    await job.progressMessage.edit({
      content: formatStatus(job),
      components: buildComponents(job, disableButtons),
    }).catch((error) => {
      console.error(`Failed to render download job ${job.id}`, error);
    });
  }
}
