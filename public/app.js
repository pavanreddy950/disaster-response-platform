// Santrionn Ops – single-page emergency operations dashboard.
// Plain ES module, no build step. Leaflet is loaded globally from cdnjs (window.L).
//
// Safety rule for this file: API data is NEVER injected via innerHTML. All DOM is built with
// the `h()` helper below, which turns strings into text nodes.

/* ============================================================
 * Constants
 * ============================================================ */

const ROLES = {
  admin: { label: 'Admin', token: 'admin-token', userId: 'admin', role: 'admin' },
  contributor1: { label: 'Contributor 1', token: 'contributor-token', userId: 'contributor1', role: 'contributor' },
  contributor2: { label: 'Contributor 2', token: 'contributor2-token', userId: 'contributor2', role: 'contributor' },
  viewer: { label: 'Viewer', token: null, userId: null, role: 'viewer' },
};
const USER_LABELS = { admin: 'Admin', contributor1: 'Contributor 1', contributor2: 'Contributor 2' };

const FALLBACK_STATUSES = ['reported', 'active', 'contained', 'resolved'];
const KNOWN_STATUS_ORDER = ['reported', 'verified', 'active', 'contained', 'resolved'];

const RESOURCE_TYPES = {
  shelter: { label: 'Shelter', glyph: 'S' },
  hospital: { label: 'Hospital', glyph: 'H' },
  medical: { label: 'Medical', glyph: '+' },
  food: { label: 'Food', glyph: 'F' },
  water: { label: 'Water', glyph: 'W' },
  rescue: { label: 'Rescue', glyph: 'R' },
  other: { label: 'Other', glyph: '•' },
};
const KPI_RESOURCE_TYPES = ['shelter', 'hospital', 'food', 'water', 'rescue'];
const KPI_RESOURCE_LABELS = { shelter: 'Shelters', hospital: 'Hospitals', food: 'Food points', water: 'Water points', rescue: 'Rescue teams' };
const SSE_TYPES = ['disaster_created', 'disaster_updated', 'disaster_deleted'];
const LS = { role: 'santrionn.role', theme: 'santrionn.theme' };

/* ============================================================
 * State
 * ============================================================ */

const state = {
  roleKey: 'admin',
  disasters: new Map(), // id -> disaster
  resources: [],
  lifecycle: { statuses: FALLBACK_STATUSES.slice(), transitions: null, fromApi: false },
  stats: null, // last /stats payload, or null when unavailable
  statsAvailable: null, // null = unknown, true/false after first probe
  loaded: false,
  filters: { statuses: new Set(), tag: '', types: new Set(Object.keys(RESOURCE_TYPES)) },
  selectedId: null,
  radiusKm: 10,
  tab: 'overview',
  detail: null, // per-selection cache, see resetDetail()
  deletedNotice: null,
};

function resetDetail(id) {
  state.detail = {
    id,
    seq: (state.detail?.seq ?? 0) + 1,
    nearby: { status: 'idle', data: null, error: null },
    reports: { status: 'idle', data: null, meta: null, cache: null, error: null, priority: 'all' },
    history: { status: 'idle', data: null, error: null },
    statusMsg: null, // { kind: 'error'|'ok', text }
    pending: false,
    confirmDelete: false,
  };
}

/* ============================================================
 * Utilities
 * ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);

/** Build an element. String/number children become text nodes (never parsed as HTML). */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
const titleCase = (s) => String(s ?? '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const statusVar = (s) => `var(--st-${slug(s) || 'unknown'}, var(--st-unknown))`;
const typeVar = (t) => `var(--rt-${slug(t) || 'other'}, var(--rt-other))`;
const userLabel = (id) => (id == null ? 'unknown' : USER_LABELS[id] ?? String(id));
const isLocated = (d) => d?.location && typeof d.location.lat === 'number' && typeof d.location.lng === 'number';

/** Resolve a CSS colour expression (incl. var() fallbacks) to a concrete colour for Leaflet. */
const colorProbe = document.createElement('span');
colorProbe.style.display = 'none';
document.body.append(colorProbe);
function resolveColor(expr) {
  colorProbe.style.color = '';
  colorProbe.style.color = expr;
  return getComputedStyle(colorProbe).color || '#6b7280';
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function fmtClock(iso) {
  const d = new Date(iso ?? Date.now());
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtAgo(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function timeEl(iso, mode = 'ago') {
  return h('time', { datetime: iso, title: fmtTime(iso) }, mode === 'clock' ? fmtClock(iso) : mode === 'full' ? fmtTime(iso) : fmtAgo(iso));
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, value) { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage unavailable */ } }

/* ---------- small UI atoms ---------- */

function statusBadge(status) {
  return h('span', { class: 'badge status', style: { '--c': statusVar(status) } }, titleCase(status || 'unknown'));
}
function sourceBadge(source) {
  const map = { client: 'Client coords', geocoded: 'Geocoded', unresolved: 'Unresolved' };
  return h('span', { class: `badge ${source === 'unresolved' ? 'warn' : 'neutral'}`, title: 'location.source' }, map[source] ?? titleCase(source || 'unknown'));
}
function unresolvedBadge() {
  return h('span', { class: 'badge warn', title: 'No coordinates – not shown on the map' }, 'Unresolved location');
}
function typeSwatch(type) {
  return h('span', { class: 'rt-swatch', style: { '--c': typeVar(type) }, 'aria-hidden': 'true' }, RESOURCE_TYPES[type]?.glyph ?? '•');
}
function spinnerBox(text = 'Loading…') {
  return h('div', { class: 'state-box', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
}
function emptyBox(text) { return h('div', { class: 'state-box' }, text); }

/* ---------- toasts ---------- */

function toast(message, kind = 'info', ms = 5000) {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('p', null, message),
    h('button', { type: 'button', 'aria-label': 'Dismiss', onclick: () => el.remove() }, '×'));
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
  while ($('#toasts').children.length > 4) $('#toasts').firstElementChild.remove();
}

/* ============================================================
 * API client
 * ============================================================ */

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  const token = ROLES[state.roleKey]?.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Network error – is the server running?');
  }
  if (res.status === 204) return { data: null, headers: res.headers, status: 204 };
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? `HTTP_${res.status}`, e.message ?? `Request failed (${res.status})`, e.details);
  }
  return { data: json, headers: res.headers, status: res.status };
}

/** Fetch every page of a `{ data, pagination }` list endpoint (bounded). */
async function fetchAll(path, pageSize, maxItems = 1000) {
  const out = [];
  let offset = 0;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const { data } = await api(`${path}${sep}limit=${pageSize}&offset=${offset}`);
    const items = Array.isArray(data?.data) ? data.data : [];
    out.push(...items);
    const total = data?.pagination?.total ?? out.length;
    offset += items.length;
    if (items.length === 0 || offset >= total || out.length >= maxItems) break;
  }
  return out;
}

