'use strict';

// Agent HQ (mobile). Reads status/live.json, research/ideas-log.md and the
// agent definitions straight from the claude-agents repo on GitHub, so it
// works with the founder's computer off.

const DEFAULTS = { owner: 'tjl0025au', repo: 'claude-agents', branch: 'main' };
const POLL_MS = 30000;
const STALL_MS = 45 * 60 * 1000;
const ACTIVE_ROUND = ['planning', 'awaiting-approval', 'scouting', 'reviewing', 'innovating', 'reporting'];
const ROUND_LABEL = {
  planning: 'Planning', 'awaiting-approval': 'Waiting for you', scouting: 'Scouting',
  reviewing: 'Reviewing', innovating: 'Innovating', reporting: 'Reporting', done: 'Done', failed: 'Failed'
};
const STAGES = ['New', 'Sent to Skeptic/Finance', 'Pursue', 'Rework', 'Set aside', 'Spun off'];
const STAGE_COLOR = {
  'New': 'var(--accent)', 'Sent to Skeptic/Finance': 'var(--violet)', 'Pursue': 'var(--green)',
  'Rework': 'var(--amber)', 'Set aside': 'var(--muted)', 'Spun off': 'var(--violet)'
};

// The company structure. Agent descriptions and tools come from the repo;
// anything in .claude/agents that isn't listed here shows under "Other".
const ORG = [
  { dept: 'Research', members: [
    { id: 'head-of-research', title: 'Head of Research', skill: true, children: ['idea-scout', 'innovator'] }
  ] },
  { dept: 'Review', members: [{ id: 'skeptic' }, { id: 'finance-analyst' }, { id: 'marketer' }] },
  { dept: 'Build', members: [{ id: 'engineer' }, { id: 'qa-reviewer' }, { id: 'repo-manager' }] }
];

const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem('ahq.' + k); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem('ahq.' + k, JSON.stringify(v)); } catch {} }
};

const state = {
  tab: store.get('tab', 'org'),
  ideaFilter: store.get('ideaFilter', 'New'),
  settings: Object.assign({}, DEFAULTS, store.get('settings', {})),
  token: store.get('token', ''),
  data: store.get('data', null), // { live, ideas, agents, fetchedAt }
  error: null,
  loading: false
};

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Strip markdown links and emphasis for plain display.
const plain = s => String(s ?? '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '');

function ago(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}
function duration(a, b) {
  const ms = new Date(b || Date.now()) - new Date(a);
  if (!(ms > 0)) return '';
  const m = Math.round(ms / 60000);
  return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}
const titleCase = id => id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ').replace('Qa ', 'QA ');

/* ---------- GitHub ---------- */

async function gh(path, raw = true) {
  const { owner, repo, branch } = state.settings;
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    cache: 'no-store',
    headers: {
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      Authorization: 'Bearer ' + state.token,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (res.status === 404) return null;
  if (res.status === 401) throw new Error('GitHub rejected the token. Check it in Settings.');
  if (res.status === 403) throw new Error('GitHub refused access (token lacks Contents read, or rate limited).');
  if (!res.ok) throw new Error('GitHub error ' + res.status);
  return raw ? res.text() : res.json();
}

function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2].trim() };
}

async function loadAgents() {
  const out = {};
  const list = await gh('.claude/agents', false);
  const files = Array.isArray(list) ? list.filter(f => f.type === 'file' && f.name.endsWith('.md')) : [];
  const skills = await gh('.claude/skills', false);
  const skillDirs = Array.isArray(skills) ? skills.filter(f => f.type === 'dir') : [];
  await Promise.all([
    ...files.map(async f => {
      const { meta, body } = parseFrontmatter(await gh('.claude/agents/' + f.name) || '');
      const id = meta.name || f.name.replace(/\.md$/, '');
      out[id] = { id, description: meta.description || '', tools: meta.tools || '', body };
    }),
    ...skillDirs.map(async d => {
      const md = await gh('.claude/skills/' + d.name + '/SKILL.md');
      if (!md) return;
      const { meta, body } = parseFrontmatter(md);
      const id = meta.name || d.name;
      out[id] = { id, description: meta.description || '', tools: '', body, skill: true };
    })
  ]);
  return out;
}

