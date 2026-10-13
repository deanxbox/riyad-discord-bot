import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export class NextReplyQueue extends EventEmitter {
  constructor() {
    super();
    this.entries = [];
    this.totalBytes = 0;
  }

  enqueue({ message = '', image = null, targetUserId = null, createdByUserId }) {
    if (!message.trim() && !image) throw new RangeError('Supply a message or image.');
    const bytes = Buffer.byteLength(message, 'utf8') + (image?.data?.length ?? 0);
    if (this.entries.length >= 50 || this.totalBytes + bytes > 64 * 1024 * 1024) {
      throw new RangeError('Reply queue is full (50 entries or 64 MiB). Remove or consume replies before adding more.');
    }
    const entry = {
      id: crypto.randomUUID(),
      message,
      image,
      targetUserId,
      createdByUserId,
      createdAt: new Date().toISOString(),
      bytes,
    };

    this.entries.push(entry);
    this.totalBytes += bytes;
    this.emit('change', { type: 'queue', id: entry.id });
    return entry;
  }

  consume(targetUserId) {
    let index = this.entries.findIndex((entry) => entry.targetUserId === targetUserId);

    if (index === -1) {
      index = this.entries.findIndex((entry) => entry.targetUserId === null);
    }

    if (index === -1) {
      return null;
    }

    const [entry] = this.entries.splice(index, 1);
    this.totalBytes -= entry.bytes;
    this.emit('change', { type: 'queue', id: entry.id });
    return entry;
  }

  remove(id) {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return null;
    const [entry] = this.entries.splice(index, 1);
    this.totalBytes -= entry.bytes;
    this.emit('change', { type: 'queue', id: entry.id });
    return entry;
  }

  list() {
    return [...this.entries];
  }

  size() {
    return this.entries.length;
  }
}
