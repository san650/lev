// graph.js — render the book / author similarity graph.
//
// graph.json carries IDs and relationships only. Display data (titles,
// authors, years, scores, etc.) is merged at render time from db.json
// and lists.json, both of which are already on disk for the other pages.
//
// URL state: `graph.html#book/<id>` or `graph.html#author/<id>` so a
// focused view is shareable and survives history navigation.

const [graph, db, listsData] = await Promise.all([
  fetch('graph.json').then(r => r.json()),
  fetch('db.json').then(r => r.json()).catch(() => ({ authors: [], books: [] })),
  fetch('lists.json').then(r => r.json()).catch(() => ({ Lists: [] })),
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

// graph.json uses 2-char field codes to keep the payload tiny. Decode
// reference (mirror of src/graph.rb):
//   gt  generated_at
//   bk  books          au  authors
//   ns  nodes          es  edges          ib  isolated_db_book_ids
//   ei  entry_ids      li  list_ids       lc  list_count
//   bi  db_book_id     ai  db_author_id   nm  name
//   tn  top_neighbors  nc  neighbor_count
const NODE_INDEX = {
  book:   new Map(graph.bk.ns.map(n => [n.id, n])),
  author: new Map(graph.au.ns.map(n => [n.id, n])),
};

// --- Display projections ---------------------------------------------------
// Resolve a book node's display fields by reading the first listed entry
// and the matched db book. Cached so we don't recompute on every render.
const PROJECTIONS = { book: new Map(), author: new Map() };

// "Likeness" — a 0-10 estimate of how much the user will like a book,
// based on (a) the weighted average of scores on connected books the
// user HAS read (personal signal) and (b) the book's list-count, i.e.
// the canon's collective opinion (impersonal prior). The two are
// blended by a confidence factor that grows with the total edge weight
// to read neighbors — so the more strong-tied books we have ratings
// for, the more the score reflects the user's taste; the less, the
// more it falls back to the canon prior.
function computeLikeness(node) {
  if (!node || !Array.isArray(node.tn)) return canonScore(node) * 0.7;

  let scoreSum = 0;
  let weightSum = 0;
  for (const [peerId, w] of node.tn) {
    const peer = NODE_INDEX.book.get(peerId);
    if (!peer || peer.bi == null) continue;
    const dbBook = BOOKS_BY_ID.get(peer.bi);
    if (!dbBook || dbBook.score == null) continue;
    scoreSum += dbBook.score * w;
    weightSum += w;
  }

  const canon = canonScore(node);
  if (weightSum === 0) {
    // No personal evidence — use canon strength alone but discount it
    // since "everyone else likes it" is a weaker signal than "people
    // whose taste I've validated like it."
    return canon * 0.7;
  }

  const personal = scoreSum / weightSum;         // 1-10 weighted avg
  const confidence = Math.min(1, weightSum / 12);// saturates around ~3-4 strong read neighbors
  return personal * confidence + canon * (1 - confidence);
}

function canonScore(node) {
  // Map list_count (1..~7) to a 0-10 strength score. Books in 6+ lists
  // sit at the top of every "best of" — give them near-full canon weight.
  const lc = node?.lc || 0;
  return Math.min(10, lc * 1.45);
}

function projectBook(node) {
  if (PROJECTIONS.book.has(node.id)) return PROJECTIONS.book.get(node.id);
  const firstEntry = (node.ei || []).map(id => ENTRIES_BY_ID.get(id)).find(Boolean);
  const dbBook = node.bi != null ? BOOKS_BY_ID.get(node.bi) : null;
  const e = firstEntry ? firstEntry.entry : null;
  const title = (dbBook && dbBook.title) || (e && (e.TitleSpanish || e.TitleOriginal)) || '(unknown)';
  const originalTitle = (dbBook && dbBook.original_title) || (e && e.TitleOriginal) || '';
  const author = dbBook ? authorsForBook(dbBook) : (e ? e.Author : '');
  const year = (e && e.FirstPublicationYear) ?? (dbBook && dbBook.first_publishing_date) ?? null;
  const lists = (node.ei || [])
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
    list_count: node.lc || 0,
    read,
    score: dbBook ? dbBook.score : null,
    book_id: node.bi,
    top_neighbors: node.tn || [],
    neighbor_count: node.nc || 0,
    likeness: computeLikeness(node),
  };
  PROJECTIONS.book.set(node.id, projected);
  return projected;
}

function projectAuthor(node) {
  if (PROJECTIONS.author.has(node.id)) return PROJECTIONS.author.get(node.id);
  const dbAuthor = node.ai != null ? AUTHORS_BY_ID.get(node.ai) : null;
  const aliases = dbAuthor ? (dbAuthor.aliases || []) : [];
  const listBooks = []; // [{list, books: [titles]}]
  const byList = new Map();
  for (const eid of (node.ei || [])) {
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
    name: node.nm,
    aliases,
    listBooks,
    dbBooks,
    list_count: node.lc || 0,
    author_id: node.ai,
    top_neighbors: node.tn || [],
    neighbor_count: node.nc || 0,
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
const stageNodes    = document.getElementById('stage-nodes');
const stageRings    = document.getElementById('stage-rings');
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

const currentNodes = () => state.mode === 'book' ? graph.bk.ns : graph.au.ns;
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
  // Books: sort by personalized "likeness" score (the read-next ranking
  // — blends scores of connected books the user has read with the
  // book's canon strength). Authors: still sort by raw edge count since
  // there's no per-author score to blend.
  const all = [...currentNodes()].sort((a, b) => {
    if (state.mode === 'book') {
      return computeLikeness(b) - computeLikeness(a) || (b.nc || 0) - (a.nc || 0);
    }
    return (b.nc || 0) - (a.nc || 0) || (b.lc || 0) - (a.lc || 0);
  });
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
  const totalEdges = (state.mode === 'book' ? graph.bk.es : graph.au.es).length;
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
  if (p.kind === 'book') {
    const l = p.likeness ?? 0;
    countEl.textContent = Math.round(l);
    countEl.setAttribute(
      'title',
      'Likeness score — blends scores of connected books you\'ve read with canon strength'
    );
    countEl.classList.add(l >= 8 ? 'count-strong' : l >= 5 ? 'count-mid' : 'count-weak');
  } else {
    const nc = p.neighbor_count || 0;
    countEl.textContent = nc;
    countEl.setAttribute('title', 'Number of related authors');
    countEl.classList.add(nc >= 10 ? 'count-strong' : nc >= 3 ? 'count-mid' : 'count-weak');
  }

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
  stageNodes.replaceChildren();
  if (stageRings) stageRings.replaceChildren();
  // Drop any per-edge gradient defs we created last render so they don't
  // accumulate (the static defs in HTML stay; we only purge generated ones).
  const defs = stage.querySelector('defs');
  if (defs) {
    defs.querySelectorAll('[id^="edge-grad-"]').forEach(e => e.remove());
  }
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

  const all = node.tn || []; // already w >= 3 only
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

// Floor for the inner ring radius — we'll grow past this whenever the
// focused node has a long title that needs more clearance.
const R_INNER_FLOOR = 165;
const RING_GAP = 26;
const CENTER_GAP = 28;
const VIEWBOX_PAD = 48;
const INNER_RING_CAP = 6;

function drawFocusedGraph(center, neighbors) {
  const sorted = [...neighbors].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const N = sorted.length;
  if (N === 0) {
    appendNodeCard(center, 0, 0, true, 0);
    fitStageViewBox(0);
    return;
  }

  const centerGroup = appendNodeCard(center, 0, 0, true, 0);
  const centerHalfW = centerGroup.__layout.w / 2;
  const centerHalfH = centerGroup.__layout.h / 2;

  // Build all orbit cards offstage so getBBox can return real dimensions
  // — we'll size the rings and the viewBox to actually clear those.
  const cards = sorted.map((tuple, i) => {
    const peer = currentIndex().get(tuple[0]);
    if (!peer) return null;
    const g = appendNodeCard(peer, -10000, -10000, false, i + 1);
    return {
      tuple,
      group: g,
      w: g.__layout.w,
      h: g.__layout.h,
      i,
    };
  }).filter(Boolean);

  const splitAt = Math.min(INNER_RING_CAP, cards.length);
  const inner = cards.slice(0, splitAt);
  const outer = cards.slice(splitAt);

  const innerMaxHalfW = inner.length ? Math.max(...inner.map(c => c.w / 2)) : 0;
  const innerMaxHalfH = inner.length ? Math.max(...inner.map(c => c.h / 2)) : 0;
  const outerMaxHalfW = outer.length ? Math.max(...outer.map(c => c.w / 2)) : 0;
  const outerMaxHalfH = outer.length ? Math.max(...outer.map(c => c.h / 2)) : 0;

  // Pick radii large enough that no orbit card can ever overlap the
  // center, regardless of angle. Center is widest in W and shortest in H,
  // orbit cards likewise — so the binding constraint is whichever sum
  // (centerHalf* + orbitHalf*) is larger.
  const rInner = Math.max(
    R_INNER_FLOOR,
    centerHalfW + innerMaxHalfW + CENTER_GAP,
    centerHalfH + innerMaxHalfH + CENTER_GAP
  );
  // Outer ring sits a full inner-card-width past the inner ring so the
  // two rings have a clean visual gap.
  const rOuter = rInner
    + Math.max(innerMaxHalfW, innerMaxHalfH)
    + Math.max(outerMaxHalfW, outerMaxHalfH)
    + RING_GAP;

  distributeRing(inner, rInner, -Math.PI / 2);
  const outerOffset = outer.length ? Math.PI / outer.length : 0;
  distributeRing(outer, rOuter, -Math.PI / 2 + outerOffset);

  for (const c of cards) {
    const x = Math.cos(c.theta) * c.r;
    const y = Math.sin(c.theta) * c.r;
    c.x = x; c.y = y;
    c.group.setAttribute('transform', `translate(${x}, ${y})`);
    Object.assign(c.group.__layout, { x, y, vx: x, vy: y });
  }

  // Grow the viewBox to enclose every card's furthest corner.
  const maxExtent = rOuter
    + Math.max(outerMaxHalfW, outerMaxHalfH)
    + VIEWBOX_PAD;
  fitStageViewBox(maxExtent);

  drawRings([rInner, rOuter]);
  cards.forEach((c) => drawEdge(c));

  requestAnimationFrame(() => resolveCollisions());
}

// Resize the SVG viewBox + the rendered (CSS-px) dimensions of the SVG
// so the focused graph renders at 1:1 scale — every 1 user-unit in the
// viewBox is one CSS pixel on screen. Text reads at its declared
// font-size regardless of how wide the graph turned out to be. When the
// SVG is wider than the section, the section scrolls.
function fitStageViewBox(extent) {
  const e = Math.max(extent, 280);
  const size = e * 2;
  stage.setAttribute('viewBox', `${-e} ${-e} ${size} ${size}`);
  stage.setAttribute('width', size);
  stage.setAttribute('height', size);
  const bg = stage.querySelector('.stage-bg-rect');
  if (bg) {
    bg.setAttribute('x', -e);
    bg.setAttribute('y', -e);
    bg.setAttribute('width', size);
    bg.setAttribute('height', size);
  }
  // Center the SVG inside its scroll container on initial render so the
  // focused node lands in the middle of the viewport, not at top-left.
  requestAnimationFrame(() => {
    if (stageSection) {
      stageSection.scrollLeft = Math.max(0, (size - stageSection.clientWidth) / 2);
      stageSection.scrollTop  = Math.max(0, (size - stageSection.clientHeight) / 2);
    }
  });
}

// Allocate angular space around a ring proportional to each card's
// measured width. The angular footprint of card i = (w_i + gap) / r.
// When totals fit in 2π we sprinkle the surplus evenly so cards still
// breathe; when they overflow we scale all footprints down so everything
// still appears.
function distributeRing(cards, r, startAngle) {
  if (!cards.length) return;
  const GAP_PX = 18;
  const footprints = cards.map(c => (c.w + GAP_PX) / r);
  const total = footprints.reduce((s, f) => s + f, 0);
  const TWO_PI = 2 * Math.PI;

  let angle = startAngle;
  if (total >= TWO_PI) {
    const scale = TWO_PI / total;
    for (let i = 0; i < cards.length; i++) {
      const a = footprints[i] * scale;
      angle += a / 2;
      cards[i].theta = angle;
      cards[i].r = r;
      angle += a / 2;
    }
  } else {
    const extra = (TWO_PI - total) / cards.length;
    for (let i = 0; i < cards.length; i++) {
      const a = footprints[i] + extra;
      angle += a / 2;
      cards[i].theta = angle;
      cards[i].r = r;
      angle += a / 2;
    }
  }
}

function drawRings(radii) {
  // Faint concentric guide rings — they imply the orbital structure
  // without competing with the labels for attention.
  for (const r of [...new Set(radii)]) {
    const c = svg('circle', { cx: 0, cy: 0, r });
    c.classList.add('orbit-ring');
    stageRings.appendChild(c);
  }
}

function drawEdge(card) {
  const { tuple, i, x, y } = card;
  const [, w] = tuple;

  // Each edge carries its own linear gradient aimed along the line so
  // we can fade from a warm yellow near the center to deeper orange at
  // the orbit. Inline-defining lets us aim the gradient without a
  // global transform.
  const gradId = `edge-grad-${i}`;
  const grad = svg('linearGradient', {
    id: gradId,
    gradientUnits: 'userSpaceOnUse',
    x1: 0, y1: 0, x2: x, y2: y,
  });
  // Heavier weights get a brighter end-color and a fuller-opacity start.
  const tier = edgeTier(w);
  grad.appendChild(svg('stop', { offset: '0%',   'stop-color': tier.start, 'stop-opacity': tier.startOpacity }));
  grad.appendChild(svg('stop', { offset: '100%', 'stop-color': tier.end,   'stop-opacity': tier.endOpacity }));
  stage.querySelector('defs').appendChild(grad);

  const line = svg('line', {
    x1: 0, y1: 0, x2: x, y2: y,
    stroke: `url(#${gradId})`,
    'stroke-width': edgeWidth(w),
    'stroke-linecap': 'round',
  });
  line.classList.add('edge');
  line.style.setProperty('--i', i);
  stageEdges.appendChild(line);
}

// Map edge weight (3..6 in current data) to a visual tier. Heavier
// weights get a bolder hue and higher opacity so the eye reads relative
// strength at a glance without any numeric label.
function edgeTier(w) {
  if (w >= 6) return { start: '#FFE08A', end: '#FF4C1A', startOpacity: 1.0, endOpacity: 0.95 };
  if (w === 5) return { start: '#FFD37A', end: '#FF6B40', startOpacity: 0.95, endOpacity: 0.85 };
  if (w === 4) return { start: '#FFC85C', end: '#FF7A50', startOpacity: 0.85, endOpacity: 0.7  };
  return                  { start: '#E0B065', end: '#B45A40', startOpacity: 0.65, endOpacity: 0.5 };
}

function edgeWidth(w) {
  // Discrete steps tuned so a glance distinguishes w=3 from w=6 even
  // before color reads in.
  if (w >= 6) return 9;
  if (w === 5) return 7;
  if (w === 4) return 5;
  return 3;
}

// Build a refined "card" for one node: a rounded pill sized from the
// actual text measurements (not character-count guesswork).
function appendNodeCard(node, x, y, isCenter, animIndex) {
  const p = project(state.mode, node);
  const labelText = p.kind === 'book' ? p.title : p.name;
  const subText = p.kind === 'book'
    ? (p.author || '')
    : (p.list_count ? `${p.list_count} lists · ${(p.dbBooks || []).length} in library` : '');

  // Allow more glyphs at the center; tighten in the orbit so the rings
  // remain visually balanced and rim cards don't clip the viewBox.
  const TITLE_CAP = isCenter ? 36 : 22;
  const SUB_CAP   = isCenter ? 40 : 24;
  const titleStr = truncate(labelText, TITLE_CAP);
  const subStr   = truncate(subText,   SUB_CAP);

  const g = svg('g', { transform: `translate(${x}, ${y})`, tabindex: 0, role: 'button', 'data-node-id': node.id });
  g.classList.add('node-card', isCenter ? 'node-center' : 'node-orbit');
  if (isCenter) g.setAttribute('filter', 'url(#center-glow)');
  if (p.kind === 'book' && p.read) g.classList.add('node-read');
  g.setAttribute('aria-label', `${labelText}${subText ? ` · ${subText}` : ''}`);
  g.style.setProperty('--i', animIndex);

  // Insert text first so we can measure, then size the rect to fit. We
  // build a placeholder rect, append text, measure, then resize. This is
  // the only reliable way to get the rendered text width across browsers.
  const rect = svg('rect');
  rect.classList.add('node-bg');
  g.appendChild(rect);

  const title = svg('text', { 'text-anchor': 'middle' });
  title.classList.add('node-title');
  title.textContent = titleStr;
  g.appendChild(title);

  let sub = null;
  if (subStr) {
    sub = svg('text', { 'text-anchor': 'middle' });
    sub.classList.add('node-sub');
    sub.textContent = subStr;
    g.appendChild(sub);
  }

  stageNodes.appendChild(g);
  // Return the group so callers can stash measured dimensions.

  // Now measure. Title and sub each get their own row; the rect spans
  // both with generous padding.
  const titleBox = title.getBBox();
  const subBox   = sub ? sub.getBBox() : { width: 0, height: 0 };
  const padX = isCenter ? 22 : 16;
  const padY = isCenter ? 18 : 12;
  const gap  = subStr ? (isCenter ? 6 : 4) : 0;

  const w = Math.max(titleBox.width, subBox.width) + padX * 2;
  const h = titleBox.height + gap + subBox.height + padY * 2;

  rect.setAttribute('x', -w / 2);
  rect.setAttribute('y', -h / 2);
  rect.setAttribute('width', w);
  rect.setAttribute('height', h);

  // Center text vertically inside the pill. Browsers position SVG <text>
  // by its baseline so we offset by an empirical fraction of the height.
  const titleY = -h / 2 + padY + titleBox.height * 0.78;
  title.setAttribute('y', titleY);
  if (sub) sub.setAttribute('y', titleY + gap + subBox.height);

  // Stash measured bbox + radial vector on the group so collision
  // resolution can nudge along the line out from center.
  g.__layout = { x, y, w, h, vx: x, vy: y };

  const onActivate = () => isCenter ? openCanonical(p) : focusNode(node.id);
  g.addEventListener('click', onActivate);
  g.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); }
  });

  return g;
}

