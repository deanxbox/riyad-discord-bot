let state = null, stream = null, reconnectTimer = null, reconnectDelay = 1000, refreshTimer = null, selected = 'overview';
const selectedUsers = new Set();
const channelLoads = new WeakMap();
const $ = id => document.getElementById(id);
const api = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(['POST', 'PUT', 'DELETE'].includes(options.method) ? { 'X-Requested-With': 'dashboard' } : {}) } });
  if (response.status === 401 && url !== '/api/login') { showLogin(true); throw Error('Session expired'); }
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw Error(body.error || `Request failed (${response.status})`); }
  return response;
};
const request = (url, data, method = 'POST') => api(url, { method, body: JSON.stringify(data) });
const defaultAvatarUrl = 'https://cdn.discordapp.com/embed/avatars/0.png';
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); setTimeout(() => $('toast').classList.remove('show'), 2400); }
function fail(error) { $('error').textContent = error.message; toast(error.message); }
function node(tag, value, cls) { const el = document.createElement(tag); el.textContent = value ?? ''; if (cls) el.className = cls; return el; }
function avatar(user) {
  const img = document.createElement('img'); img.src = user?.avatarUrl || defaultAvatarUrl; img.alt = ''; img.className = 'avatar';
  img.onerror = () => { img.onerror = null; img.src = defaultAvatarUrl; };
  return img;
}
function person(user) { return user?.displayName || user?.username || user?.id || 'Unknown'; }
function showLogin(expired = false) {
  stream?.close(); stream = null; clearTimeout(refreshTimer); clearTimeout(reconnectTimer);
  if ($('drawer').open) $('drawer').close();
  $('app').hidden = true; $('login').hidden = false; state = null;
  if (expired) toast('Session expired');
}
async function connect() {
  await refresh();
  $('login').hidden = true; $('app').hidden = false;
  startLive();
}
function startLive() {
  stream?.close();
  $('live').textContent = 'Reconnecting';
  stream = new EventSource('/api/events');
  const current = stream;
  stream.onopen = () => {
    if (stream !== current) return;
    reconnectDelay = 1000; $('live').textContent = 'Live'; scheduleRefresh();
  };
  stream.onerror = async () => {
    if (stream !== current) return;
    current.close(); stream = null; $('live').textContent = 'Reconnecting';
    try {
      const response = await fetch('/api/session');
      if (response.status === 401) { showLogin(true); return; }
    } catch { /* retry on temporary network failure */ }
    reconnectTimer = setTimeout(startLive, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };
  for (const type of ['download', 'user', 'config', 'queue', 'trivia']) {
    stream.addEventListener(type, () => {
      if (selected === 'downloads' && type === 'download') scheduleRefresh();
      else if (selected === 'users' && (type === 'user' || type === 'download')) scheduleRefresh();
      else if (selected === 'overview' && ['config', 'user', 'download'].includes(type)) scheduleRefresh();
      else if (selected === type) scheduleRefresh();
    });
  }
  stream.addEventListener('stats', e => {
    if (!state) return;
    state.stats = JSON.parse(e.data);
    if (selected === 'overview') renderOverview();
  });
}
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => (selected === 'downloads' ? refreshJobs() : refresh()).catch(fail), 300); }
function nav(tab) {
  selected = tab; document.querySelectorAll('.nav[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === tab));
  $('title').textContent = tab[0].toUpperCase() + tab.slice(1);
  if (state) scheduleRefresh();
}
function fillSelect(select, guilds, preferred) {
  if (document.activeElement === select || [...select.options].map(o => `${o.value}:${o.textContent}`).join('|') === guilds.map(g => `${g.id}:${g.name}`).join('|')) return;
  const prior = select.value || preferred; select.replaceChildren(...guilds.map(g => { const o = node('option', g.name); o.value = g.id; return o; }));
  if (guilds.some(g => g.id === prior)) select.value = prior;
}
function selectedChannelIds(picker) {
  if (picker.disabled) throw Error('Wait for the channel list to finish loading.');
  const checks = [...picker.querySelectorAll('input[type="checkbox"]')];
  const selected = checks.filter(check => check.checked).map(check => check.value);
  if (!selected.length) throw Error('Select at least one channel.');
  return selected.length === checks.length ? undefined : selected;
}
function renderChannelPicker(picker, channels) {
  const filterLabel = node('label', 'Filter channels', 'channel-filter');
  const filter = node('input'); filter.type = 'search'; filter.placeholder = 'Name or category';
  filterLabel.append(filter);
  const controls = node('div', '', 'channel-controls'), all = node('button', 'Select all'), clear = node('button', 'Clear');
  all.type = clear.type = 'button';
  const summary = node('span', '', 'channel-summary'); summary.setAttribute('role', 'status');
  controls.append(all, clear, summary);
  const list = node('div', '', 'channel-list'), groups = new Map(), checks = [];
  for (const channel of channels) {
    if (!groups.has(channel.categoryId)) {
      const group = node('section', '', 'channel-group');
      group.append(node('h3', channel.categoryName || 'Uncategorised'));
      groups.set(channel.categoryId, group); list.append(group);
    }
    const row = node('label', '', 'channel-option'), check = node('input');
    check.type = 'checkbox'; check.value = channel.id; check.checked = true;
    row.dataset.search = `${channel.name} ${channel.categoryName || 'Uncategorised'}`.toLowerCase();
    row.append(check, node('span', `# ${channel.name}`));
    groups.get(channel.categoryId).append(row); checks.push(check);
  }
  const empty = node('p', channels.length ? 'No matching channels.' : 'No readable text channels in this server.', 'empty-state');
  empty.hidden = channels.length > 0; list.append(empty);
  const updateSummary = () => {
    const count = checks.filter(check => check.checked).length;
    summary.textContent = count && count === checks.length ? 'All channels' : `${count} of ${checks.length} selected`;
  };
  list.onchange = updateSummary;
  all.onclick = () => { checks.forEach(check => { check.checked = true; }); updateSummary(); };
  clear.onclick = () => { checks.forEach(check => { check.checked = false; }); updateSummary(); };
  filter.oninput = () => {
    const query = filter.value.trim().toLowerCase();
    for (const group of groups.values()) {
      const rows = [...group.querySelectorAll('.channel-option')];
      rows.forEach(row => { row.hidden = !row.dataset.search.includes(query); });
      group.hidden = rows.every(row => row.hidden);
    }
    empty.hidden = [...groups.values()].some(group => !group.hidden);
  };
  all.disabled = clear.disabled = filter.disabled = !channels.length;
  picker.replaceChildren(picker.querySelector('legend'), filterLabel, controls, list);
  updateSummary();
}
async function loadChannels(guildSelect, picker) {
  const guildId = guildSelect.value;
  if (picker.dataset.guildId === guildId) return;
  const sequence = (channelLoads.get(picker) || 0) + 1;
  channelLoads.set(picker, sequence);
  picker.dataset.guildId = guildId;
  picker.disabled = true;
  picker.replaceChildren(picker.querySelector('legend'), node('p', guildId ? 'Loading channels…' : 'Select a server to load channels.', 'empty-state'));
  if (!guildId) return;
  let channels;
  try { ({ channels } = await (await api(`/api/guilds/${encodeURIComponent(guildId)}/channels`)).json()); }
  catch (error) {
    if (channelLoads.get(picker) !== sequence) return;
    delete picker.dataset.guildId;
    picker.replaceChildren(picker.querySelector('legend'), node('p', 'Could not load channels. Refresh to retry.', 'empty-state'));
    throw error;
  }
  if (channelLoads.get(picker) !== sequence) return;
  renderChannelPicker(picker, channels);
  picker.disabled = false;
}
function renderUsers() {
  const list = $('user-list'), query = $('search').value.toLowerCase(), sort = $('sort').value;
  for (const id of selectedUsers) if (!state.users.some(u => u.user.id === id)) selectedUsers.delete(id);
  const users = state.users.filter(u => `${person(u.user)} ${u.user.id}`.toLowerCase().includes(query));
  users.sort((a,b) => sort === 'count' ? b.messageCount-a.messageCount : sort === 'last' ? String(b.lastDownloadedAt||'').localeCompare(String(a.lastDownloadedAt||'')) : person(a.user).localeCompare(person(b.user)));
  list.replaceChildren(...users.map(u => {
    const row = document.createElement('div'); row.className = 'user-row';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selectedUsers.has(u.user.id); check.dataset.userId = u.user.id; check.setAttribute('aria-label', `Select ${person(u.user)}`);
    check.onchange = () => { if (check.checked) selectedUsers.add(u.user.id); else selectedUsers.delete(u.user.id); updateSelection(users); };
    row.append(check, avatar(u.user));
    const main = document.createElement('div'); main.className = 'user-main'; main.append(node('strong', person(u.user)), node('small', `${u.messageCount} text stored · ${u.lastDownloadedAt ? new Date(u.lastDownloadedAt).toLocaleString() : 'Never downloaded'} · ${u.user.id}`)); main.title = `${person(u.user)} · ${u.user.id}`;
    main.append(sourceChips(u));
    const status = document.createElement('div'); status.className = 'user-status';
    status.append(node('span', `${u.mediaSkipped} media-only skipped`, 'badge'), node('span', u.tracked ? 'Tracked' : 'Not tracked', `badge ${u.tracked ? 'green' : ''}`));
    if (u.nerded) status.append(node('span', 'Nerded', 'badge'));
    row.append(main, status);
    const open = node('button', 'Manage'); open.onclick = () => showUser(u); row.append(open); return row;
  }));
  updateSelection(users);
  if (!users.length) list.append(node('p', query ? 'No users match this search.' : 'No users to manage yet.', 'empty-state'));
}
function sourceName(source) { return source.guildName || (source.guildId ? `Unknown server (${source.guildId})` : source.legacy ? 'Legacy import (no server recorded)' : 'Server not recorded'); }
function sourceChips(u) {
  const chips = node('div', '', 'source-chips');
  chips.append(node('small', 'Downloaded from:'));
  if (!u.downloadedFrom?.length) { chips.append(node('span', 'No messages yet', 'badge')); return chips; }
  for (const source of u.downloadedFrom) {
    const chip = node('span', `${sourceName(source)} · ${source.count}`, 'badge source');
    chip.title = `${source.count} stored messages from ${sourceName(source)}`; chips.append(chip);
  }
  return chips;
}
function attachLookup(input, type) {
  const field = input.closest('label') || input.parentElement; field.classList.add('lookup-field');
  const results = node('div', '', 'member-results'); results.setAttribute('aria-live', 'polite'); field.append(results);
  let timer, sequence = 0;
  const clear = () => { clearTimeout(timer); sequence++; results.replaceChildren(); };
  input.addEventListener('input', () => {
    clear();
    const query = input.value.trim(), current = sequence;
    if (!query || /^\d{17,20}$/.test(query) || query.length > 64 || (type === 'user' && query.length < 2)) return;
    timer = setTimeout(async () => {
      try {
        const data = await (await api(`/api/lookup?type=${type}&query=${encodeURIComponent(query)}`)).json();
        if (current !== sequence) return;
        results.replaceChildren(...data.results.map(item => {
          const button = node('button', '', 'member-option'); button.type = 'button';
          const id = item.user?.id ?? item.id;
          if (item.user) button.append(avatar(item.user), node('span', `${person(item.user)} · ${item.user.username} · ${id}`));
          else button.append(node('span', `${item.name}${item.guildName ? ` · ${item.guildName}` : ''} · ${id}`));
          button.onclick = () => { clear(); input.value = id; input.dispatchEvent(new Event('input', { bubbles: true })); results.replaceChildren(); };
          return button;
        }));
        if (!data.results.length) results.append(node('p', 'No matches the bot can see.', 'muted'));
      } catch (error) { if (current === sequence) results.replaceChildren(node('p', error.message, 'muted')); }
    }, 350);
  });
}
function updateSelection(users) {
  const count = users.filter(u => selectedUsers.has(u.user.id)).length;
  $('selection-count').textContent = `${count} selected`;
  $('select-visible').checked = Boolean(users.length && count === users.length);
  $('select-visible').indeterminate = count > 0 && count < users.length;
  $('bulk-download').disabled = $('bulk-delete').disabled = !count;
}
const visibleSelectedIds = () => [...$('user-list').querySelectorAll('input[type="checkbox"]:checked')].map(input => input.dataset.userId);
function renderJobs(jobs) {
  $('job-list').replaceChildren(...jobs.map(j => {
    const row = document.createElement('div'); row.className = 'user-row';
    const main = document.createElement('div'); main.className = 'user-main';
    const goal = j.limit === null ? j.totalResults : Math.min(j.limit, j.totalResults ?? j.limit);
    main.append(node('strong', person(j.target)), node('span', j.status.replace(/_/g, ' '), `badge st-${j.status}`), node('small', `${j.downloadedCount} text messages stored, ${j.mediaSkipped} media-only skipped · ${j.downloadedCount + j.mediaSkipped} / ${goal ?? '…'} search results · requested by ${person(j.requestedBy)}`));
    if (j.retryAfterSeconds && ['indexing', 'rate_limited'].includes(j.status)) main.append(node('small', `Waiting ${j.retryAfterSeconds}s for Discord`));
    if (j.currentMessage) main.append(node('small', `${j.currentMessage.author} · ${j.currentMessage.timestamp ? new Date(j.currentMessage.timestamp).toLocaleString() : 'Unknown time'} · ${j.currentMessage.content || '[media-only]'}`, 'job-preview'));
    const cancel = node('button', 'Cancel'); cancel.onclick = async () => { try { await api(`/api/downloads/${j.guildId}/${j.target.id}`, { method: 'DELETE' }); await refresh(); } catch (e) { fail(e); } };
    row.append(main, cancel); return row;
  }));
  if (!jobs.length) $('job-list').append(node('p', 'No active downloads.', 'empty-state'));
}
async function showUser(u) {
  if (!u?.user?.id) return;
  const dialog = $('drawer'), body = $('drawer-body'); body.replaceChildren();
  const summary = node('div', '', 'drawer-summary');
  summary.append(avatar(u.user), node('div', u.user.id, 'drawer-user-id'));
  const stats = node('div', '', 'drawer-stats');
  for (const [label, value] of [['Stored messages', u.messageCount], ['Media-only skipped', u.mediaSkipped]]) {
    const stat = node('div', '', 'drawer-stat'); stat.append(node('small', label), node('strong', value)); stats.append(stat);
  }
  const settings = node('section', '', 'drawer-section');
  settings.append(node('h3', 'Reply settings'));
  const actions = node('div', '', 'drawer-settings');
  const toggle = (label, key) => { const l = node('label', '', 'drawer-toggle'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = u[key]; l.append(input, document.createTextNode(label)); actions.append(l); return input; };
  const tracked = toggle('Tracked', 'tracked'), nerded = toggle('Nerded', 'nerded');
  const chanceLabel = node('label', 'Reply chance override (%)', 'drawer-chance'); const chance = document.createElement('input'); chance.type = 'number'; chance.min = '0'; chance.max = '100'; chance.placeholder = 'Inherit'; chance.value = u.replyChanceOverride ?? ''; chanceLabel.append(chance); actions.append(chanceLabel);
  const save = node('button', 'Save changes', 'primary'); save.onclick = async () => { try { await request(`/api/users/${u.user.id}`, { tracked: tracked.checked, nerded: nerded.checked, replyChanceOverride: chance.value === '' ? null : Number(chance.value) }); await refresh(); showUser(state.users.find(x => x.user.id === u.user.id) || u); toast('User updated'); } catch (e) { fail(e); } };
  const random = node('button', 'View random stored line'); random.onclick = async () => { try { const data = await (await api(`/api/users/${u.user.id}/random`)).json(); alert(data.message ? `${data.message.created_at}\n\n${data.message.content}` : 'No stored lines.'); } catch (e) { fail(e); } };
  const exportButton = node('button', 'Export .txt'); exportButton.onclick = async () => { try { const blob = await (await api(`/api/users/${u.user.id}/export`)).blob(), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${u.user.id}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); } catch (e) { fail(e); } };
  const download = node('button', 'Re-download'); download.onclick = async () => { try { const guildId = $('users-guild').value, channelIds = selectedChannelIds($('users-channels')), rawLimit = $('download-limit').value; await request('/api/downloads', { userId: u.user.id, guildId, channelIds, limit: rawLimit ? Number(rawLimit) : null }); dialog.close(); nav('downloads'); await refresh(); toast('Download started'); } catch (error) { fail(error); } };
  const del = node('button', 'Delete user entirely', 'danger'); del.onclick = async () => { if (!confirm(`Permanently delete all saved data for ${person(u.user)} and cancel their downloads?`)) return; try { await api(`/api/users/${u.user.id}`, { method: 'DELETE' }); await refresh(); dialog.close(); toast('User deleted'); } catch (e) { fail(e); } };
  settings.append(actions, save);
  const sources = node('section', '', 'drawer-section'); sources.append(node('h3', 'Downloaded from'));
  if (u.downloadedFrom?.length) { const list = node('div', '', 'source-chips'); for (const source of u.downloadedFrom) list.append(node('span', `${sourceName(source)} · ${source.count} messages`, 'badge source')); sources.append(list); }
  else sources.append(node('p', 'No stored messages yet.', 'muted'));
  const tools = node('section', '', 'drawer-section'); tools.append(node('h3', 'Stored messages'));
  const toolButtons = node('div', '', 'drawer-tools'); toolButtons.append(random, exportButton, download); tools.append(toolButtons);
  const danger = node('section', '', 'drawer-section drawer-danger'); danger.append(node('h3', 'Danger zone'), del);
  body.append(summary, stats, sources, settings, tools, danger);
  $('drawer-title').textContent = person(u.user); $('drawer-title').title = person(u.user); dialog.showModal();
}
function renderOverview() {
  $('stats').replaceChildren(...[['Tracked users', state.stats.tracked], ['Stored messages', state.stats.storedMessages], ['Media-only skipped', state.stats.mediaSkipped], ['Active downloads', state.stats.activeDownloads], ['Gateway ping', state.stats.ping == null ? '—' : `${state.stats.ping} ms`]].map(([label,value]) => { const c = document.createElement('article'); c.className='stat'; c.append(node('small',label),node('strong',value)); return c; }));
  $('glance').replaceChildren(...[`Reply chance ${state.replyChancePercent}%`,`Reaction 1 in ${state.reactionChanceDenominator}`,`Uptime ${Math.floor(state.stats.uptime/3600)}h`, `Always reply: ${person(state.alwaysReplyUser)}`].map(x=>node('span',x,'pill')));
}
function render(stateData) {
  state = stateData;
  if (selected === 'overview') renderOverview();
  const form = $('config-form');
  if (selected === 'config') {
    if (!form.dataset.editing) for (const [key, value] of Object.entries({ replyChancePercent: state.replyChancePercent, reactionChanceDenominator: state.reactionChanceDenominator, downloadConcurrency: state.downloadConcurrency, triviaOptionCount: state.triviaOptionCount, triviaTimeoutSeconds: state.triviaTimeoutSeconds, triviaBonusSeconds: state.triviaBonusSeconds, replyDelaySeconds: state.replyDelaySeconds, alwaysReplyUserId: state.alwaysReplyUser.id, nerdEmoji: state.nerdEmoji, specialUserId: state.specialUser.id, specialRoleId: state.specialRoleId, guildId: state.guildId || '' })) if (document.activeElement !== form.elements[key]) form.elements[key].value = value;
    if (!form.dataset.editing) form.elements.typingIndicator.checked = !!state.typingIndicator;
    if (!form.dataset.editing) {
      document.querySelector('[data-resolved="alwaysReplyUserId"]').textContent = person(state.alwaysReplyUser);
      document.querySelector('[data-resolved="specialUserId"]').textContent = person(state.specialUser);
      document.querySelector('[data-resolved="specialRoleId"]').textContent = state.specialRole;
      document.querySelector('[data-resolved="guildId"]').textContent = state.guildName || '';
    }
  }
  fillSelect($('download-guild'), state.guilds, state.guildId); fillSelect($('users-guild'), state.guilds, state.guildId); fillSelect($('trivia-guild'), state.guilds, state.guildId); fillSelect($('queue-guild'), state.guilds, state.guildId);
  void loadChannels($('download-guild'), $('download-channels')).catch(fail);
  void loadChannels($('users-guild'), $('users-channels')).catch(fail);
  if (selected === 'users') renderUsers();
  if (selected === 'downloads') renderJobs(state.jobs);
  if (selected === 'queue') {
    $('queue-list').replaceChildren(...state.queue.map(q => {
      const row = node('div', '', 'user-row'), main = node('div', '', 'user-main');
      main.append(node('small', `${person(q.createdBy)} queued for ${q.target ? person(q.target) : 'any user'}`), node('p', q.message, 'queue-message'));
      if (q.hasImage) main.append(node('small', `Image · ${q.image.name}`, 'queue-image-name'));
      const remove = node('button', 'Remove');
      remove.setAttribute('aria-label', `Remove queued reply for ${q.target ? person(q.target) : 'any user'}`);
      remove.onclick = async () => {
        remove.disabled = true;
        try { await api(`/api/queue/${encodeURIComponent(q.id)}`, { method: 'DELETE' }); await refresh(); toast('Reply removed'); }
        catch (error) { fail(error); remove.disabled = false; }
      };
      row.append(main, remove); return row;
    }));
    if (!state.queue.length) $('queue-list').append(node('p', 'No replies queued.', 'empty-state'));
  }
  if (selected === 'trivia') {
    $('scores').replaceChildren(...state.leaderboard.map((s, i) => {
      const item = node('li', '', 'score-row');
      const identity = node('span', '', 'score-user'), names = node('span', '', 'score-names');
      names.append(node('strong', person(s.user)));
      if (s.user?.username && s.user.username !== person(s.user)) names.append(node('small', `@${s.user.username}`));
      identity.append(avatar(s.user), names);
      item.append(node('span', `#${i + 1}`, 'score-rank'), identity, node('span', `${s.score} ${s.score === 1 ? 'point' : 'points'} · ${s.wins}W/${s.losses}L${s.ratio == null ? '' : ` (${s.ratio.toFixed(2)})`}${s.streak >= 3 ? ` · 🔥 ${s.streak} win streak` : s.streak <= -3 ? ` · 🧊 ${-s.streak} loss streak` : ''}`, 'score-points'));
      return item;
    }));
    const rec = state.triviaRecords || {}, name = r => person(r.user);
    $('trivia-records').textContent = [rec.winStreak && `🔥 Best win streak: ${rec.winStreak.value} (${name(rec.winStreak)})`, rec.lossStreak && `🧊 Worst loss streak: ${rec.lossStreak.value} (${name(rec.lossStreak)})`, rec.firstGuesses && `⚡ Fastest most often: ${name(rec.firstGuesses)} (${rec.firstGuesses.value}x)`].filter(Boolean).join('  ·  ');
    if (!state.leaderboard.length) $('scores').append(node('li', 'No trivia scores for this server yet.', 'empty-state'));
  }
}
async function refresh() {
  const guildId = selected === 'trivia' ? $('trivia-guild').value : $('download-guild').value;
  const userId = $('download-user').value;
  const data = await (await api(`/api/state?guildId=${encodeURIComponent(guildId || '')}&userId=${encodeURIComponent(userId)}&sort=${$('trivia-sort').value}`)).json();
  const x = window.scrollX, y = window.scrollY;
  render(data);
  window.scrollTo(x, y);
}
async function refreshJobs() {
  const result = await (await api('/api/downloads')).json();
  if (!state) return;
  const x = window.scrollX, y = window.scrollY;
  state.jobs = result.jobs; state.stats.activeDownloads = result.jobs.length;
  if (selected === 'downloads') renderJobs(result.jobs);
  window.scrollTo(x, y);
}
$('connect').onclick = async () => {
  const token = $('token').value; $('token').value = '';
  try { await request('/api/login', { token }); await connect(); toast('Connected'); }
  catch (e) { fail(e); }
};
$('logout').onclick = async () => { try { await api('/api/logout', { method: 'POST' }); showLogin(); } catch (e) { fail(e); } };
fetch('/api/session').then(async response => {
  if (response.ok) await connect();
  else if (response.status === 401) showLogin();
  else throw Error('Could not check session.');
}).catch(fail);
$('refresh').onclick = () => refresh().catch(fail);
document.querySelectorAll('.nav').forEach(b => b.addEventListener('click', () => nav(b.dataset.tab)));
$('search').addEventListener('input', () => state && renderUsers()); $('sort').onchange = () => state && renderUsers();
$('select-visible').onchange = () => {
  for (const input of $('user-list').querySelectorAll('input[type="checkbox"]')) input.checked = $('select-visible').checked;
  const query = $('search').value.toLowerCase();
  for (const u of state.users.filter(u => `${person(u.user)} ${u.user.id}`.toLowerCase().includes(query))) {
    if ($('select-visible').checked) selectedUsers.add(u.user.id); else selectedUsers.delete(u.user.id);
  }
  renderUsers();
};
async function bulk(action) {
  const userIds = visibleSelectedIds();
  if (!userIds.length || !confirm(`${action === 'delete' ? 'Permanently delete all data and cancel downloads for' : 'Download messages for'} ${userIds.length} selected users?`)) return;
  try {
    const data = { action, userIds };
    if (action === 'download') Object.assign(data, { guildId: $('users-guild').value, channelIds: selectedChannelIds($('users-channels')) });
    const result = await (await request('/api/users/bulk', data)).json();
    selectedUsers.clear();
    await refresh();
    toast(action === 'delete' ? `${result.deleted} users deleted` : `${result.started} downloads started, ${result.skipped} skipped`);
    if (action === 'download') nav('downloads');
  } catch (error) { fail(error); }
}
$('bulk-download').onclick = () => bulk('download');
$('bulk-delete').onclick = () => bulk('delete');
$('download-form').onsubmit = async e => { e.preventDefault(); try { await request('/api/downloads', { userId: $('download-user').value, guildId: $('download-guild').value, channelIds: selectedChannelIds($('download-channels')), limit: $('download-limit').value ? Number($('download-limit').value) : null }); toast('Download started'); await refresh(); nav('downloads'); } catch (error) { fail(error); } };
function bindMemberPicker(guildSelect, search, userIdInput, results) {
  let timer, sequence = 0;
  const clearResults = () => { clearTimeout(timer); sequence++; results.replaceChildren(); };
  const clear = () => { clearResults(); search.value = ''; userIdInput.value = ''; };
  guildSelect.addEventListener('change', clear);
  userIdInput.addEventListener('input', () => { clearResults(); search.value = ''; });
  search.addEventListener('input', () => {
    clearResults();
    const query = search.value.trim(), guildId = guildSelect.value, current = sequence;
    userIdInput.value = '';
    if (!guildId || query.length < 2 || query.length > 64) return;
    timer = setTimeout(async () => {
      try {
        const { members } = await (await api(`/api/members?guildId=${encodeURIComponent(guildId)}&query=${encodeURIComponent(query)}`)).json();
        if (current !== sequence) return;
        results.replaceChildren(...members.map(member => {
          const button = node('button', '', 'member-option'); button.type = 'button';
          button.append(avatar(member), node('span', `${person(member)} · ${member.username} · ${member.id}`));
          button.onclick = () => { userIdInput.value = member.id; search.value = person(member); clearResults(); };
          return button;
        }));
        if (!members.length) results.append(node('p', 'No matching members in this server.', 'muted'));
      } catch (error) {
        if (current === sequence) results.replaceChildren(node('p', error.message, 'muted'));
      }
    }, 350);
  });
  return clear;
}
bindMemberPicker($('download-guild'), $('member-search'), $('download-user'), $('member-results'));
const clearQueueTarget = bindMemberPicker($('queue-guild'), $('queue-member-search'), $('queue-user'), $('queue-member-results'));
$('queue-clear-user').onclick = clearQueueTarget;
let queueImageUrl = null;
function checkQueueImage(file) {
  if (file && (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) || !file.size || file.size > 8 * 1024 * 1024)) throw Error('Choose a PNG, JPEG, GIF or WebP image up to 8 MiB.');
}
function clearQueueImage() {
  if (queueImageUrl) URL.revokeObjectURL(queueImageUrl);
  queueImageUrl = null; $('queue-image').value = ''; $('queue-image-preview').hidden = true;
  $('queue-image-thumbnail').removeAttribute('src'); $('queue-image-name').textContent = '';
}
$('queue-remove-image').onclick = clearQueueImage;
$('queue-image').onchange = () => {
  const file = $('queue-image').files[0];
  try {
    checkQueueImage(file);
    if (queueImageUrl) URL.revokeObjectURL(queueImageUrl);
    queueImageUrl = file ? URL.createObjectURL(file) : null;
    $('queue-image-preview').hidden = !file;
    if (file) $('queue-image-thumbnail').src = queueImageUrl;
    else $('queue-image-thumbnail').removeAttribute('src');
    $('queue-image-name').textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MiB` : '';
  } catch (error) { clearQueueImage(); fail(error); }
};
$('queue-form').onsubmit = async e => {
  e.preventDefault(); $('queue-add').disabled = $('queue-image').disabled = $('queue-remove-image').disabled = true;
  try {
    if ($('queue-member-search').value.trim() && !$('queue-user').value) throw Error('Select a member from the results, paste their Discord ID, or clear the target for any user.');
    const file = $('queue-image').files[0], data = { message: $('queue-message').value, targetUserId: $('queue-user').value || null };
    checkQueueImage(file);
    if (!data.message.trim() && !file) throw Error('Add a message or image.');
    if (file) {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(Error('Could not read the image.'));
        reader.readAsDataURL(file);
      });
      data.image = { name: file.name, contentType: file.type, data: base64 };
    }
    await request('/api/queue', data);
    $('queue-message').value = ''; clearQueueTarget(); clearQueueImage(); await refresh(); toast('Reply queued');
  } catch (error) { fail(error); }
  finally { $('queue-add').disabled = $('queue-image').disabled = $('queue-remove-image').disabled = false; }
};
$('download-guild').addEventListener('change', () => void loadChannels($('download-guild'), $('download-channels')).catch(fail));
$('users-guild').addEventListener('change', () => void loadChannels($('users-guild'), $('users-channels')).catch(fail));
$('refresh-all').onclick = async () => { if (!confirm('Refresh every tracked user in this server, sequentially?')) return; try { await request('/api/refresh-all', { guildId: $('download-guild').value, channelIds: selectedChannelIds($('download-channels')), limit: $('download-limit').value ? Number($('download-limit').value) : null }); toast('Refresh queued'); await refresh(); nav('downloads'); } catch (e) { fail(e); } };
$('trivia-guild').addEventListener('change', () => refresh().catch(fail));
$('trivia-sort').addEventListener('change', () => refresh().catch(fail));
$('config-form').addEventListener('input', e => { if (e.target.form === $('config-form')) $('config-form').dataset.editing = 'true'; });
$('config-form').onsubmit = async e => { e.preventDefault(); const form=e.currentTarget; try { for (const key of ['specialUserId','specialRoleId']) if (form.elements[key].value !== (key === 'specialUserId' ? state.specialUser.id : state.specialRoleId) && !confirm(`Change ${key}? This can lock you out of admin controls. Continue?`)) return; for (const key of ['replyChancePercent','reactionChanceDenominator','downloadConcurrency','triviaOptionCount','triviaTimeoutSeconds','triviaBonusSeconds','replyDelaySeconds','typingIndicator','alwaysReplyUserId','nerdEmoji','specialUserId','specialRoleId','guildId']) { const raw=form.elements[key].value; if (key==='typingIndicator') { await request('/api/settings',{typingIndicator:form.elements[key].checked}); continue; } await request('/api/settings',{[key]:['replyChancePercent','reactionChanceDenominator','downloadConcurrency','triviaOptionCount','triviaTimeoutSeconds','triviaBonusSeconds','replyDelaySeconds'].includes(key)?Number(raw):key==='guildId'&&!raw?null:raw}); } form.dataset.editing = ''; await refresh(); toast('Configuration saved'); } catch (error) { fail(error); } };
$('config-form').elements.alwaysReplyUserId.addEventListener('input', e => resolveInput(e.target, 'user'));
$('config-form').elements.specialUserId.addEventListener('input', e => resolveInput(e.target, 'user'));
$('config-form').elements.specialRoleId.addEventListener('input', e => resolveInput(e.target, 'role'));
function resolveInput(input, type) {
  clearTimeout(input.resolveTimer);
  const output = document.querySelector(`[data-resolved="${input.name}"]`);
  input.resolveTimer = setTimeout(async () => {
    if (!/^\d{17,20}$/.test(input.value)) { output.textContent = ''; return; }
    try { const result = await (await api(`/api/resolve?id=${input.value}&type=${type}`)).json(); output.textContent = type === 'role' ? result.name : person(result.user); } catch { output.textContent = ''; }
  }, 350);
}
$('backup').onclick = async () => { try { const blob=await (await api('/api/backup')).blob(), a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='bot-backup.sqlite'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),30000); } catch(e) { fail(e); } };
for (const [name, type] of [['alwaysReplyUserId', 'user'], ['specialUserId', 'user'], ['specialRoleId', 'role'], ['guildId', 'guild']]) attachLookup($('config-form').elements[name], type);
attachLookup($('add-user-id'), 'user');
$('addUser').onclick = () => { $('add-user-id').value = ''; $('add-user-dialog').showModal(); };
$('add-user-cancel').onclick = () => $('add-user-dialog').close();
$('add-user-form').onsubmit = async e => { e.preventDefault(); const id = $('add-user-id').value.trim(); if (!/^\d{17,20}$/.test(id)) { fail(Error('Pick a user or enter a valid Discord ID.')); return; } $('add-user-dialog').close(); try { await request(`/api/users/${id}`,{tracked:true}); await refresh(); nav('users'); showUser(state.users.find(u=>u.user.id===id) || { user: { id, username:id, displayName:id, avatarUrl:null }, tracked:true, nerded:false, replyChanceOverride:null, messageCount:0, mediaSkipped:0 }); } catch(e) { fail(e); } };
