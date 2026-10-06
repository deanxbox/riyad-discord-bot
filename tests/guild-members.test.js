import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Collection, GatewayRateLimitError } from 'discord.js';
import { triviaCommand } from '../src/commands/trivia.js';
import { getGuildMembers } from '../src/services/guild-members.js';

test('trivia skips a full fetch when the guild cache is complete', async () => {
  const cache = new Collection([['1', 'Alice'], ['2', 'Bob'], ['3', 'Carol'], ['4', 'Dave']]
    .map(([id, name]) => [id, { id, displayName: name, user: { bot: false } }]));
  const guild = { id: 'complete', memberCount: 4, members: {
    cache, fetch: () => { throw Error('unexpected full fetch'); },
  } };
  let reply;
  await triviaCommand.execute({
    interaction: { guild, deferReply: async () => {}, editReply: async value => { reply = value; } },
    store: {
      getActiveTriviaQuestion: () => null,
      listTrackedUsers: () => ['1', '2', '3', '4'],
      getMessageCount: () => 1,
      getTriviaOptionCount: () => 4,
      getRandomMessage: () => 'hello',
      setActiveTriviaQuestion: () => {},
      restartTriviaClock: () => {},
    },
  });
  assert.equal(reply.components[0].components.length, 4);
});

test('incomplete guild fetch is shared in flight and isolated per guild', async () => {
  let complete;
  let fetches = 0;
  const first = { id: 'first', memberCount: 2, members: {
    cache: new Collection([['1', { id: '1' }]]),
    fetch: () => { fetches++; return new Promise(resolve => { complete = resolve; }); },
  } };
  const second = { id: 'second', memberCount: 0, members: {
    cache: new Collection(), fetch: () => { throw Error('unexpected fetch'); },
  } };
  const a = getGuildMembers(first);
  const b = getGuildMembers(first);
  assert.equal(fetches, 1);
  assert.equal(await getGuildMembers(second), second.members.cache);
  first.members.cache.set('2', { id: '2' });
  complete();
  assert.equal(await a, first.members.cache);
  assert.equal(await b, first.members.cache);
  assert.equal(await getGuildMembers(first), first.members.cache);
  assert.equal(fetches, 1);
});

test('only GatewayRateLimitError falls back to the current cache; other errors propagate', async () => {
  const cache = new Collection([['1', { id: '1' }]]);
  let error = new GatewayRateLimitError({ opcode: 8, retry_after: 1 }, {});
  let fetches = 0;
  const guild = { id: 'limited', memberCount: 3, members: {
    cache, fetch: async () => { fetches++; cache.set('2', { id: '2' }); throw error; },
  } };
  assert.equal(await getGuildMembers(guild), cache);
  assert.equal(cache.size, 2, 'rate-limited fetch keeps members received so far');
  error = new Error('gateway disconnected');
  await assert.rejects(getGuildMembers(guild), /gateway disconnected/);
  assert.equal(fetches, 2, 'an unsuccessful fetch can be retried');
  assert.equal(await getGuildMembers({ ...guild, memberCount: 1 }), cache);
});
