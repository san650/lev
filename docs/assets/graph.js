// graph.js — render the book / author similarity graph.
//
// graph.json carries IDs and relationships only. Display data (titles,
// authors, years, scores, etc.) is merged at render time from db.json
// and lists.json, both of which are already on disk for the other pages.
//
// URL state: `graph.html#book/<id>` or `graph.html#author/<id>` so a
// focused view is shareable and survives history navigation.

import { loadCached } from './idb-cache.js';

// Stale-while-revalidate: payloads come from IndexedDB on warm starts
// (instant), then a background fetch refreshes the cache and triggers a
// reload if the upstream copy has changed.
const onRefresh = () => location.reload();
const [graph, db, listsData] = await Promise.all([
  loadCached('graph.json', { onRefresh }),
  loadCached('db.json',    { onRefresh }).catch(() => ({ authors: [], books: [] })),
  loadCached('lists.json', { onRefresh }).catch(() => ({ Lists: [] })),
]);
if (!graph) throw new Error('graph.json failed to load');

// --- Lookup tables ---------------------------------------------------------
const BOOKS_BY_ID   = new Map((db.books   || []).map(b => [b.id, b]));
const AUTHORS_BY_ID = new Map((db.authors || []).map(a => [a.id, a]));

const ENTRIES_BY_ID = new Map();
const LISTS_BY_ID   = new Map();
for (const list of (listsData.Lists || [])) {
  LISTS_BY_ID.set(list.id, list);
  for (const entry of (list['Books/Stories'] || [])) {
    ENTRIES_BY_ID.set(entry.id, { entry, list });
  }
}

const NODE_INDEX = {
  book:   new Map(graph.books.nodes.map(n => [n.id, n])),
  author: new Map(graph.authors.nodes.map(n => [n.id, n])),
};

// --- Display projections ---------------------------------------------------
// Resolve a book node's display fields by reading the first listed entry
// and the matched db book. Cached so we don't recompute on every render.
const PROJECTIONS = { book: new Map(), author: new Map() };

function projectBook(node) {
  if (PROJECTIONS.book.has(node.id)) return PROJECTIONS.book.get(node.id);
  const firstEntry = (node.entry_ids || []).map(id => ENTRIES_BY_ID.get(id)).find(Boolean);
  const dbBook = node.db_book_id != null ? BOOKS_BY_ID.get(node.db_book_id) : null;
  const e = firstEntry ? firstEntry.entry : null;
  const title = (dbBook && dbBook.title) || (e && (e.TitleSpanish || e.TitleOriginal)) || '(unknown)';
  const originalTitle = (dbBook && dbBook.original_title) || (e && e.TitleOriginal) || '';
  const author = dbBook ? authorsForBook(dbBook) : (e ? e.Author : '');
  const year = (e && e.FirstPublicationYear) ?? (dbBook && dbBook.first_publishing_date) ?? null;
  const lists = (node.entry_ids || [])
    .map(id => ENTRIES_BY_ID.get(id))
    .filter(Boolean)
    .map(({ list }) => list.Source);
  const read = dbBook ? bookIsRead(dbBook) : false;
  const projected = {
    kind: 'book',
    id: node.id,
    title,
    originalTitle,
    author,
    year,
    lists,
    list_count: node.list_count || 0,
    read,
    score: dbBook ? dbBook.score : null,
    book_id: node.db_book_id,
    top_neighbors: node.top_neighbors || [],
    neighbor_count: node.neighbor_count || 0,
  };
  PROJECTIONS.book.set(node.id, projected);
  return projected;
}

function projectAuthor(node) {
  if (PROJECTIONS.author.has(node.id)) return PROJECTIONS.author.get(node.id);
  const dbAuthor = node.db_author_id != null ? AUTHORS_BY_ID.get(node.db_author_id) : null;
  const aliases = dbAuthor ? (dbAuthor.aliases || []) : [];
  const listBooks = []; // [{list, books: [titles]}]
  const byList = new Map();
  for (const eid of (node.entry_ids || [])) {
    const rec = ENTRIES_BY_ID.get(eid);
    if (!rec) continue;
    const title = rec.entry.TitleSpanish || rec.entry.TitleOriginal || '';
    if (!byList.has(rec.list.id)) byList.set(rec.list.id, { list: rec.list.Source, books: [] });
    const slot = byList.get(rec.list.id);
    if (!slot.books.includes(title)) slot.books.push(title);
  }
  for (const v of byList.values()) listBooks.push(v);
  const dbBooks = dbAuthor ? booksByAuthor(dbAuthor.id) : [];
  const projected = {
    kind: 'author',
    id: node.id,
    name: node.name,
    aliases,
    listBooks,
    dbBooks,
    list_count: node.list_count || 0,
    author_id: node.db_author_id,
    top_neighbors: node.top_neighbors || [],
    neighbor_count: node.neighbor_count || 0,
  };
  PROJECTIONS.author.set(node.id, projected);
  return projected;
}

