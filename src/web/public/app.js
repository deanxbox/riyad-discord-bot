let state = null, poller = null, stream = null, refreshTimer = null, selected = 'overview';
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
  stream?.close(); stream = null; clearTimeout(refreshTimer); clearInterval(poller); poller = null;
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
  stream.onopen = () => { $('live').textContent = 'Live'; updateFallback(); };
  stream.onerror = async () => {
    if (stream !== current) return;
    $('live').textContent = 'Reconnecting'; updateFallback();
    try { const response = await fetch('/api/session'); if (stream === current && response.status === 401) showLogin(true); } catch { /* temporary network failure; EventSource retries */ }
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
  updateFallback();
}
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => (selected === 'downloads' ? refreshJobs() : refresh()).catch(fail), 300); }
function updateFallback() {
  clearInterval(poller);
  poller = selected === 'downloads' && stream?.readyState !== EventSource.OPEN
    ? setInterval(() => refreshJobs().catch(fail), 15000) : null;
}
function nav(tab) {
  selected = tab; document.querySelectorAll('.nav[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === tab));
  $('title').textContent = tab[0].toUpperCase() + tab.slice(1); updateFallback();
  if (state) scheduleRefresh();
}
function fillSelect(select, guilds, preferred) {
  if (document.activeElement === select || [...select.options].map(o => `${o.value}:${o.textContent}`).join('|') === guilds.map(g => `${g.id}:${g.name}`).join('|')) return;
  const prior = select.value || preferred; select.replaceChildren(...guilds.map(g => { const o = node('option', g.name); o.value = g.id; return o; }));
  if (guilds.some(g => g.id === prior)) select.value = prior;
}
function renderUsers() {
  const list = $('user-list'), query = $('search').value.toLowerCase(), sort = $('sort').value;
  const users = state.users.filter(u => `${person(u.user)} ${u.user.id}`.toLowerCase().includes(query));
  users.sort((a,b) => sort === 'count' ? b.messageCount-a.messageCount : sort === 'last' ? String(b.lastDownloadedAt||'').localeCompare(String(a.lastDownloadedAt||'')) : person(a.user).localeCompare(person(b.user)));
  list.replaceChildren(...users.map(u => {
    const row = document.createElement('div'); row.className = 'user-row'; row.append(avatar(u.user));
    const main = document.createElement('div'); main.className = 'user-main'; main.append(node('strong', person(u.user)), node('small', `${u.messageCount} text stored · ${u.lastDownloadedAt ? new Date(u.lastDownloadedAt).toLocaleString() : 'Never downloaded'} · ${u.user.id}`)); main.title = `${person(u.user)} · ${u.user.id}`;
    const status = document.createElement('div'); status.className = 'user-status';
    status.append(node('span', `${u.mediaSkipped} media-only skipped`, 'badge'), node('span', u.tracked ? 'Tracked' : 'Not tracked', `badge ${u.tracked ? 'green' : ''}`));
    if (u.nerded) status.append(node('span', 'Nerded', 'badge'));
    row.append(main, status);
    const open = node('button', 'Manage'); open.onclick = () => showUser(u); row.append(open); return row;
  }));
  if (!users.length) list.append(node('p', query ? 'No users match this search.' : 'No users to manage yet.', 'empty-state'));
}
function renderJobs(jobs) {
  $('job-list').replaceChildren(...jobs.map(j => {
    const row = document.createElement('div'); row.className = 'user-row';
    const main = document.createElement('div'); main.className = 'user-main';
    const goal = j.limit === null ? j.totalResults : Math.min(j.limit, j.totalResults ?? j.limit);
    main.append(node('strong', person(j.target)), node('small', `${j.status} · ${j.downloadedCount} text messages stored, ${j.mediaSkipped} media-only skipped · ${j.downloadedCount + j.mediaSkipped} / ${goal ?? '…'} search results · requested by ${person(j.requestedBy)}`));
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
  const download = node('button', 'Re-download'); download.onclick = () => { nav('downloads'); $('download-user').value = u.user.id; $('member-search').value = person(u.user); $('member-results').replaceChildren(); dialog.close(); $('download-form').requestSubmit(); };
  const del = node('button', 'Delete stored messages', 'danger'); del.onclick = async () => { if (!confirm(`Delete all stored messages for ${person(u.user)}?`)) return; try { await request(`/api/users/${u.user.id}`, { deleteMessages: true }); await refresh(); dialog.close(); toast('Stored messages deleted'); } catch (e) { fail(e); } };
  settings.append(actions, save);
  const tools = node('section', '', 'drawer-section'); tools.append(node('h3', 'Stored messages'));
  const toolButtons = node('div', '', 'drawer-tools'); toolButtons.append(random, exportButton, download); tools.append(toolButtons);
  const danger = node('section', '', 'drawer-section drawer-danger'); danger.append(node('h3', 'Danger zone'), del);
  body.append(summary, stats, settings, tools, danger);
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
    if (!form.dataset.editing) for (const [key, value] of Object.entries({ replyChancePercent: state.replyChancePercent, reactionChanceDenominator: state.reactionChanceDenominator, alwaysReplyUserId: state.alwaysReplyUser.id, nerdEmoji: state.nerdEmoji, specialUserId: state.specialUser.id, specialRoleId: state.specialRoleId, guildId: state.guildId || '' })) if (document.activeElement !== form.elements[key]) form.elements[key].value = value;
    if (!form.dataset.editing) {
      document.querySelector('[data-resolved="alwaysReplyUserId"]').textContent = person(state.alwaysReplyUser);
      document.querySelector('[data-resolved="specialUserId"]').textContent = person(state.specialUser);
      document.querySelector('[data-resolved="specialRoleId"]').textContent = state.specialRole;
      document.querySelector('[data-resolved="guildId"]').textContent = state.guildName || '';
    }
  }
  fillSelect($('download-guild'), state.guilds, state.guildId); fillSelect($('trivia-guild'), state.guilds, state.guildId);
  if (selected === 'users') renderUsers();
  if (selected === 'downloads') renderJobs(state.jobs);
  if (selected === 'queue') {
    $('queue-list').replaceChildren(...state.queue.map(q => node('div', `${person(q.createdBy)} queued for ${q.target ? person(q.target) : 'any user'}: ${q.message}`, 'user-row')));
    if (!state.queue.length) $('queue-list').append(node('p', 'No replies queued.', 'empty-state'));
  }
  if (selected === 'trivia') {
    $('scores').replaceChildren(...state.leaderboard.map((s, i) => {
      const item = node('li', '', 'score-row');
      const identity = node('span', '', 'score-user'), names = node('span', '', 'score-names');
      names.append(node('strong', person(s.user)));
      if (s.user?.username && s.user.username !== person(s.user)) names.append(node('small', `@${s.user.username}`));
      identity.append(avatar(s.user), names);
      item.append(node('span', `#${i + 1}`, 'score-rank'), identity, node('span', `${s.score} ${s.score === 1 ? 'point' : 'points'}`, 'score-points'));
      return item;
    }));
    if (!state.leaderboard.length) $('scores').append(node('li', 'No trivia scores for this server yet.', 'empty-state'));
  }
}
async function refresh() {
  const guildId = selected === 'trivia' ? $('trivia-guild').value : $('download-guild').value;
  const userId = $('download-user').value;
  const data = await (await api(`/api/state?guildId=${encodeURIComponent(guildId || '')}&userId=${encodeURIComponent(userId)}`)).json();
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
$('download-form').onsubmit = async e => { e.preventDefault(); try { await request('/api/downloads', { userId: $('download-user').value, guildId: $('download-guild').value, limit: $('download-limit').value ? Number($('download-limit').value) : null }); toast('Download started'); await refresh(); nav('downloads'); } catch (error) { fail(error); } };
let memberSearchTimer, memberSearchSequence = 0;
function clearMemberResults() {
  clearTimeout(memberSearchTimer); memberSearchSequence++;
  $('member-results').replaceChildren();
}
$('download-guild').addEventListener('change', () => {
  clearMemberResults(); $('member-search').value = ''; $('download-user').value = '';
});
$('member-search').addEventListener('input', () => {
  clearMemberResults();
  const query = $('member-search').value.trim(), guildId = $('download-guild').value, sequence = memberSearchSequence;
  $('download-user').value = '';
  if (!guildId || (query.length < 2 && !/^\d{17,20}$/.test(query))) return;
  memberSearchTimer = setTimeout(async () => {
    try {
      const { members } = await (await api(`/api/members?guildId=${encodeURIComponent(guildId)}&query=${encodeURIComponent(query)}`)).json();
      if (sequence !== memberSearchSequence) return;
      $('member-results').replaceChildren(...members.map(member => {
        const button = node('button', '', 'member-option'); button.type = 'button';
        button.append(avatar(member), node('span', `${person(member)} · ${member.username} · ${member.id}`));
        button.onclick = () => { $('download-user').value = member.id; $('member-search').value = person(member); clearMemberResults(); };
        return button;
      }));
      if (!members.length) $('member-results').append(node('p', 'No matching members in this server.', 'muted'));
    } catch (error) {
      if (sequence === memberSearchSequence) $('member-results').replaceChildren(node('p', error.message, 'muted'));
    }
  }, 350);
});
$('refresh-all').onclick = async () => { if (!confirm('Refresh every tracked user in this server, sequentially?')) return; try { await request('/api/refresh-all', { guildId: $('download-guild').value, limit: $('download-limit').value ? Number($('download-limit').value) : null }); toast('Refresh queued'); await refresh(); nav('downloads'); } catch (e) { fail(e); } };
$('trivia-guild').addEventListener('change', () => refresh().catch(fail));
$('config-form').addEventListener('input', e => { if (e.target.form === $('config-form')) $('config-form').dataset.editing = 'true'; });
$('config-form').onsubmit = async e => { e.preventDefault(); const form=e.currentTarget; try { for (const key of ['specialUserId','specialRoleId']) if (form.elements[key].value !== (key === 'specialUserId' ? state.specialUser.id : state.specialRoleId) && !confirm(`Change ${key}? This can lock you out of admin controls. Continue?`)) return; for (const key of ['replyChancePercent','reactionChanceDenominator','alwaysReplyUserId','nerdEmoji','specialUserId','specialRoleId','guildId']) { const raw=form.elements[key].value; await request('/api/settings',{[key]:['replyChancePercent','reactionChanceDenominator'].includes(key)?Number(raw):key==='guildId'&&!raw?null:raw}); } form.dataset.editing = ''; await refresh(); toast('Configuration saved'); } catch (error) { fail(error); } };
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
$('addUser').onclick = async () => { const id=prompt('Discord user ID (17–20 digits)'); if (!id) return; if (!/^\d{17,20}$/.test(id)) { fail(Error('Enter a valid Discord ID.')); return; } try { await request(`/api/users/${id}`,{tracked:true}); await refresh(); nav('users'); showUser(state.users.find(u=>u.user.id===id) || { user: { id, username:id, displayName:id, avatarUrl:null }, tracked:true, nerded:false, replyChanceOverride:null, messageCount:0, mediaSkipped:0 }); } catch(e) { fail(e); } };