/* ============================================================
 * Lifecycle (status machine)
 * ============================================================ */

async function loadLifecycle() {
  try {
    const { data } = await api('/lifecycle');
    if (Array.isArray(data?.statuses) && data.statuses.length) {
      state.lifecycle = { statuses: data.statuses.map(String), transitions: data.transitions ?? null, adminOnly: Array.isArray(data.admin_only) ? data.admin_only : [], fromApi: true };
    }
  } catch (e) {
    if (e.status !== 404) console.warn('lifecycle unavailable', e);
    state.lifecycle = { statuses: FALLBACK_STATUSES.slice(), transitions: null, fromApi: false };
  }
}

/** All statuses we know about: lifecycle order first, then any seen in data. */
function allStatuses() {
  const set = new Set(state.lifecycle.statuses);
  for (const d of state.disasters.values()) if (d.status) set.add(d.status);
  if (state.stats?.disasters?.by_status) for (const s of Object.keys(state.stats.disasters.by_status)) set.add(s);
  return [...set].sort((a, b) => {
    const ia = state.lifecycle.statuses.indexOf(a); const ib = state.lifecycle.statuses.indexOf(b);
    const ka = ia === -1 ? 100 + KNOWN_STATUS_ORDER.indexOf(a) : ia;
    const kb = ib === -1 ? 100 + KNOWN_STATUS_ORDER.indexOf(b) : ib;
    return ka - kb;
  });
}

function isAdminOnly(from, to) {
  return (state.lifecycle.adminOnly ?? []).some((t) => t?.from === from && t?.to === to);
}

function nextStatuses(current) {
  const { transitions, statuses } = state.lifecycle;
  if (transitions && typeof transitions === 'object') {
    const list = transitions[current];
    return Array.isArray(list) ? list.filter((s) => s !== current) : [];
  }
  return statuses.filter((s) => s !== current); // fallback: any transition
}

/* ============================================================
 * Data loading
 * ============================================================ */

async function loadDisasters() {
  const list = await fetchAll('/disasters', 100, 1000);
  state.disasters = new Map(list.map((d) => [d.id, d]));
}
async function loadResources() {
  state.resources = await fetchAll('/resources', 200, 2000);
}
async function loadStats() {
  if (state.statsAvailable === false) return;
  try {
    const { data } = await api('/stats');
    state.stats = data;
    state.statsAvailable = true;
  } catch (e) {
    state.stats = null;
    if (e.status === 404) state.statsAvailable = false;
    else console.warn('stats failed', e);
  }
}

async function loadAll({ quiet = false } = {}) {
  try {
    await Promise.all([loadLifecycle(), loadDisasters(), loadResources(), loadStats()]);
    state.loaded = true;
  } catch (e) {
    toast(`Could not load data: ${e.message}`, 'error', 8000);
    if (!state.loaded) renderLoadError(e);
    return;
  }
  renderFilters();
  renderKpis();
  renderList();
  syncIncidentMarkers();
  syncResourceMarkers();
  if (!quiet) fitToIncidents();
  if (state.selectedId) {
    if (state.disasters.has(state.selectedId)) renderDetail();
    else closeDetail();
  }
}

function renderLoadError(e) {
  const list = $('#incident-list');
  list.replaceChildren(h('li', { class: 'empty' },
    h('div', { class: 'state-box error' }, `Failed to load incidents: ${e.message}`,
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => loadAll() }, 'Retry'))));
  $('#kpis').replaceChildren(h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, 'Data unavailable'), h('div', { class: 'kpi-value' }, '—')));
}

/* ============================================================
 * KPIs
 * ============================================================ */

function computeLocalStats() {
  const by_status = {};
  let unresolved = 0;
  for (const d of state.disasters.values()) {
    by_status[d.status] = (by_status[d.status] ?? 0) + 1;
    if (!isLocated(d)) unresolved += 1;
  }
  const by_type = {};
  for (const r of state.resources) by_type[r.type] = (by_type[r.type] ?? 0) + 1;
  return {
    disasters: { total: state.disasters.size, by_status, unresolved_locations: unresolved },
    resources: { total: state.resources.length, by_type },
  };
}

let lastKpiValues = {};
function renderKpis() {
  const s = state.stats ?? computeLocalStats();
  const byStatus = s.disasters?.by_status ?? {};
  const total = s.disasters?.total ?? 0;
  const open = total - (byStatus.resolved ?? 0);
  const byType = s.resources?.by_type ?? {};

  const cards = [];
  const card = (key, label, value, color, extra = '') => {
    const changed = lastKpiValues[key] !== undefined && lastKpiValues[key] !== value;
    lastKpiValues[key] = value;
    return h('div', { class: `kpi ${extra} ${changed ? 'flash' : ''}`, style: color ? { '--c': color } : null },
      h('div', { class: 'kpi-label' }, label),
      h('div', { class: 'kpi-value' }, value));
  };
  cards.push(card('open', 'Open incidents', open, statusVar('active'), 'primary'));
  for (const st of allStatuses()) {
    cards.push(card(`st:${st}`, h('span', null, h('span', { class: 'dot', style: { '--c': statusVar(st) } }), ' ', titleCase(st)), byStatus[st] ?? 0, statusVar(st)));
  }
  cards.push(card('unresolved', 'No location', s.disasters?.unresolved_locations ?? 0, 'var(--st-unknown)'));
  for (const t of KPI_RESOURCE_TYPES) {
    cards.push(card(`rt:${t}`, h('span', null, typeSwatch(t), ' ', KPI_RESOURCE_LABELS[t]), byType[t] ?? 0, typeVar(t)));
  }
  $('#kpis').replaceChildren(...cards);
}

const refreshKpis = debounce(async () => {
  if (state.statsAvailable) await loadStats();
  renderKpis();
}, 400);

/* ============================================================
 * Filters
 * ============================================================ */

function passesFilters(d) {
  const f = state.filters;
  if (f.statuses.size && !f.statuses.has(d.status)) return false;
  if (f.tag && !(d.tags ?? []).includes(f.tag)) return false;
  return true;
}

