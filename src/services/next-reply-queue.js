import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export class NextReplyQueue extends EventEmitter {
  constructor() {
    super();
    this.entries = [];
  }

  enqueue({ message = '', image = null, targetUserId = null, createdByUserId }) {
    if (!message.trim() && !image) throw new RangeError('Supply a message or image.');
    const entry = {
      id: crypto.randomUUID(),
      message,
      image,
      targetUserId,
      createdByUserId,
      createdAt: new Date().toISOString(),
    };

    this.entries.push(entry);
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
    this.emit('change', { type: 'queue', id: entry.id });
    return entry;
  }

  remove(id) {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return null;
    const [entry] = this.entries.splice(index, 1);
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