// Pulls the "## Directions explored" and "## Opportunities" tables out of the ideas log.
function parseIdeasLog(md) {
  const sections = {};
  let current = null;
  for (const line of (md || '').split(/\r?\n/)) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) { current = h[1].trim().toLowerCase(); sections[current] = []; continue; }
    if (current && line.trim().startsWith('|')) sections[current].push(line);
  }
  const table = lines => {
    const rows = lines.map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
    if (rows.length < 2) return [];
    const head = rows[0].map(h => h.toLowerCase());
    return rows.slice(1).filter(r => !r.every(c => /^:?-{2,}:?$/.test(c) || c === ''))
      .map(r => Object.fromEntries(head.map((h, i) => [h, r[i] || ''])));
  };
  const key = name => Object.keys(sections).find(k => k.startsWith(name));
  const opps = table(sections[key('opportunit')] || []).map(r => ({
    round: r.round, title: plain(r.opportunity), evidence: plain(r['evidence strength'] || r.evidence),
    status: plain(r.status), notes: plain(r.notes)
  })).filter(o => o.title);
  const dirs = table(sections[key('directions')] || []).map(r => ({
    round: r.round, date: r.date, direction: plain(r.direction), find: plain(r["scout's best find"] || r['best find'])
  })).filter(d => d.direction);
  return { opportunities: opps, directions: dirs };
}

async function refresh(full = false) {
  if (!state.token || state.loading) { render(); return; }
  state.loading = true;
  $('#refresh').classList.add('spin');
  renderSync();
  try {
    const needAgents = full || !state.data || !state.data.agents;
    const [liveText, ideasMd, agents] = await Promise.all([
      gh('status/live.json'),
      gh('research/ideas-log.md'),
      needAgents ? loadAgents() : Promise.resolve(state.data.agents)
    ]);
    let live = { rounds: [] };
    if (liveText) {
      try { live = JSON.parse(liveText); } catch { throw new Error('status/live.json is not valid JSON right now.'); }
    }
    state.data = { live, ideas: parseIdeasLog(ideasMd), agents, fetchedAt: new Date().toISOString() };
    store.set('data', state.data);
    state.error = null;
  } catch (e) {
    state.error = e.message || String(e);
    if (e instanceof TypeError) state.error = 'Offline. Showing the last data you saw.';
  } finally {
    state.loading = false;
    $('#refresh').classList.remove('spin');
    // Don't wipe a half-typed token on the Settings tab.
    if (state.tab === 'settings') { renderSync(); $('#live-dot').hidden = !activeRounds().length; }
    else render();
  }
}

/* ---------- Derived status ---------- */

function rounds() { return (state.data?.live?.rounds || []).slice(); }
function isStalled(r) {
  return ACTIVE_ROUND.includes(r.state) && r.updatedAt && Date.now() - new Date(r.updatedAt) > STALL_MS;
}
function activeRounds() { return rounds().filter(r => ACTIVE_ROUND.includes(r.state)); }
// "Loop 2 of 3" for rounds that run the scout → innovator loop; older rounds have no loop.
function loopLabel(r) {
  const n = parseInt(r.loop, 10);
  if (!(n > 0)) return '';
  const max = parseInt(r.maxLoops, 10);
  return max > 0 ? `Loop ${n} of ${max}` : `Loop ${n}`;
}

function roleStatus(id) {
  const act = activeRounds();
  if (id === 'chief-of-staff' || id === 'head-of-research') {
    if (!act.length) return { cls: 'idle', label: 'Idle' };
    if (act.some(r => r.state === 'awaiting-approval')) return { cls: 'waiting', label: 'Waiting for you' };
    if (act.every(isStalled)) return { cls: 'stalled', label: 'Stalled?' };
    const loop = loopLabel(act[0]);
    return { cls: 'working', label: id === 'chief-of-staff' ? 'Running a round' : (ROUND_LABEL[act[0].state] || act[0].state) + (loop ? ' · ' + loop : '') };
  }
  const ws = act.filter(r => !isStalled(r)).flatMap(r => r.workers || []).filter(w => w.role === id);
  const working = ws.filter(w => w.state === 'working').length;
  const queued = ws.filter(w => w.state === 'queued').length;
  if (working) return { cls: 'working', label: working > 1 ? `Working ×${working}` : 'Working' };
  if (queued) return { cls: 'queued', label: 'Queued' };
  return { cls: 'idle', label: 'Idle' };
}