function project(mode, node) {
  return mode === 'book' ? projectBook(node) : projectAuthor(node);
}

function authorsForBook(book) {
  return (book.author_ids || [])
    .map(aid => AUTHORS_BY_ID.get(aid))
    .filter(Boolean)
    .map(a => a.name)
    .join(', ');
}

function bookIsRead(book) {
  if (book.score != null) return true;
  return !!(book.review && String(book.review).trim().length > 0);
}

function booksByAuthor(authorId) {
  const out = [];
  for (const book of (db.books || [])) {
    if ((book.author_ids || []).includes(authorId)) {
      out.push({ id: book.id, title: book.title, score: book.score, read: bookIsRead(book) });
    }
  }
  return out;
}

// --- State -----------------------------------------------------------------
const state = {
  mode: 'book',          // 'book' | 'author'
  focusId: null,         // numeric node id
  filter: '',
};

// --- DOM refs --------------------------------------------------------------
const filterInput   = document.getElementById('filter');
const overview      = document.getElementById('graph-overview');
const modeButtons   = document.querySelectorAll('.mode-btn');
const stageSection  = document.getElementById('stage-section');
const stageEmpty    = document.getElementById('stage-empty');
const stage         = document.getElementById('stage');
const stageEdges    = document.getElementById('stage-edges');
const stageLabels   = document.getElementById('stage-labels');
const stageNodes    = document.getElementById('stage-nodes');
const stageControls = document.getElementById('stage-controls');
const stageMeta     = document.getElementById('stage-meta');
const toggleWeak    = document.getElementById('toggle-weak');
const clearFocus    = document.getElementById('clear-focus');
const listHeading   = document.getElementById('list-heading');
const listCount     = document.getElementById('list-count');
const nodeList      = document.getElementById('node-list');
const detail        = document.getElementById('detail');
const detailBody    = document.getElementById('detail-body');
const rowTpl        = document.getElementById('tpl-list-row');
const bookDetailTpl = document.getElementById('tpl-detail-book');
const authorDetailTpl = document.getElementById('tpl-detail-author');
const toolbarSticky = document.querySelector('.toolbar-sticky');

const slot = (root, name) => root.querySelector(`[data-slot="${name}"]`);

// --- Helpers ---------------------------------------------------------------
const normalize = (s) => (s ?? '').normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9一-鿿]+/g, ' ')
  .trim();

const fmtYear = (y) => y == null ? '–' : (y < 0 ? `${-y} BC` : String(y));

function haystackFor(mode, node) {
  const p = project(mode, node);
  if (p.kind === 'book') {
    return normalize([p.title, p.originalTitle, p.author, fmtYear(p.year)].filter(Boolean).join(' '));
  }
  return normalize([p.name, ...(p.aliases || [])].filter(Boolean).join(' '));
}

// Cache haystacks once per node — they're stable for the session.
const HAYSTACK = { book: new Map(), author: new Map() };
function haystack(mode, node) {
  const cache = HAYSTACK[mode];
  if (cache.has(node.id)) return cache.get(node.id);
  const h = haystackFor(mode, node);
  cache.set(node.id, h);
  return h;
}

const currentNodes = () => state.mode === 'book' ? graph.books.nodes : graph.authors.nodes;
const currentIndex = () => NODE_INDEX[state.mode];

// --- Hash routing ----------------------------------------------------------
function readHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return { mode: 'book', id: null };
  const [kind, id] = h.split('/');
  const parsedId = id ? parseInt(id, 10) : null;
  if (kind === 'book' || kind === 'author') {
    return { mode: kind, id: Number.isFinite(parsedId) ? parsedId : null };
  }
  return { mode: 'book', id: null };
}

function writeHash() {
  const target = state.focusId
    ? `#${state.mode}/${state.focusId}`
    : `#${state.mode}`;
  if (location.hash !== target) history.replaceState(null, '', target);
}

// --- Mode toggle -----------------------------------------------------------
function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  state.focusId = null;
  for (const btn of modeButtons) btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
  listHeading.textContent = mode === 'book' ? 'All books' : 'All authors';
  renderList();
  renderFocused();
  writeHash();
}

for (const btn of modeButtons) {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
}

