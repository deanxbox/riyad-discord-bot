import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createSearchLimiter, DownloadCancelledError, downloadUserHistory } from './history-downloader.js';

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
  const processedCount = job.downloadedCount + job.mediaSkipped;
  const progressLine = `${formatCount(job.downloadedCount)} text messages stored, ${formatCount(job.mediaSkipped)} media-only skipped` +
    (goalCount === null ? '' : ` (${formatCount(processedCount)} / ${formatCount(goalCount)} search results)`);

  let statusLine = 'Starting download...';

  if (job.status === 'running') {
    statusLine = "Searching Discord for that user's messages...";
  } else if (job.status === 'queued') {
    statusLine = 'Waiting for an available download slot...';
  } else if (job.status === 'cancel_requested') {
    statusLine = 'Cancellation requested. Finishing the current request...';
  } else if (job.status === 'indexing') {
    statusLine = `Discord is still indexing searchable messages. Retrying in ${job.retryAfterSeconds}s...`;
  } else if (job.status === 'rate_limited') {
    statusLine = `Waiting ${job.retryAfterSeconds}s before retrying Discord search...`;
  } else if (job.status === 'cancelled') {
    statusLine = 'Download cancelled. Stored archive was left unchanged.';
  } else if (job.status === 'completed') {
    statusLine = job.incremental ? 'Download completed and archive updated.' : 'Download completed and archive replaced.';
  } else if (job.status === 'failed') {
    statusLine = `Download failed: ${job.errorMessage}`;
  }

  return [
    `**Download job for <@${job.targetUserId}>**`,
    statusLine,
    buildProgressBar(processedCount, goalCount),
    `Progress: ${progressLine}`,
    job.status === 'completed' && goalCount !== null && processedCount < goalCount
      ? 'Other empty search results were ignored.'
      : null,
    `Search requests: ${formatCount(job.requestsMade)}`,
    `Last page added: ${formatCount(job.lastPageCount)}`,
    job.status === 'indexing' ? `Indexed documents so far: ${formatCount(job.documentsIndexed)}` : null,
    'Source: Discord guild search API filtered by author ID',
    job.status === 'completed' || job.status === 'cancelled'
      ? null
      : 'The saved archive will only change if this download finishes successfully.',
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
            job.status !== 'queued' &&
            job.status !== 'starting' &&
            job.status !== 'indexing' &&
            job.status !== 'rate_limited' &&
            job.status !== 'cancel_requested'
          ),
        ),
    ),
  ];
}

export function createProgressPublisher(publish, now = Date.now) {
  const last = new Map();
  return (job, phase = 'progress') => {
    const time = now();
    if (phase === 'progress' && time - (last.get(job.id) ?? -Infinity) < 500) return;
    if (phase === 'progress') last.set(job.id, time);
    if (phase === 'finished') last.delete(job.id);
    publish({ type: phase, id: job.id, guildId: job.guildId, userId: job.targetUserId, status: job.status, downloadedCount: job.downloadedCount, mediaSkipped: job.mediaSkipped, totalResults: job.totalResults, retryAfterSeconds: job.retryAfterSeconds, currentMessage: job.currentMessage });
  };
}

export class DownloadJobManager extends EventEmitter {
  constructor({ client, config, store }) {
    super();
    this.client = client;
    this.config = config;
    this.store = store;
    this.jobs = new Map();
    this.jobsByTarget = new Map();
    this.runningCount = 0;
    this.pending = [];
    this.deletingUsers = new Set();
    this.searchRequest = createSearchLimiter(client.rest);
    this.publishProgress = createProgressPublisher(change => this.emit('change', change));
  }

  targetKey(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  getActiveJob(guildId, userId) {
    const jobId = this.jobsByTarget.get(this.targetKey(guildId, userId));
    return jobId ? this.jobs.get(jobId) ?? null : null;
  }

  createJob({ id = randomUUID(), guildId, requestedById, targetUserId, limit, channelIds = [], onProgress = null, resume = null }) {
    let resolveCompletion;

    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });

    return {
      id,
      resume,
      guildId,
      requestedById,
      targetUserId,
      limit,
      channelIds: [...channelIds],
      downloadedCount: 0,
      mediaSkipped: 0,
      totalResults: null,
      requestsMade: 0,
      lastPageCount: 0,
      retryAfterSeconds: 0,
      documentsIndexed: 0,
      currentMessage: null,
      status: 'starting',
      errorMessage: null,
      abortController: new AbortController(),
      progressMessage: null,
      lastRenderedAt: 0,
      onProgress,
      completion,
      resolveCompletion,
    };
  }

  getActiveJobs() {
    return [...this.jobs.values()].filter((job) => this.jobsByTarget.get(this.targetKey(job.guildId, job.targetUserId)) === job.id);
  }

  getActiveJobCount() {
    return this.getActiveJobs().length;
  }

  getJobStatus(guildId, userId) {
    return this.getActiveJob(guildId, userId);
  }

  cancelJob(guildId, userId) {
    const job = this.getActiveJob(guildId, userId);

    if (!job) {
      return { cancelled: false, reason: 'No active download found for that user.' };
    }

    if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') {
      return { cancelled: false, reason: 'That download is already finished.' };
    }

    job.status = 'cancel_requested';
    this.publishProgress(job, 'status');
    job.abortController.abort();
    const queuedIndex = this.pending.indexOf(job);
    if (queuedIndex !== -1) {
      this.pending.splice(queuedIndex, 1);
      void this.run(job);
    }

    void this.render(job, { force: true });

    return { cancelled: true, job };
  }

  async deleteUser(userId) {
    if (this.deletingUsers.has(userId)) throw new Error('User deletion already in progress.');
    this.deletingUsers.add(userId);
    try {
      const jobs = this.getActiveJobs().filter(job => job.targetUserId === userId);
      for (const job of jobs) this.cancelJob(job.guildId, userId);
      await Promise.all(jobs.map(job => job.completion));
      this.store.deleteUserData(userId);
    } finally {
      this.deletingUsers.delete(userId);
    }
  }

  async start({ interaction, targetUserId, limit }) {
    if (this.deletingUsers.has(targetUserId)) {
      await interaction.editReply({ content: 'This user is being deleted. Try again later.' });
      return null;
    }
    const existingJob = this.getActiveJob(interaction.guildId, targetUserId);

    if (existingJob) {
      await interaction.editReply({
        content: `${formatStatus(existingJob)}\n\nA download for this user is already running.`,
        components: buildComponents(existingJob),
      });
      return existingJob;
    }

    const job = this.createJob({
      guildId: interaction.guildId,
      requestedById: interaction.user.id,
      targetUserId,
      limit,
    });

    this.track(job);

    await interaction.editReply({
      content: formatStatus(job),
      components: buildComponents(job),
    });

    job.progressMessage = await interaction.fetchReply();

    this.schedule(job);

    return job;
  }

  startHeadless({ guildId, requestedById, targetUserId, limit, channelIds = [], onProgress }) {
    if (this.deletingUsers.has(targetUserId)) return { job: null, created: false };
    const existingJob = this.getActiveJob(guildId, targetUserId);

    if (existingJob) {
      return { job: existingJob, created: false };
    }

    const job = this.createJob({
      guildId,
      requestedById,
      targetUserId,
      limit,
      channelIds,
      onProgress,
    });

    this.track(job);
    this.schedule(job);

    return { job, created: true };
  }

  track(job) {
    this.jobs.set(job.id, job);
    this.jobsByTarget.set(this.targetKey(job.guildId, job.targetUserId), job.id);
    this.store.saveDownloadJob(job);
    this.publishProgress(job, 'created');
  }

  // Call once after login: restart jobs a previous process left unfinished.
  resumeSavedJobs() {
    for (const saved of this.store.getSavedDownloadJobs()) {
      if (this.getActiveJob(saved.guildId, saved.targetUserId)) { this.store.deleteDownloadJob(saved.id); continue; }
      const job = this.createJob(saved);
      if (saved.resume) {
        Object.assign(job, { downloadedCount: this.store.getStagedDownloadCount(job.id), mediaSkipped: saved.resume.mediaSkipped, totalResults: saved.resume.totalResults, requestsMade: saved.resume.requestsMade });
      }
      this.jobs.set(job.id, job);
      this.jobsByTarget.set(this.targetKey(job.guildId, job.targetUserId), job.id);
      this.publishProgress(job, 'created');
      this.schedule(job);
    }
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

    await interaction.deferUpdate();
    this.cancelJob(job.guildId, job.targetUserId);
    await this.render(job, { force: true });
    return true;
  }

  schedule(job) {
    if (this.runningCount >= this.store.getDownloadConcurrency()) {
      job.status = 'queued';
      this.pending.push(job);
      this.publishProgress(job, 'status');
      return;
    }
    this.runningCount++;
    void this.run(job).finally(() => {
      this.runningCount--;
      this.drain();
    });
  }

  drain() {
    while (this.pending.length && this.runningCount < this.store.getDownloadConcurrency()) {
      this.schedule(this.pending.shift());
    }
  }

  async run(job) {
    try {
      const result = await downloadUserHistory({
        client: this.client,
        guildId: job.guildId,
        targetUserId: job.targetUserId,
        channelIds: job.channelIds,
        limit: job.limit,
        store: this.store,
        jobId: job.id,
        signal: job.abortController.signal,
        searchRequest: this.searchRequest,
        resume: job.resume,
        onProgress: async ({
          status,
          downloadedCount,
          mediaSkipped,
          totalResults,
          requestsMade,
          lastPageCount,
          retryAfterSeconds = 0,
          documentsIndexed = 0,
          currentMessage = null,
        }) => {
          const oldStatus = job.status;
          if (!job.abortController.signal.aborted) job.status = status;
          job.downloadedCount = downloadedCount;
          job.mediaSkipped = mediaSkipped;
          job.totalResults = totalResults ?? job.totalResults;
          job.requestsMade = requestsMade;
          job.lastPageCount = lastPageCount;
          job.retryAfterSeconds = retryAfterSeconds;
          job.documentsIndexed = documentsIndexed;
          if (currentMessage) job.currentMessage = currentMessage;
          this.publishProgress(job, oldStatus === status ? 'progress' : 'status');

          await job.onProgress?.(job);
          await this.render(job);
        },
      });

      job.status = 'completed';
      job.downloadedCount = result.downloadedCount;
      job.mediaSkipped = result.mediaSkipped;
      job.incremental = result.incremental;
      job.totalResults = result.totalResults ?? job.totalResults;
      job.requestsMade = result.requestsMade;
      job.lastPageCount = 0;
      job.retryAfterSeconds = 0;
      job.documentsIndexed = 0;
      this.publishProgress(job, 'finished');

      await job.onProgress?.(job);
      await this.render(job, { force: true, disableButtons: true });
      job.resolveCompletion({ ok: true, job });
    } catch (error) {
      if (error instanceof DownloadCancelledError) {
        job.status = 'cancelled';
        this.publishProgress(job, 'finished');
        await job.onProgress?.(job);
        await this.render(job, { force: true, disableButtons: true });
        job.resolveCompletion({ ok: false, cancelled: true, job });
      } else {
        console.error(`Download job ${job.id} failed`, error);
        job.status = 'failed';
        job.errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.publishProgress(job, 'finished');
        await job.onProgress?.(job);
        await this.render(job, { force: true, disableButtons: true });
        job.resolveCompletion({ ok: false, cancelled: false, error, job });
      }
    } finally {
      this.store.deleteDownloadJob(job.id);
      this.jobsByTarget.delete(this.targetKey(job.guildId, job.targetUserId));
      this.jobs.delete(job.id);
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