function roundPill(r) {
  if (isStalled(r)) return '<span class="pill stalled">Stalled?</span>';
  const cls = r.state === 'done' ? 'done' : r.state === 'failed' ? 'failed' : r.state === 'awaiting-approval' ? 'waiting' : 'live';
  return `<span class="pill ${cls}">${esc(ROUND_LABEL[r.state] || r.state)}</span>`;
}
function workerPill(w) {
  const label = { queued: 'Queued', working: 'Working', done: 'Done', failed: 'Failed' }[w.state] || w.state;
  return `<span class="pill ${esc(w.state)}">${esc(label)}</span>`;
}

/* ---------- Views ---------- */

function nodeHtml(id, opts = {}) {
  const a = state.data?.agents?.[id];
  const st = roleStatus(id);
  const title = opts.title || titleCase(id);
  const sub = opts.sub || (a?.skill || opts.skill ? 'Skill' : 'Agent');
  return `<button class="node ${opts.lead ? 'lead' : ''} ${st.cls === 'working' || st.cls === 'waiting' ? 'on' : ''}" data-agent="${esc(id)}">
    <span><span class="name">${esc(title)}</span><br><span class="sub">${esc(sub)}</span></span>
    <span class="pill ${st.cls}">${esc(st.label)}</span></button>`;
}

function viewOrg() {
  const act = activeRounds();
  let html = '';
  if (act.length) {
    const r = act[0];
    const ws = r.workers || [];
    const done = ws.filter(w => w.state === 'done').length;
    html += `<div class="banner"><b>${isStalled(r) ? 'Stalled?' : 'Live'}</b> · ${esc(r.title || r.id)}: ${esc(ROUND_LABEL[r.state] || r.state)}${loopLabel(r) ? ' · ' + esc(loopLabel(r)) : ''}${ws.length ? ` (${done}/${ws.length} done)` : ''}<div class="small muted">${esc(r.note || '')}</div></div>`;
  }
  html += '<div class="org">';
  html += `<div class="node lead" style="cursor:default"><span><span class="name">Founder</span><br><span class="sub">You</span></span></div><div class="connector"></div>`;
  html += nodeHtml('chief-of-staff', { title: 'Chief of Staff', sub: 'Main Claude session', lead: true });
  html += '</div>';
  const placed = new Set(['chief-of-staff']);
  for (const d of ORG) {
    html += `<div class="dept"><div class="dept-head">${esc(d.dept)}</div>`;
    for (const m of d.members) {
      placed.add(m.id);
      html += nodeHtml(m.id, { title: m.title, skill: m.skill });
      for (const c of m.children || []) {
        placed.add(c);
        html += `<div class="child">${nodeHtml(c)}</div>`;
      }
    }
    html += '</div>';
  }
  const extra = Object.keys(state.data?.agents || {}).filter(id => !placed.has(id)).sort();
  if (extra.length) {
    html += '<div class="dept"><div class="dept-head">Other</div>' + extra.map(id => nodeHtml(id)).join('') + '</div>';
  }
  return html;
}

function viewResearch() {
  const rs = rounds();
  if (!rs.length) return '<div class="empty">No research rounds yet. When the Head of Research starts one, it shows up here within 30 seconds.</div>';
  return rs.map((r, i) => {
    const ws = r.workers || [];
    const done = ws.filter(w => w.state === 'done' || w.state === 'failed').length;
    const pct = ws.length ? Math.round(100 * done / ws.length) : (r.state === 'done' ? 100 : 0);
    const workers = ws.map(w => `<div class="worker">
        <div class="row"><b>${esc(w.label || titleCase(w.role || 'worker'))}</b>${workerPill(w)}</div>
        <div class="small">${esc(w.direction || '')}</div>
        ${w.summary ? `<div class="small muted" style="margin-top:4px">${esc(w.summary)}</div>` : ''}
        <div class="small muted" style="margin-top:2px">${esc(titleCase(w.role || ''))}${w.loop ? ' · Loop ' + esc(w.loop) : ''}${w.startedAt ? ' · ' + esc(duration(w.startedAt, w.finishedAt)) : ''}</div>
      </div>`).join('');
    const head = `<div class="row"><b>${esc(r.title || r.id)}</b>${roundPill(r)}</div>
      <div class="small muted">${loopLabel(r) ? esc(loopLabel(r)) + ' · ' : ''}${r.theme ? 'Theme: ' + esc(r.theme) + ' · ' : ''}updated ${esc(ago(r.updatedAt))}</div>
      ${r.note ? `<div class="small" style="margin-top:6px">${esc(r.note)}</div>` : ''}
      ${ws.length ? `<div class="progress"><i style="width:${pct}%"></i></div><div class="small muted">${done} of ${ws.length} workers finished</div>` : ''}`;
    // Open the newest round; older ones collapse.
    if (i === 0) return `${i === 0 ? '<h2>Latest round</h2>' : ''}<div class="card">${head}${workers ? '<div style="margin-top:8px">' + workers + '</div>' : ''}</div>`;
    return `${i === 1 ? '<h2>Earlier rounds</h2>' : ''}<div class="card">${head}${workers ? `<details style="margin-top:8px"><summary class="small muted">${ws.length} workers</summary>${workers}</details>` : ''}</div>`;
  }).join('');
}