function renderFilters() {
  // status chips (multi-select; none selected = all)
  const counts = {};
  for (const d of state.disasters.values()) counts[d.status] = (counts[d.status] ?? 0) + 1;
  const statusChips = allStatuses().map((st) => {
    const active = state.filters.statuses.size === 0 || state.filters.statuses.has(st);
    return h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(active),
      title: state.filters.statuses.has(st) ? `Showing ${st}` : `Filter by ${st}`,
      onclick: () => {
        const set = state.filters.statuses;
        if (set.has(st)) set.delete(st); else set.add(st);
        if (set.size === allStatuses().length) set.clear();
        applyFilters();
      },
    }, h('span', { class: 'dot', style: { '--c': statusVar(st) } }), titleCase(st), h('span', { class: 'n' }, counts[st] ?? 0));
  });
  if (state.filters.statuses.size) {
    statusChips.push(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { state.filters.statuses.clear(); applyFilters(); } }, 'All'));
  }
  $('#status-filters').replaceChildren(...statusChips);

  // tag select
  const tags = new Set();
  for (const d of state.disasters.values()) for (const t of d.tags ?? []) tags.add(t);
  const sel = $('#tag-filter');
  const current = state.filters.tag;
  if (current) tags.add(current);
  sel.replaceChildren(h('option', { value: '' }, 'All tags'), ...[...tags].sort().map((t) => h('option', { value: t }, t)));
  sel.value = current;

  // resource type toggles (double as the resource legend)
  const typeCounts = {};
  for (const r of state.resources) typeCounts[r.type] = (typeCounts[r.type] ?? 0) + 1;
  const types = Object.keys(RESOURCE_TYPES).filter((t) => typeCounts[t]);
  for (const r of state.resources) if (!RESOURCE_TYPES[r.type] && !types.includes(r.type)) types.push(r.type);
  $('#type-filters').replaceChildren(...types.map((t) => {
    const on = typeVisible(t);
    return h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(on),
      onclick: () => {
        if (RESOURCE_TYPES[t]) { if (state.filters.types.has(t)) state.filters.types.delete(t); else state.filters.types.add(t); }
        else if (state.filters.types.has(`!${t}`)) state.filters.types.delete(`!${t}`); else state.filters.types.add(`!${t}`);
        renderFilters();
        syncResourceMarkers();
      },
    }, typeSwatch(t), RESOURCE_TYPES[t]?.label ?? titleCase(t), h('span', { class: 'n' }, typeCounts[t] ?? 0));
  }));
}

function typeVisible(type) {
  return RESOURCE_TYPES[type] ? state.filters.types.has(type) : !state.filters.types.has(`!${type}`);
}

function applyFilters() {
  renderFilters();
  renderList();
  syncIncidentMarkers();
}

/* ============================================================
 * Incident list
 * ============================================================ */