// Pairwise nudge any cards whose AABBs overlap. The lighter-weight (later)
// card slides outward along its radial vector until clear, or until it
// hits the safe-area cap. With a 600×600 viewBox we have ~70px of slack
// past R_OUTER before clipping.
function resolveCollisions() {
  const cards = Array.from(stageNodes.querySelectorAll('.node-orbit'));
  const MAX_PUSH = 70;
  const ITERS = 4;
  for (let iter = 0; iter < ITERS; iter++) {
    let moved = false;
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i].__layout, b = cards[j].__layout;
        if (!a || !b) continue;
        if (!aabbOverlap(a, b)) continue;
        // Push the latter card outward by 8px along its radial line,
        // capped so it doesn't fly past the viewBox.
        const len = Math.hypot(b.vx, b.vy);
        if (len === 0) continue;
        const dx = (b.vx / len) * 10;
        const dy = (b.vy / len) * 10;
        const nx = b.x + dx, ny = b.y + dy;
        if (Math.hypot(nx, ny) - len > MAX_PUSH) continue;
        b.x = nx; b.y = ny;
        cards[j].setAttribute('transform', `translate(${nx}, ${ny})`);
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function aabbOverlap(a, b) {
  return Math.abs(a.x - b.x) * 2 < (a.w + b.w + 8)
      && Math.abs(a.y - b.y) * 2 < (a.h + b.h + 8);
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
  const likenessEl = slot(frag, 'likeness');
  const lk = p.likeness ?? 0;
  likenessEl.textContent = Math.round(lk);
  likenessEl.classList.add(lk >= 8 ? 'score-high' : lk >= 5 ? 'score-mid' : 'score-low');

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
