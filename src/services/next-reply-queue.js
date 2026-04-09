import crypto from 'node:crypto';

export class NextReplyQueue {
  constructor() {
    this.entries = [];
  }

  enqueue({ message, targetUserId = null, createdByUserId }) {
    const entry = {
      id: crypto.randomUUID(),
      message,
      targetUserId,
      createdByUserId,
      createdAt: new Date().toISOString(),
    };

    this.entries.push(entry);
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
    return entry;
  }

  list() {
    return [...this.entries];
  }

  size() {
    return this.entries.length;
  }
}