function sortedDisasters() {
  return [...state.disasters.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function incidentRow(d) {
  return h('li', { dataset: { id: d.id } },
    h('button', {
      type: 'button', class: 'incident-item', style: { '--c': statusVar(d.status) },
      'aria-label': `${d.title}, status ${d.status}`,
      onclick: () => selectIncident(d.id, { fly: true }),
    },
    h('span', { class: 'bar', 'aria-hidden': 'true' }),
    h('span', null,
      h('span', { class: 't' }, d.title),
      h('span', { class: 'meta' },
        statusBadge(d.status),
        isLocated(d) ? h('span', null, d.location.name ?? `${d.location.lat.toFixed(2)}, ${d.location.lng.toFixed(2)}`) : unresolvedBadge(),
        ...(d.tags ?? []).slice(0, 3).map((t) => h('span', { class: 'tag' }, t)),
        h('span', null, '·'), timeEl(d.created_at)))));
}

function renderList() {
  const list = $('#incident-list');
  const all = sortedDisasters();
  const visible = all.filter(passesFilters);
  $('#incident-count').textContent = visible.length === all.length ? `(${all.length})` : `(${visible.length} of ${all.length})`;
  if (!all.length) {
    list.replaceChildren(h('li', { class: 'empty' }, 'No incidents yet. Use “New incident” to report one.'));
    return;
  }
  if (!visible.length) {
    list.replaceChildren(h('li', { class: 'empty' }, 'No incidents match the current filters.'));
    return;
  }
  list.replaceChildren(...visible.map(incidentRow));
}

function flashRow(id) {
  const li = $(`#incident-list li[data-id="${CSS.escape(id)}"]`);
  if (li) { li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash'); }
}

/* ============================================================
 * Map
 * ============================================================ */

const mapState = { map: null, tiles: null, incidentLayer: null, resourceLayer: null, incidentMarkers: new Map(), resourceMarkers: new Map(), radiusCircle: null };

function effectiveDark() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function initMap() {
  if (typeof window.L === 'undefined') {
    $('#map-fallback').hidden = false;
    return;
  }
  const map = L.map('map', { worldCopyJump: true, zoomControl: true, minZoom: 2 }).setView([20, 0], 2);
  mapState.map = map;
  setTiles();
  map.createPane('incidents').style.zIndex = '650'; // incidents above resource icons (markerPane = 600)
  mapState.resourceLayer = L.layerGroup().addTo(map);
  mapState.incidentLayer = L.layerGroup().addTo(map);
}

function setTiles() {
  const map = mapState.map;
  if (!map) return;
  // OpenStreetMap standard tiles; dark mode is a CSS filter on the tile pane (see styles.css).
  map.getContainer().classList.toggle('map-dark', effectiveDark());
  if (mapState.tiles) return;
  mapState.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
}

function incidentStyle(d) {
  const color = resolveColor(statusVar(d.status));
  const selected = d.id === state.selectedId;
  return {
    radius: selected ? 11 : 8,
    color: selected ? resolveColor('var(--fg)') : resolveColor('var(--surface)'),
    weight: selected ? 3 : 2,
    fillColor: color,
    fillOpacity: d.status === 'resolved' ? 0.45 : 0.9,
  };
}

function incidentTooltip(d) {
  return h('div', null,
    h('div', { class: 'tt-title' }, d.title),
    h('div', { class: 'tt-meta' }, titleCase(d.status), ' · ', d.location?.name ?? ''));
}

function syncIncidentMarkers() {
  if (!mapState.map) return;
  const keep = new Set();
  for (const d of state.disasters.values()) {
    if (!isLocated(d) || !passesFilters(d)) continue;
    keep.add(d.id);
    let m = mapState.incidentMarkers.get(d.id);
    const latlng = [d.location.lat, d.location.lng];
    if (!m) {
      m = L.circleMarker(latlng, { ...incidentStyle(d), pane: 'incidents' });
      m.on('click', () => selectIncident(d.id, { fly: false }));
      mapState.incidentMarkers.set(d.id, m);
      m.addTo(mapState.incidentLayer);
    } else {
      m.setLatLng(latlng);
      m.setStyle(incidentStyle(d));
      if (!mapState.incidentLayer.hasLayer(m)) m.addTo(mapState.incidentLayer);
    }
    m.unbindTooltip();
    m.bindTooltip(incidentTooltip(d), { direction: 'top', offset: [0, -8] });
    if (d.id === state.selectedId) m.bringToFront();
  }
  for (const [id, m] of mapState.incidentMarkers) {
    if (!keep.has(id)) { m.remove(); mapState.incidentMarkers.delete(id); }
  }
}

function resourceIcon(r) {
  const nearIds = nearbyIdSet();
  const cls = nearIds == null ? '' : nearIds.has(r.id) ? ' is-near' : ' is-dim';
  // Static markup only (glyph comes from our own constant table, colour from a sanitized slug).
  return L.divIcon({
    className: `res-icon${cls}`,
    html: `<div class="res-pin" style="--c:${typeVar(r.type)}">${RESOURCE_TYPES[r.type]?.glyph ?? '&bull;'}</div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function nearbyIdSet() {
  const n = state.detail?.nearby;
  if (!state.selectedId || n?.status !== 'ok') return null;
  return new Set(n.data.data.map((r) => r.id));
}

function syncResourceMarkers() {
  if (!mapState.map) return;
  const keep = new Set();
  for (const r of state.resources) {
    if (typeof r.location?.lat !== 'number' || !typeVisible(r.type)) continue;
    keep.add(r.id);
    let m = mapState.resourceMarkers.get(r.id);
    if (!m) {
      m = L.marker([r.location.lat, r.location.lng], { icon: resourceIcon(r), keyboard: false });
      m.bindTooltip(h('div', null, h('div', { class: 'tt-title' }, r.name), h('div', { class: 'tt-meta' }, RESOURCE_TYPES[r.type]?.label ?? titleCase(r.type), r.location.name ? ` · ${r.location.name}` : '')), { direction: 'top', offset: [0, -9] });
      mapState.resourceMarkers.set(r.id, m);
    } else {
      m.setIcon(resourceIcon(r));
    }
    if (!mapState.resourceLayer.hasLayer(m)) m.addTo(mapState.resourceLayer);
  }
  for (const [id, m] of mapState.resourceMarkers) if (!keep.has(id)) { m.remove(); mapState.resourceMarkers.delete(id); }
}

function fitToIncidents() {
  const map = mapState.map;
  if (!map) return;
  const pts = [...state.disasters.values()].filter(isLocated).map((d) => [d.location.lat, d.location.lng]);
  if (pts.length === 1) map.setView(pts[0], 9);
  else if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 9 });
}

function drawRadius() {
  const map = mapState.map;
  if (!map) return;
  const d = state.disasters.get(state.selectedId);
  if (mapState.radiusCircle) { mapState.radiusCircle.remove(); mapState.radiusCircle = null; }
  if (!d || !isLocated(d)) return;
  const color = resolveColor(statusVar(d.status));
  mapState.radiusCircle = L.circle([d.location.lat, d.location.lng], {
    radius: state.radiusKm * 1000, color, weight: 1.5, dashArray: '5 5', fillColor: color, fillOpacity: 0.07, interactive: false,
  }).addTo(map);
}

function focusSelected() {
  const map = mapState.map;
  const d = state.disasters.get(state.selectedId);
  if (!map || !d || !isLocated(d) || !mapState.radiusCircle) return;
  map.flyToBounds(mapState.radiusCircle.getBounds(), { padding: [30, 30], duration: 0.6, maxZoom: 14 });
}

function restyleMap() {
  setTiles();
  syncIncidentMarkers();
  syncResourceMarkers();
  drawRadius();
}

/* ============================================================
 * Selection & detail panel
 * ============================================================ */

function selectIncident(id, { fly = true } = {}) {
  if (!state.disasters.has(id)) return;
  const changed = state.selectedId !== id;
  state.selectedId = id;
  state.deletedNotice = null;
  if (changed || !state.detail) { resetDetail(id); state.tab = state.tab || 'overview'; }
  $('#list-view').hidden = true;
  $('#detail-view').hidden = false;
  renderDetail();
  syncIncidentMarkers();
  drawRadius();
  updateRadiusControl();
  if (fly || changed) focusSelected();
  loadNearby();
  if (state.tab === 'reports') loadReports();
  if (state.tab === 'history') loadHistory();
  if (window.matchMedia('(max-width: 1023px)').matches) $('#panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeDetail() {
  state.selectedId = null;
  state.detail = null;
  $('#detail-view').hidden = true;
  $('#detail-view').replaceChildren();
  $('#list-view').hidden = false;
  drawRadius();
  updateRadiusControl();
  syncIncidentMarkers();
  syncResourceMarkers();
  const prev = document.activeElement;
  if (!prev || prev === document.body) $('#incident-list button')?.focus({ preventScroll: true });
}

const TABS = [
  ['overview', 'Overview'],
  ['nearby', 'Nearby'],
  ['reports', 'Reports'],
  ['history', 'History'],
];

function renderDetail() {
  const view = $('#detail-view');
  const d = state.disasters.get(state.selectedId);
  if (!d) return;
  const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Incident sections' },
    TABS.map(([key, label]) => h('button', {
      type: 'button', role: 'tab', class: 'tab', id: `tab-${key}`,
      'aria-selected': String(state.tab === key), 'aria-controls': `tabpanel-${key}`, tabindex: state.tab === key ? '0' : '-1',
      onclick: () => switchTab(key),
      onkeydown: (e) => {
        const i = TABS.findIndex(([k]) => k === key);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0];
          switchTab(next);
          $(`#tab-${next}`)?.focus();
        }
      },
    }, label, h('span', { class: 'n', id: `tab-count-${key}` }))));

  view.replaceChildren(
    h('div', { class: 'detail-head', id: 'detail-head' }),
    tablist,
    ...TABS.map(([key]) => h('div', { class: 'tabpanel', role: 'tabpanel', id: `tabpanel-${key}`, 'aria-labelledby': `tab-${key}`, hidden: state.tab !== key })),
  );
  renderDetailHead();
  renderOverview();
  renderNearby();
  renderReports();
  renderHistory();
}

function switchTab(key) {
  state.tab = key;
  for (const [k] of TABS) {
    const tab = $(`#tab-${k}`); const panel = $(`#tabpanel-${k}`);
    if (tab) { tab.setAttribute('aria-selected', String(k === key)); tab.tabIndex = k === key ? 0 : -1; }
    if (panel) panel.hidden = k !== key;
  }
  if (key === 'reports' && state.detail.reports.status === 'idle') loadReports();
  if (key === 'history' && state.detail.history.status === 'idle') loadHistory();
}

function renderDetailHead() {
  const el = $('#detail-head');
  const d = state.disasters.get(state.selectedId);
  if (!el || !d) return;
  el.replaceChildren(
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm back', onclick: closeDetail }, '← All incidents'),
    h('h2', null, d.title),
    h('div', { class: 'badges' }, statusBadge(d.status), isLocated(d) ? sourceBadge(d.location.source) : unresolvedBadge(),
      ...(d.tags ?? []).map((t) => h('span', { class: 'tag' }, t))),
  );
}