// --- List rendering --------------------------------------------------------
function renderList() {
  const q = normalize(state.filter);
  const all = currentNodes();
  const matched = q ? all.filter(n => haystack(state.mode, n).includes(q)) : all;
  nodeList.replaceChildren();

  const RENDER_LIMIT = 300;
  const slice = matched.slice(0, RENDER_LIMIT);

  for (let i = 0; i < slice.length; i++) {
    nodeList.appendChild(buildRow(slice[i], i + 1));
  }

  if (matched.length === 0) {
    const p = document.createElement('p');
    p.className = 'font-body text-sm color-mid p-5';
    p.textContent = 'No nodes match.';
    nodeList.appendChild(p);
  }

  listCount.textContent = matched.length > RENDER_LIMIT
    ? `${RENDER_LIMIT}/${matched.length}`
    : `${matched.length}`;

  const total = all.length;
  const totalEdges = (state.mode === 'book' ? graph.books.edges : graph.authors.edges).length;
  overview.textContent = `${total} ${state.mode === 'book' ? 'books' : 'authors'} · ${totalEdges} edges (w≥3)`;
}

function buildRow(node, rank) {
  const frag = rowTpl.content.cloneNode(true);
  const btn  = slot(frag, 'btn');
  btn.dataset.nodeId = node.id;
  btn.addEventListener('click', () => focusNode(node.id));

  slot(frag, 'rank').textContent = String(rank).padStart(3, '0');

  const p = project(state.mode, node);
  const check = slot(frag, 'check');
  const isRead = p.kind === 'book' ? p.read : (p.dbBooks && p.dbBooks.length > 0);
  if (isRead) {
    check.classList.add('check-read');
    check.textContent = '✓';
  } else {
    check.classList.add('check-empty');
  }

  if (p.kind === 'book') {
    slot(frag, 'year').textContent = fmtYear(p.year);
    slot(frag, 'title').textContent = p.title;
    const sub = slot(frag, 'sub');
    sub.textContent = p.author || '';
    sub.hidden = !p.author;
  } else {
    slot(frag, 'year').textContent = '';
    slot(frag, 'title').textContent = p.name;
    const sub = slot(frag, 'sub');
    const lib = p.dbBooks && p.dbBooks.length ? `${p.dbBooks.length} in library` : '';
    sub.textContent = lib;
    sub.hidden = !lib;
  }

  const countEl = slot(frag, 'count');
  countEl.textContent = p.list_count || 0;
  countEl.classList.add(p.list_count >= 4 ? 'count-strong' : p.list_count >= 2 ? 'count-mid' : 'count-weak');

  if (state.focusId === node.id) btn.classList.add('focused');

  return frag;
}

filterInput.addEventListener('input', () => {
  state.filter = filterInput.value;
  renderList();
});

// --- Focused view ----------------------------------------------------------
function focusNode(id) {
  state.focusId = id;
  writeHash();
  renderFocused();
  renderList();
  scrollStageIntoView();
}

function clearFocused() {
  state.focusId = null;
  writeHash();
  renderFocused();
  renderList();
}

clearFocus.addEventListener('click', clearFocused);

// w<3 has been dropped from graph.json entirely. The "show weak edges"
// toggle no longer has anything to reveal, so hide it.
toggleWeak.hidden = true;

function scrollStageIntoView() {
  const top = stageSection.getBoundingClientRect().top + window.scrollY;
  const offset = (parseInt(getComputedStyle(document.documentElement).getPropertyValue('--toolbar-h')) || 0) + 8;
  window.scrollTo({ top: top - offset, behavior: 'smooth' });
}