const tagClass = s => esc((s || '').split(/[\s/]/)[0]);

function ideaCard(o, i) {
  return `<button class="card mini" data-idea="${i}" style="padding:12px 14px">
    <div class="row" style="align-items:flex-start"><span class="idea-title">${esc(o.title)}</span><span class="tag ${tagClass(o.status)}">${esc(o.status || '—')}</span></div>
    <div class="meta"><span class="tag">Round ${esc(o.round)}</span>${o.evidence ? `<span class="tag">Evidence: ${esc(o.evidence)}</span>` : ''}</div>
    ${o.notes ? `<div class="notes">${esc(o.notes.length > 140 ? o.notes.slice(0, 140) + '…' : o.notes)}</div>` : ''}
  </button>`;
}

function viewIdeas() {
  const { opportunities = [], directions = [] } = state.data?.ideas || {};
  if (!opportunities.length) return '<div class="empty">The ideas log has no opportunities yet.</div>';
  const filters = ['New', 'Latest round', 'All'];
  const latest = opportunities.reduce((m, o) => Math.max(m, parseInt(o.round, 10) || 0), 0);
  const list = opportunities.map((o, i) => [o, i]).filter(([o]) =>
    state.ideaFilter === 'New' ? o.status === 'New' :
    state.ideaFilter === 'Latest round' ? (parseInt(o.round, 10) || 0) === latest : true);
  let html = `<div class="chips">${filters.map(f => `<button class="chip ${state.ideaFilter === f ? 'active' : ''}" data-filter="${esc(f)}">${esc(f)}${f === 'New' ? ` (${opportunities.filter(o => o.status === 'New').length})` : ''}</button>`).join('')}</div>`;
  html += list.length ? list.map(([o, i]) => ideaCard(o, i)).join('') : '<div class="empty">Nothing here.</div>';
  if (directions.length) {
    html += `<h2>Directions explored</h2><details class="card"><summary class="small"><b>${directions.length} directions</b></summary>` +
      directions.map(d => `<div class="worker"><div class="small muted">Round ${esc(d.round)} · ${esc(d.date)}</div><div>${esc(d.direction)}</div>${d.find ? `<div class="small muted">Best find: ${esc(d.find)}</div>` : ''}</div>`).join('') +
      '</details>';
  }
  return html;
}

function viewPipeline() {
  const opps = state.data?.ideas?.opportunities || [];
  if (!opps.length) return '<div class="empty">The ideas log has no opportunities yet.</div>';
  const stageOf = s => STAGES.find(st => (s || '').toLowerCase().startsWith(st.toLowerCase().split(/[\s/]/)[0])) || 'New';
  const groups = Object.fromEntries(STAGES.map(s => [s, []]));
  opps.forEach((o, i) => groups[stageOf(o.status)].push([o, i]));
  let html = '<div class="bar" role="img" aria-label="Pipeline breakdown">' +
    STAGES.filter(s => groups[s].length).map(s => `<i style="flex:${groups[s].length};background:${STAGE_COLOR[s]}" title="${esc(s)}"></i>`).join('') + '</div>';
  // On a phone the stages that need you come first; New and Set aside are the long lists.
  for (const s of ['Pursue', 'Rework', 'Sent to Skeptic/Finance', 'Spun off', 'New', 'Set aside']) {
    const g = groups[s];
    if (!g.length && (s === 'Sent to Skeptic/Finance' || s === 'Spun off')) continue;
    html += `<div class="stage"><div class="stage-head"><b>${esc(s)}</b><span class="count">${g.length}</span></div>`;
    html += g.length ? g.map(([o, i]) => `<button class="mini" data-idea="${i}">${esc(o.title)}<div class="small muted">Round ${esc(o.round)}${o.evidence ? ' · ' + esc(o.evidence) : ''}</div></button>`).join('')
      : '<div class="small muted" style="padding:0 2px 6px">None</div>';
    html += '</div>';
  }
  return html;
}