/* ---------- overview ---------- */

function renderOverview() {
  const panel = $('#tabpanel-overview');
  const d = state.disasters.get(state.selectedId);
  if (!panel || !d) return;
  const det = state.detail;
  const role = ROLES[state.roleKey];
  const loc = d.location ?? {};

  const kv = h('dl', { class: 'kv' },
    h('dt', null, 'Location'), h('dd', null, loc.name ?? h('span', { class: 'muted' }, 'Not specified')),
    h('dt', null, 'Coordinates'), h('dd', null, isLocated(d) ? h('span', { class: 'mono' }, `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`) : h('span', { class: 'muted' }, '—'), sourceBadge(loc.source ?? (isLocated(d) ? 'client' : 'unresolved'))),
    h('dt', null, 'Tags'), h('dd', null, (d.tags ?? []).length ? d.tags.map((t) => h('span', { class: 'tag' }, t)) : h('span', { class: 'muted' }, 'None')),
    h('dt', null, 'Created by'), h('dd', null, userLabel(d.created_by), d.created_by ? h('span', { class: 'muted mono' }, `(${d.created_by})`) : null),
    h('dt', null, 'Created'), h('dd', null, timeEl(d.created_at, 'full')),
    h('dt', null, 'Updated'), h('dd', null, timeEl(d.updated_at, 'full'), h('span', { class: 'muted' }, `(${fmtAgo(d.updated_at)})`)),
    h('dt', null, 'ID'), h('dd', null, h('span', { class: 'mono muted' }, d.id)),
  );

  // status actions
  const next = nextStatuses(d.status);
  const viewer = role.role === 'viewer';
  const notOwner = role.role === 'contributor' && d.created_by !== role.userId;
  const statusSection = h('div', { class: 'section' },
    h('h3', null, 'Change status'),
    next.length
      ? h('div', { class: 'actions' }, next.map((s) => h('button', {
        type: 'button', class: 'btn btn-sm action-status', style: { '--c': statusVar(s) },
        disabled: det.pending || viewer,
        title: isAdminOnly(d.status, s) ? 'Admin only transition' : null,
        onclick: () => changeStatus(s),
      }, h('span', { class: 'dot', style: { '--c': statusVar(s) } }), `Mark ${titleCase(s)}`, isAdminOnly(d.status, s) ? h('span', { class: 'muted small' }, '(admin)') : null)))
      : h('p', { class: 'note' }, `No further transitions from “${d.status}”.`),
    viewer ? h('p', { class: 'note' }, 'Viewing anonymously – switch role to make changes.') : null,
    notOwner ? h('p', { class: 'note' }, `Created by ${userLabel(d.created_by)} – the API may refuse changes from ${role.label}.`) : null,
    !state.lifecycle.fromApi ? h('p', { class: 'note' }, 'Lifecycle endpoint unavailable – showing all statuses.') : null,
    det.statusMsg ? h('p', { class: `inline-msg ${det.statusMsg.kind}`, role: det.statusMsg.kind === 'error' ? 'alert' : 'status' }, det.statusMsg.text) : null,
  );

  // delete (admin UI only; API enforces anyway)
  let deleteSection = null;
  if (role.role === 'admin') {
    deleteSection = h('div', { class: 'section' }, h('h3', null, 'Danger zone'),
      det.confirmDelete
        ? h('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm delete' },
          h('p', null, 'Delete this incident? It will disappear for everyone.'),
          h('button', { type: 'button', class: 'btn btn-sm', id: 'cancel-delete', onclick: () => { det.confirmDelete = false; renderOverview(); } }, 'Cancel'),
          h('button', { type: 'button', class: 'btn btn-sm btn-danger', disabled: det.pending, onclick: deleteIncident }, 'Delete'))
        : h('button', { type: 'button', class: 'btn btn-sm btn-danger-outline', onclick: () => { det.confirmDelete = true; renderOverview(); $('#cancel-delete')?.focus(); } }, 'Delete incident'));
  }

  panel.replaceChildren(...[h('p', { class: 'desc' }, d.description), kv, statusSection, deleteSection].filter(Boolean));
}