function renderFocused() {
  const node = state.focusId != null ? currentIndex().get(state.focusId) : null;
  stageEdges.replaceChildren();
  stageLabels.replaceChildren();
  stageNodes.replaceChildren();
  detailBody.replaceChildren();

  if (!node) {
    stageEmpty.hidden = false;
    // SVGElement doesn't reflect .hidden to the attribute reliably — toggle
    // the attribute directly so the [hidden] CSS rule applies.
    stage.setAttribute('hidden', '');
    stage.setAttribute('aria-hidden', 'true');
    stageControls.hidden = true;
    detail.hidden = true;
    return;
  }

  stageEmpty.hidden = true;
  stage.removeAttribute('hidden');
  stage.setAttribute('aria-hidden', 'false');
  stageControls.hidden = false;
  detail.hidden = false;

  const all = node.top_neighbors || []; // already w >= 3 only
  const visible = all.slice(0, 12);
  drawFocusedGraph(node, visible);
  renderDetail(node);

  if (all.length === 0) {
    stageMeta.textContent = 'no neighbors at w ≥ 3';
  } else {
    const hidden = all.length - visible.length;
    stageMeta.textContent = hidden > 0
      ? `${visible.length} shown · ${hidden} more`
      : `${visible.length} neighbor${visible.length === 1 ? '' : 's'}`;
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function drawFocusedGraph(center, neighbors) {
  const W_MAX = Math.max(...neighbors.map(t => t[1]), 1);
  const W_MIN = Math.min(...neighbors.map(t => t[1]), W_MAX);
  const idx = currentIndex();
  const R_INNER = 100;
  const R_OUTER = 200;
  const N = neighbors.length;

  neighbors.forEach((tuple, i) => {
    const [peerId, w] = tuple;
    const peer = idx.get(peerId);
    if (!peer) return;
    const theta = (-Math.PI / 2) + (2 * Math.PI * i / Math.max(N, 1));
    const t = (W_MAX === W_MIN) ? 0.25 : (1 - (w - W_MIN) / (W_MAX - W_MIN));
    const r = R_INNER + (R_OUTER - R_INNER) * t;
    const x = Math.cos(theta) * r;
    const y = Math.sin(theta) * r;
    peer.__pos = { x, y };

    const line = svg('line', {
      x1: 0, y1: 0, x2: x, y2: y,
      'stroke-width': Math.min(w, 6),
    });
    line.classList.add('edge', 'edge-strong');
    stageEdges.appendChild(line);

    const label = svg('text', { x: x * 0.55, y: y * 0.55 });
    label.classList.add('edge-label');
    label.textContent = String(w);
    stageLabels.appendChild(label);
  });

  appendNodeLabel(center, 0, 0, true);

  neighbors.forEach(tuple => {
    const peer = idx.get(tuple[0]);
    if (!peer || !peer.__pos) return;
    appendNodeLabel(peer, peer.__pos.x, peer.__pos.y, false);
  });
}

function appendNodeLabel(node, x, y, isCenter) {
  const p = project(state.mode, node);
  const labelText = p.kind === 'book' ? p.title : p.name;
  const display = isCenter ? labelText : truncate(labelText, 22);
  const subText = p.kind === 'book'
    ? (p.author ? truncate(p.author, 22) : '')
    : (p.list_count ? `${p.list_count} lists` : '');

  const g = svg('g', { transform: `translate(${x}, ${y})`, tabindex: 0, role: 'button', 'data-node-id': node.id });
  g.classList.add('node-label', isCenter ? 'node-center' : 'node-orbit');
  if (p.kind === 'book' && p.read) g.classList.add('node-read');
  g.setAttribute('aria-label', `${labelText}${subText ? ` · ${subText}` : ''}`);

  const w = (isCenter ? display.length * 9 : display.length * 5.4) + 18;
  const h = isCenter ? 56 : 30;
  const rect = svg('rect', { x: -w / 2, y: -h / 2, width: w, height: h });
  rect.classList.add('node-rect');
  g.appendChild(rect);

  const title = svg('text', { 'text-anchor': 'middle', y: subText ? -2 : 5 });
  title.classList.add('node-title');
  title.textContent = display;
  g.appendChild(title);

  if (subText) {
    const sub = svg('text', { 'text-anchor': 'middle', y: 14 });
    sub.classList.add('node-sub');
    sub.textContent = subText;
    g.appendChild(sub);
  }

  if (isCenter) {
    g.addEventListener('click', () => openCanonical(p));
    g.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCanonical(p); }
    });
  } else {
    g.addEventListener('click', () => focusNode(node.id));
    g.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusNode(node.id); }
    });
  }

  stageNodes.appendChild(g);
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function openCanonical(p) {
  if (p.kind === 'book' && p.book_id != null) {
    location.href = `index.html#${p.book_id}`;
    return;
  }
  if (p.kind === 'author' && p.author_id != null) {
    location.href = `index.html?author=${p.author_id}`;
  }
}

// --- Detail panel ----------------------------------------------------------
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function renderDetail(node) {
  const p = project(state.mode, node);
  if (p.kind === 'book') return renderBookDetail(p);
  return renderAuthorDetail(p);
}