function viewSettings() {
  const s = state.settings;
  return `<div class="card">
    <b>GitHub access</b>
    <p class="small muted" style="margin:4px 0 0">Agent HQ reads your private <code>${esc(s.owner)}/${esc(s.repo)}</code> repo with a read-only token. The token is stored only on this phone.</p>
    <form id="settings-form">
      <label for="token">Fine-grained token</label>
      <input id="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="github_pat_…" value="${esc(state.token)}">
      <div class="hint">Make one at github.com → Settings → Developer settings → Fine-grained tokens. Repository access: only <code>${esc(s.repo)}</code>. Permissions: Contents → Read-only.</div>
      <details style="margin-top:12px"><summary class="small muted">Repository</summary>
        <label for="owner">Owner</label><input id="owner" value="${esc(s.owner)}" autocapitalize="off">
        <label for="repo">Repo</label><input id="repo" value="${esc(s.repo)}" autocapitalize="off">
        <label for="branch">Branch</label><input id="branch" value="${esc(s.branch)}" autocapitalize="off">
      </details>
      <button class="btn wide" type="submit">Save and sync</button>
    </form>
  </div>
  <div class="card">
    <b>Appearance</b>
    <label for="theme">Theme</label>
    <select id="theme"><option value="">Match phone</option><option value="light">Light</option><option value="dark">Dark</option></select>
  </div>
  <div class="card small muted">
    <b style="color:var(--text)">Install on your home screen</b>
    <ol class="steps"><li>iPhone: Safari → Share → Add to Home Screen.</li><li>Android: Chrome → ⋮ menu → Install app (or Add to Home screen).</li></ol>
    Data refreshes every 30 seconds while the app is open.
  </div>
  ${state.token ? '<button class="btn ghost wide" id="forget">Remove token from this phone</button>' : ''}`;
}

function viewSetup() {
  return `<div class="empty">
    <div style="font-size:17px;color:var(--text);font-weight:600">Connect to GitHub</div>
    <p>Agent HQ reads your research status from GitHub, so it works with your computer off. Paste a read-only token once to start.</p>
    <button class="btn" data-goto="settings">Add token</button>
  </div>`;
}

/* ---------- Render ---------- */

const TITLES = { org: 'Org chart', research: 'Research', ideas: 'New ideas', pipeline: 'Pipeline', settings: 'Settings' };

function renderSync() {
  const el = $('#sync');
  el.classList.toggle('err', !!state.error);
  if (state.loading) el.textContent = 'Syncing…';
  else if (state.error) el.textContent = state.error + (state.data?.fetchedAt ? ` Last synced ${ago(state.data.fetchedAt)}.` : '');
  else if (state.data?.fetchedAt) el.textContent = 'Synced ' + ago(state.data.fetchedAt);
  else el.textContent = state.token ? 'Not synced yet' : 'Not connected';
}

function render() {
  const tab = state.tab;
  $('#title').textContent = TITLES[tab];
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#live-dot').hidden = !activeRounds().length;
  renderSync();
  let html;
  if (tab === 'settings') html = viewSettings();
  else if (!state.token && !state.data) html = viewSetup();
  else if (!state.data) html = '<div class="empty">Loading…</div>';
  else html = { org: viewOrg, research: viewResearch, ideas: viewIdeas, pipeline: viewPipeline }[tab]();
  // Keep expanded sections open across the 30-second refreshes.
  const open = new Set([...document.querySelectorAll('#view details[open]')].map(d => d.dataset.k));
  $('#view').innerHTML = html;
  document.querySelectorAll('#view details').forEach((d, i) => {
    d.dataset.k = tab + i;
    if (open.has(d.dataset.k)) d.open = true;
  });
  if (tab === 'settings') $('#theme').value = store.get('theme', '');
}

function openSheet(html) {
  const d = $('#sheet');
  $('.sheet-body', d).innerHTML = html;
  d.showModal();
  $('.sheet-body', d).scrollTop = 0;
}