async function changeStatus(status) {
  const det = state.detail;
  const id = state.selectedId;
  det.pending = true;
  det.statusMsg = null;
  renderOverview();
  try {
    const { data } = await api(`/disasters/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } });
    if (data?.id) upsertDisaster(data);
    if (state.detail?.id === id) state.detail.statusMsg = { kind: 'ok', text: `Status changed to ${titleCase(status)}.` };
    if (state.detail?.id === id && state.detail.history.status !== 'idle') loadHistory();
  } catch (e) {
    if (state.detail?.id === id) state.detail.statusMsg = { kind: 'error', text: `${e.status ? `${e.status} ` : ''}${e.message}` };
  } finally {
    if (state.detail?.id === id) { state.detail.pending = false; renderOverview(); }
  }
}

async function deleteIncident() {
  const det = state.detail;
  const id = state.selectedId;
  const title = state.disasters.get(id)?.title ?? 'Incident';
  det.pending = true;
  renderOverview();
  try {
    await api(`/disasters/${encodeURIComponent(id)}`, { method: 'DELETE' });
    removeDisaster(id);
    toast(`Deleted “${title}”.`, 'success');
  } catch (e) {
    if (state.detail?.id === id) {
      state.detail.pending = false;
      state.detail.confirmDelete = false;
      state.detail.statusMsg = { kind: 'error', text: `${e.status ? `${e.status} ` : ''}${e.message}` };
      renderOverview();
    }
  }
}

/* ---------- nearby ---------- */

function setRadius(km, { refetch = true } = {}) {
  state.radiusKm = Math.max(1, Math.min(50, Number(km) || 10));
  for (const id of ['radius-map', 'radius-panel']) { const el = document.getElementById(id); if (el && Number(el.value) !== state.radiusKm) el.value = String(state.radiusKm); }
  for (const id of ['radius-map-out', 'radius-panel-out']) { const el = document.getElementById(id); if (el) el.textContent = `${state.radiusKm} km`; }
  drawRadius();
  if (refetch) debouncedNearby();
}
const debouncedNearby = debounce(() => loadNearby(), 300);

function updateRadiusControl() {
  const d = state.disasters.get(state.selectedId);
  $('#radius-control').hidden = !(mapState.map && d && isLocated(d));
}

async function loadNearby() {
  const det = state.detail;
  const d = state.disasters.get(state.selectedId);
  if (!det || !d) return;
  const seq = det.seq;
  const radius = state.radiusKm;
  det.nearby = { ...det.nearby, status: 'loading' };
  renderNearby();
  try {
    const { data } = await api(`/disasters/${encodeURIComponent(d.id)}/resources?radius=${radius}&limit=200`);
    if (state.detail?.seq !== seq) return;
    det.nearby = { status: 'ok', data, error: null };
  } catch (e) {
    if (state.detail?.seq !== seq) return;
    det.nearby = { status: 'error', data: null, error: e };
  }
  renderNearby();
  syncResourceMarkers();
}

function renderNearby() {
  const panel = $('#tabpanel-nearby');
  const det = state.detail;
  if (!panel || !det) return;
  let controls = $('#nearby-controls', panel);
  if (!controls) {
    controls = h('div', { class: 'nearby-controls', id: 'nearby-controls' },
      h('label', { for: 'radius-panel' }, 'Radius'),
      h('input', { id: 'radius-panel', type: 'range', min: '1', max: '50', step: '1', value: String(state.radiusKm), oninput: (e) => setRadius(e.target.value) }),
      h('output', { id: 'radius-panel-out', for: 'radius-panel' }, `${state.radiusKm} km`));
    panel.replaceChildren(controls, h('div', { id: 'nearby-body' }));
  }
  const body = $('#nearby-body', panel);
  const n = det.nearby;
  const countEl = $('#tab-count-nearby');
  if (countEl) countEl.textContent = n.status === 'ok' ? String(n.data.count ?? n.data.data.length) : '';

  if (n.status === 'loading' && !n.data) { body.replaceChildren(spinnerBox('Finding nearby resources…')); return; }
  if (n.status === 'error') {
    const e = n.error;
    if (e.code === 'LOCATION_UNRESOLVED') {
      body.replaceChildren(h('div', { class: 'state-box warn' }, 'This incident has no resolved location, so nearby resources can’t be searched.', h('span', { class: 'small muted' }, e.message)));
    } else {
      body.replaceChildren(h('div', { class: 'state-box error' }, `Could not load nearby resources: ${e.message}`, h('button', { type: 'button', class: 'btn btn-sm', onclick: loadNearby }, 'Retry')));
    }
    return;
  }
  if (n.status !== 'ok' && !n.data) { body.replaceChildren(); return; }
  const items = n.data?.data ?? [];
  const head = h('p', { class: 'note', style: { margin: '0 0 8px' } },
    `${n.data.count ?? items.length} resource${(n.data.count ?? items.length) === 1 ? '' : 's'} within ${n.data.radius_km ?? state.radiusKm} km`,
    n.status === 'loading' ? ' · updating…' : '');
  if (!items.length) { body.replaceChildren(head, emptyBox('No resources in this radius. Try increasing it.')); return; }
  body.replaceChildren(head, h('ul', { class: 'list-plain' }, items.map((r) => h('li', null,
    h('button', { type: 'button', class: 'res-row', onclick: () => focusResource(r.id) },
      typeSwatch(r.type),
      h('span', { class: 'name' }, r.name, h('span', { class: 'sub' }, RESOURCE_TYPES[r.type]?.label ?? titleCase(r.type), r.location?.name ? ` · ${r.location.name}` : '')),
      h('span', { class: 'dist' }, typeof r.distance_km === 'number' ? `${r.distance_km.toFixed(1)} km` : ''))))));
}

function focusResource(id) {
  const m = mapState.resourceMarkers.get(id);
  if (!mapState.map) return;
  if (!m) { toast('That resource type is hidden by the map filter.', 'info'); return; }
  mapState.map.flyTo(m.getLatLng(), Math.max(mapState.map.getZoom(), 14), { duration: 0.5 });
  m.openTooltip();
}

/* ---------- reports ---------- */

async function loadReports() {
  const det = state.detail;
  if (!det) return;
  const seq = det.seq;
  det.reports = { ...det.reports, status: 'loading', error: null };
  renderReports();
  try {
    const { data, headers } = await api(`/disasters/${encodeURIComponent(det.id)}/reports`);
    if (state.detail?.seq !== seq) return;
    det.reports = { ...det.reports, status: 'ok', data: data?.data ?? [], meta: data?.meta ?? null, cache: data?.meta?.cache ?? headers.get('X-Cache'), error: null };
  } catch (e) {
    if (state.detail?.seq !== seq) return;
    det.reports = { ...det.reports, status: 'error', error: e };
  }
  renderReports();
}

function renderReports() {
  const panel = $('#tabpanel-reports');
  const det = state.detail;
  if (!panel || !det) return;
  const rp = det.reports;
  const countEl = $('#tab-count-reports');
  if (countEl) countEl.textContent = rp.data ? String(rp.data.length) : '';

  if (rp.status === 'idle' || (rp.status === 'loading' && !rp.data)) {
    panel.replaceChildren(spinnerBox('Fetching community reports…'));
    return;
  }
  if (rp.status === 'error') {
    const e = rp.error;
    const retry = h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: loadReports }, 'Try again');
    panel.replaceChildren(e.code === 'UPSTREAM_UNAVAILABLE' || e.status === 503
      ? h('div', { class: 'state-box warn' }, h('strong', null, 'The social-media feed is temporarily unavailable.'), h('span', { class: 'small' }, 'This upstream service fails intermittently and nothing is cached yet. Retrying usually works.'), retry)
      : h('div', { class: 'state-box error' }, `Could not load reports: ${e.message}`, retry));
    return;
  }

  const counts = { high: 0, medium: 0, low: 0 };
  for (const r of rp.data) if (counts[r.priority] !== undefined) counts[r.priority] += 1;
  const filtered = rp.priority === 'all' ? rp.data : rp.data.filter((r) => r.priority === rp.priority);
  const chip = (key, label, n) => h('button', {
    type: 'button', class: `chip ${key !== 'all' ? `pr-${key}` : ''}`, 'aria-pressed': String(rp.priority === key),
    onclick: () => { rp.priority = key; renderReports(); },
  }, key !== 'all' ? h('span', { class: 'dot' }) : null, label, h('span', { class: 'n' }, n));

  const cache = rp.cache ? String(rp.cache).toUpperCase() : null;
  const bar = h('div', { class: 'reports-bar' },
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter by priority' },
      chip('all', 'All', rp.data.length), chip('high', 'High', counts.high), chip('medium', 'Medium', counts.medium), chip('low', 'Low', counts.low)),
    h('div', { class: 'actions' },
      h('span', { class: 'cache-info', title: 'Server-side cache status (X-Cache)' },
        cache ? ['cache ', h('b', null, cache)] : null,
        rp.meta?.fetched_at ? ` · fetched ${fmtClock(rp.meta.fetched_at)}` : '',
        rp.meta?.query ? ` · “${rp.meta.query}”` : ''),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: rp.status === 'loading', onclick: loadReports }, rp.status === 'loading' ? 'Refreshing…' : 'Refresh')));

  const list = filtered.length
    ? h('div', null, filtered.map((r) => h('article', { class: 'report' },
      h('p', null, r.content),
      h('div', { class: 'meta' },
        h('span', { class: `badge pr-${slug(r.priority) || 'low'}` }, titleCase(r.priority ?? 'unknown')),
        h('span', null, `@${r.user ?? 'unknown'}`),
        h('span', null, '·'), timeEl(r.created_at)))))
    : emptyBox(rp.data.length ? 'No reports with this priority.' : 'No community reports found for this incident.');
  panel.replaceChildren(bar, list);
}

/* ---------- history ---------- */

async function loadHistory() {
  const det = state.detail;
  if (!det) return;
  const seq = det.seq;
  det.history = { ...det.history, status: 'loading' };
  renderHistory();
  try {
    const { data } = await api(`/disasters/${encodeURIComponent(det.id)}/history`);
    if (state.detail?.seq !== seq) return;
    const items = Array.isArray(data?.data) ? data.data.slice() : [];
    items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    det.history = { status: 'ok', data: items, error: null };
  } catch (e) {
    if (state.detail?.seq !== seq) return;
    det.history = { status: e.status === 404 ? 'unavailable' : 'error', data: null, error: e };
  }
  renderHistory();
}

function fmtValue(v) {
  if (v == null || v === '') return '∅';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '∅';
  if (typeof v === 'object') {
    if ('name' in v || 'lat' in v) return [v.name, typeof v.lat === 'number' ? `${v.lat.toFixed(3)}, ${v.lng?.toFixed?.(3)}` : null].filter(Boolean).join(' ') || '∅';
    return JSON.stringify(v);
  }
  return String(v);
}

function historyEntry(item) {
  const actor = userLabel(item.actor);
  const action = String(item.action ?? 'updated').toLowerCase();
  const changes = item.changes && typeof item.changes === 'object' ? Object.entries(item.changes) : [];
  let color = 'var(--border-strong)';
  let lines;
  if (action.includes('creat')) {
    color = 'var(--st-verified)';
    lines = [h('span', { class: 'what' }, h('strong', null, actor), ' created the incident')];
  } else if (action.includes('delet')) {
    color = 'var(--danger)';
    lines = [h('span', { class: 'what' }, h('strong', null, actor), ' deleted the incident')];
  } else if (changes.length) {
    const st = item.changes.status;
    if (st?.to) color = statusVar(st.to);
    lines = changes.map(([field, c]) => {
      const from = c && typeof c === 'object' && 'from' in c ? c.from : undefined;
      const to = c && typeof c === 'object' && 'to' in c ? c.to : c;
      return h('span', { class: 'change what' }, h('strong', null, actor), ` changed ${field.replace(/_/g, ' ')} `,
        field === 'status' ? [statusBadge(from), h('span', { class: 'arrow' }, '→'), statusBadge(to)]
          : [h('span', { class: 'mono' }, fmtValue(from)), h('span', { class: 'arrow' }, '→'), h('span', { class: 'mono' }, fmtValue(to))]);
    });
  } else {
    lines = [h('span', { class: 'what' }, h('strong', null, actor), ` ${action.replace(/_/g, ' ')}`)];
  }
  return h('li', { style: { '--c': color } }, lines, h('div', { class: 'when' }, timeEl(item.at, 'full'), ' · ', fmtAgo(item.at)));
}

function renderHistory() {
  const panel = $('#tabpanel-history');
  const det = state.detail;
  if (!panel || !det) return;
  const hs = det.history;
  if (hs.status === 'idle' || (hs.status === 'loading' && !hs.data)) { panel.replaceChildren(spinnerBox('Loading audit trail…')); return; }
  if (hs.status === 'unavailable') { panel.replaceChildren(emptyBox('History not available.')); return; }
  if (hs.status === 'error') {
    panel.replaceChildren(h('div', { class: 'state-box error' }, `Could not load history: ${hs.error.message}`, h('button', { type: 'button', class: 'btn btn-sm', onclick: loadHistory }, 'Retry')));
    return;
  }
  if (!hs.data.length) { panel.replaceChildren(emptyBox('No history entries yet.')); return; }
  panel.replaceChildren(h('ol', { class: 'timeline', 'aria-label': 'Audit trail, newest first' }, hs.data.map(historyEntry)));
}

/* ============================================================
 * Local state mutations (shared by API responses and SSE)
 * ============================================================ */

function upsertDisaster(d, { flash = false } = {}) {
  const prev = state.disasters.get(d.id);
  const isNew = !prev;
  state.disasters.set(d.id, d);
  const locChanged = prev && (prev.location?.lat !== d.location?.lat || prev.location?.lng !== d.location?.lng);
  renderFilters();
  renderList();
  syncIncidentMarkers();
  refreshKpis();
  if (flash) flashRow(d.id);
  if (state.selectedId === d.id) {
    renderDetailHead();
    renderOverview();
    drawRadius();
    updateRadiusControl();
    if (locChanged) loadNearby();
    if (!isNew && state.detail?.history.status === 'ok') loadHistory();
  }
}

function removeDisaster(id, actor) {
  const d = state.disasters.get(id);
  state.disasters.delete(id);
  renderFilters();
  renderList();
  syncIncidentMarkers();
  refreshKpis();
  if (state.selectedId === id) {
    closeDetail();
    if (actor) toast(`“${d?.title ?? 'The selected incident'}” was deleted by ${userLabel(actor)}.`, 'info');
  }
}

/* ============================================================
 * Live updates (SSE)
 * ============================================================ */

let source = null;
function setConn(stateName, label) {
  const el = $('#conn');
  el.dataset.state = stateName;
  $('.conn-label', el).textContent = label;
}

function connectEvents() {
  if (source) source.close();
  setConn('connecting', 'Connecting…');
  source = new EventSource('/events');
  let wasDisconnected = false;
  const onUp = () => {
    setConn('connected', 'Live');
    if (wasDisconnected) { wasDisconnected = false; loadAll({ quiet: true }); } // catch up on missed events
  };
  source.addEventListener('open', onUp);
  source.addEventListener('connected', onUp);
  source.addEventListener('error', () => {
    wasDisconnected = true;
    if (source.readyState === EventSource.CLOSED) {
      setConn('reconnecting', 'Offline – retrying…');
      setTimeout(connectEvents, 5000);
    } else {
      setConn('reconnecting', 'Reconnecting…');
    }
  });
  for (const type of SSE_TYPES) {
    source.addEventListener(type, (e) => {
      let payload;
      try { payload = JSON.parse(e.data); } catch { return; }
      handleEvent(type, payload);
    });
  }
}

function handleEvent(type, payload) {
  const d = payload?.disaster;
  if (!d?.id) return;
  if (type === 'disaster_deleted') removeDisaster(d.id, payload.actor);
  else upsertDisaster(d, { flash: true });
  addFeedItem(type, payload);
}

function addFeedItem(type, { disaster: d, actor, at }) {
  const feed = $('#feed');
  $('.empty', feed)?.remove();
  const kind = type.replace('disaster_', '');
  const exists = type !== 'disaster_deleted' && state.disasters.has(d.id);
  const where = isLocated(d) ? d.location.name ?? `${d.location.lat.toFixed(2)}, ${d.location.lng.toFixed(2)}` : null;
  const li = h('li', { class: 'ev flash' },
    timeEl(at, 'clock'),
    h('span', { class: `ev-type ${kind}` }, kind),
    h('span', { class: 'ev-body' },
      exists ? h('button', { type: 'button', class: 'link-btn', onclick: () => selectIncident(d.id, { fly: true }) }, d.title) : h('strong', null, d.title),
      ' ', statusBadge(d.status), ' ',
      h('span', { class: 'muted' }, `by ${userLabel(actor)}`, where ? ` · ${where}` : ' · unresolved location')));
  feed.prepend(li);
  while (feed.children.length > 50) feed.lastElementChild.remove();
}

/* ============================================================
 * Create incident dialog
 * ============================================================ */

function openCreate() {
  const dlg = $('#create-dialog');
  const form = $('#create-form');
  clearFormErrors();
  $('#create-result').hidden = true;
  $('#create-submit').disabled = false;
  const note = $('#create-role-note');
  const role = ROLES[state.roleKey];
  note.hidden = role.role !== 'viewer';
  note.textContent = 'You are browsing as a viewer without a token – the API will reject this (401). Switch role to Admin or a Contributor.';
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  form.elements.title.focus();
}

function closeCreate() {
  const dlg = $('#create-dialog');
  if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
  $('#new-incident').focus();
}

function clearFormErrors() {
  for (const el of document.querySelectorAll('#create-form .field-error')) el.textContent = '';
  for (const el of document.querySelectorAll('#create-form .field')) el.classList.remove('invalid');
  const g = $('#create-general-error'); g.hidden = true; g.textContent = '';
}

async function submitCreate(e) {
  e.preventDefault();
  const form = e.currentTarget;
  clearFormErrors();
  $('#create-result').hidden = true;
  const body = {
    title: form.elements.title.value.trim(),
    description: form.elements.description.value.trim(),
  };
  const locName = form.elements.location_name.value.trim();
  if (locName) body.location_name = locName;
  const tags = form.elements.tags.value.split(',').map((t) => t.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean);
  if (tags.length) body.tags = tags;

  const submit = $('#create-submit');
  submit.disabled = true;
  submit.textContent = 'Creating…';
  try {
    const { data } = await api('/disasters', { method: 'POST', body });
    upsertDisaster(data, { flash: true });
    showCreateResult(data);
    form.reset();
  } catch (err) {
    showCreateErrors(err);
  } finally {
    submit.disabled = false;
    submit.textContent = 'Create incident';
  }
}

function showCreateErrors(err) {
  const general = [];
  if (Array.isArray(err.details) && err.details.length) {
    for (const det of err.details) {
      const field = String(det.field ?? '').split(/[.[]/)[0];
      const slot = document.querySelector(`#create-form [data-error-for="${CSS.escape(field)}"]`);
      if (slot) {
        slot.textContent = slot.textContent ? `${slot.textContent} ${det.message}` : String(det.message ?? 'Invalid');
        slot.closest('.field')?.classList.add('invalid');
      } else general.push(`${det.field ? `${det.field}: ` : ''}${det.message}`);
    }
  }
  const g = $('#create-general-error');
  const msg = [`${err.status ? `${err.status} – ` : ''}${err.message}`, ...general].join(' · ');
  g.textContent = msg;
  g.hidden = false;
  const firstInvalid = document.querySelector('#create-form .field.invalid input, #create-form .field.invalid textarea');
  firstInvalid?.focus();
}