function renderBookDetail(p) {
  const frag = bookDetailTpl.content.cloneNode(true);
  slot(frag, 'title').textContent = p.title;

  const original = slot(frag, 'original');
  if (p.originalTitle && normalize(p.originalTitle) !== normalize(p.title)) {
    original.textContent = p.originalTitle;
    original.hidden = false;
  }
  slot(frag, 'author').textContent = p.author || '';
  slot(frag, 'year').textContent = fmtYear(p.year);
  slot(frag, 'list-count').textContent = p.list_count || 0;

  const scoreEl = slot(frag, 'score');
  if (p.score != null) {
    scoreEl.textContent = `${p.score}`;
    scoreEl.classList.add(p.score >= 8 ? 'score-high' : p.score >= 5 ? 'score-mid' : 'score-low');
  } else {
    scoreEl.textContent = '–';
  }

  const statusEl = slot(frag, 'status');
  statusEl.textContent = p.read ? 'READ' : 'UNREAD';
  statusEl.classList.add(p.read ? 'status-read' : 'status-unread');

  const listUl = slot(frag, 'lists');
  for (const list of (p.lists || [])) {
    listUl.appendChild(el('li', 'font-body text-sm color-deep leading-relaxed', list));
  }

  const deeplink = slot(frag, 'deeplink');
  if (p.book_id != null) {
    deeplink.href = `index.html#${p.book_id}`;
    deeplink.hidden = false;
  }

  detailBody.appendChild(frag);
}

function renderAuthorDetail(p) {
  const frag = authorDetailTpl.content.cloneNode(true);
  slot(frag, 'name').textContent = p.name;

  const aliases = slot(frag, 'aliases');
  if (p.aliases && p.aliases.length > 0) {
    aliases.textContent = `also known as ${p.aliases.join(', ')}`;
    aliases.hidden = false;
  }
  slot(frag, 'list-count').textContent = p.list_count || 0;
  slot(frag, 'db-count').textContent = (p.dbBooks || []).length;

  const lb = slot(frag, 'list-books');
  for (const entry of (p.listBooks || [])) {
    const li = el('li', 'detail-row');
    li.appendChild(el('span', 'font-mono text-xs fw-700 uppercase tracking-wide color-mid', entry.list));
    li.appendChild(el('span', 'font-body text-sm color-deep', entry.books.join(' · ')));
    lb.appendChild(li);
  }

  const db = slot(frag, 'db-books');
  for (const b of (p.dbBooks || [])) {
    const li = el('li', 'detail-db-row');
    if (b.id != null) {
      const a = document.createElement('a');
      a.href = `index.html#${b.id}`;
      a.className = 'detail-link-inline font-body text-sm color-deep';
      a.textContent = b.title;
      li.appendChild(a);
    } else {
      li.appendChild(el('span', 'font-body text-sm color-deep', b.title));
    }
    if (b.score != null) {
      li.appendChild(el('span', 'font-mono text-xs fw-700 color-orange ml-auto', `${b.score}`));
    }
    db.appendChild(li);
  }

  detailBody.appendChild(frag);
}

// --- Sticky toolbar height tracker ----------------------------------------
const updateStickyOffset = () => {
  const h = toolbarSticky?.getBoundingClientRect().height ?? 0;
  document.documentElement.style.setProperty('--toolbar-h', `${Math.round(h)}px`);
};
const ro = new ResizeObserver(updateStickyOffset);
if (toolbarSticky) ro.observe(toolbarSticky);
window.addEventListener('resize', updateStickyOffset);
updateStickyOffset();

// --- Keyboard navigation --------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.activeElement === filterInput) {
    filterInput.blur();
    return;
  }
  if (document.activeElement === filterInput) return;

  if (e.key === 'Escape') { clearFocused(); return; }
  if (e.key === 'f' || e.key === 'F' || e.key === '/') { e.preventDefault(); filterInput.focus(); return; }
  if (e.key === 'b' || e.key === 'B') { setMode('book'); return; }
  if (e.key === 'a' || e.key === 'A') { setMode('author'); return; }
});

// --- Init -----------------------------------------------------------------
window.addEventListener('hashchange', () => {
  const { mode, id } = readHash();
  if (mode !== state.mode) {
    state.mode = mode;
    for (const btn of modeButtons) btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
    listHeading.textContent = mode === 'book' ? 'All books' : 'All authors';
  }
  state.focusId = id != null && currentIndex().has(id) ? id : null;
  renderFocused();
  renderList();
});

const initial = readHash();
state.mode = initial.mode;
for (const btn of modeButtons) btn.setAttribute('aria-pressed', String(btn.dataset.mode === initial.mode));
listHeading.textContent = state.mode === 'book' ? 'All books' : 'All authors';
state.focusId = initial.id != null && currentIndex().has(initial.id) ? initial.id : null;

renderList();
renderFocused();

// --- Service worker registration ------------------------------------------
const { registerServiceWorker } = await import('./register-sw.js');
registerServiceWorker(() => location.reload());