function showAgent(id) {
  const a = state.data?.agents?.[id];
  const st = roleStatus(id);
  if (id === 'chief-of-staff') {
    const act = activeRounds();
    return openSheet(`<h3>Chief of Staff</h3><span class="pill ${st.cls}">${esc(st.label)}</span>
      <p class="prose">Your main Claude session. Takes your requests, launches the Head of Research for idea rounds, and reports back.</p>
      ${act.length ? `<p class="small">Running: ${act.map(r => esc(r.title || r.id)).join(', ')}</p>` : ''}`);
  }
  const jobs = rounds().flatMap(r => (r.workers || []).filter(w => w.role === id).map(w => ({ r, w })));
  const recent = jobs.slice(0, 6).map(({ r, w }) => `<div class="worker"><div class="row"><span class="small"><b>${esc(w.label || '')}</b> · ${esc(r.title || r.id)}</span>${workerPill(w)}</div><div class="small">${esc(w.direction || '')}</div>${w.summary ? `<div class="small muted">${esc(w.summary)}</div>` : ''}</div>`).join('');
  openSheet(`<h3>${esc(id === 'head-of-research' ? 'Head of Research' : titleCase(id))}</h3>
    <span class="pill ${st.cls}">${esc(st.label)}</span>
    ${a ? `<p class="small">${esc(a.description)}</p>${a.tools ? `<p class="small muted">Tools: ${esc(a.tools)}</p>` : ''}` : '<p class="small muted">No definition found in the repo.</p>'}
    ${recent ? `<h2>Recent work</h2>${recent}` : ''}
    ${a?.body ? `<details style="margin-top:14px"><summary class="small"><b>Full instructions</b></summary><div class="prose" style="margin-top:8px">${esc(a.body)}</div></details>` : ''}`);
}

function showIdea(i) {
  const o = state.data?.ideas?.opportunities?.[i];
  if (!o) return;
  openSheet(`<h3>${esc(o.title)}</h3>
    <div class="meta"><span class="tag ${tagClass(o.status)}">${esc(o.status)}</span><span class="tag">Round ${esc(o.round)}</span>${o.evidence ? `<span class="tag">Evidence: ${esc(o.evidence)}</span>` : ''}</div>
    <p class="prose" style="color:var(--text)">${esc(o.notes || 'No notes yet.')}</p>`);
}

function applyTheme() {
  const t = store.get('theme', '');
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}

/* ---------- Events ---------- */

document.addEventListener('click', e => {
  const tabBtn = e.target.closest('.tabs button');
  if (tabBtn) {
    state.tab = tabBtn.dataset.tab; store.set('tab', state.tab); render(); window.scrollTo(0, 0); return;
  }
  const go = e.target.closest('[data-goto]');
  if (go) { state.tab = go.dataset.goto; store.set('tab', state.tab); render(); return; }
  const agent = e.target.closest('[data-agent]');
  if (agent) return showAgent(agent.dataset.agent);
  const idea = e.target.closest('[data-idea]');
  if (idea) return showIdea(+idea.dataset.idea);
  const chip = e.target.closest('[data-filter]');
  if (chip) { state.ideaFilter = chip.dataset.filter; store.set('ideaFilter', state.ideaFilter); render(); return; }
  if (e.target.closest('#refresh')) return refresh(true);
  if (e.target.closest('#forget')) {
    state.token = ''; state.data = null; store.set('token', ''); store.set('data', null); render();
  }
});

document.addEventListener('submit', e => {
  if (e.target.id !== 'settings-form') return;
  e.preventDefault();
  state.token = $('#token').value.trim();
  state.settings = {
    owner: $('#owner').value.trim() || DEFAULTS.owner,
    repo: $('#repo').value.trim() || DEFAULTS.repo,
    branch: $('#branch').value.trim() || DEFAULTS.branch
  };
  store.set('token', state.token);
  store.set('settings', state.settings);
  state.data = null; state.error = null;
  state.tab = 'org'; store.set('tab', 'org');
  render();
  refresh(true);
});

document.addEventListener('change', e => {
  if (e.target.id === 'theme') { store.set('theme', e.target.value); applyTheme(); }
});

$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') e.target.close(); });

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
setInterval(() => { if (!document.hidden && !state.loading) renderSync(); }, 15000);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

applyTheme();
render();
refresh(true);