function showCreateResult(d) {
  const box = $('#create-result');
  const loc = d.location ?? {};
  box.replaceChildren(
    h('strong', null, `Created “${d.title}”`),
    isLocated(d)
      ? h('span', null, 'Location resolved: ', loc.name ?? '', ' ', h('span', { class: 'mono' }, `(${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})`), ' ', sourceBadge(loc.source))
      : h('span', null, unresolvedBadge(), ' The location could not be resolved, so it won’t appear on the map.'),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => { closeCreate(); selectIncident(d.id, { fly: true }); } }, 'View incident'),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { box.hidden = true; $('#create-form').elements.title.focus(); } }, 'Create another')));
  box.hidden = false;
}

/* ============================================================
 * Role & theme
 * ============================================================ */

function initRole() {
  const saved = lsGet(LS.role);
  if (saved && ROLES[saved]) state.roleKey = saved;
  const sel = $('#role');
  sel.value = state.roleKey;
  sel.addEventListener('change', () => {
    state.roleKey = ROLES[sel.value] ? sel.value : 'viewer';
    lsSet(LS.role, state.roleKey);
    toast(`Now acting as ${ROLES[state.roleKey].label}.`, 'info', 2500);
    if (state.selectedId && state.detail) { state.detail.statusMsg = null; state.detail.confirmDelete = false; renderOverview(); }
  });
}

const THEMES = ['system', 'light', 'dark'];
function initTheme() {
  const btn = $('#theme-toggle');
  const current = () => document.documentElement.dataset.theme || 'system';
  const label = () => { btn.setAttribute('aria-label', `Theme: ${current()}`); btn.title = `Theme: ${current()} (click to change)`; };
  label();
  btn.addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(current()) + 1) % THEMES.length];
    if (next === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
    lsSet(LS.theme, next === 'system' ? null : next);
    label();
    restyleMap();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => restyleMap());
}

/* ============================================================
 * Boot
 * ============================================================ */

function init() {
  initRole();
  initTheme();
  initMap();

  $('#tag-filter').addEventListener('change', (e) => { state.filters.tag = e.target.value; applyFilters(); });
  $('#radius-map').addEventListener('input', (e) => setRadius(e.target.value));
  $('#refresh').addEventListener('click', () => loadAll({ quiet: true }));
  $('#new-incident').addEventListener('click', openCreate);
  $('#create-form').addEventListener('submit', submitCreate);
  for (const b of document.querySelectorAll('#create-dialog [data-close]')) b.addEventListener('click', closeCreate);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selectedId && !$('#create-dialog').open && !e.defaultPrevented) {
      const tag = document.activeElement?.tagName;
      if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') closeDetail();
    }
  });

  loadAll();
  connectEvents();
  setInterval(() => { if (!state.selectedId) renderList(); }, 60_000); // keep "x minutes ago" fresh
}

init();
