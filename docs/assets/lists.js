// lists.js — render recommended-book lists.
// Match data is precomputed by scripts/rebuild_lists_index.rb (Ruby
// matcher in src/lists_index.rb) and stored on each db.json book as
// `in_lists: [{ list, position }, ...]`. We invert that into a lookup
// keyed by `${listName}##${position}` so each rendered row knows whether
// to show as "read" and where to link.

const [db, listsData] = await Promise.all([
  fetch('db.json').then(r => r.json()).catch(() => ({ books: [] })),
  fetch('lists.json').then(r => r.json()).catch(() => ({ Lists: [] }))
]);

const allBooks = Array.isArray(db?.books) ? db.books : [];

const normalize = (str) => (str ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
  .trim();

// (listName, position, normalizedTitle) -> bookId. The title component
// disambiguates list rows that share a Position (publication ties), so a
// non-matching row no longer inherits the bookId of its neighbour.
const entryKey = (list, position, title) =>
  `${list}##${position}##${normalize(title)}`;

const entryToBook = new Map();
for (const book of allBooks) {
  for (const m of book.in_lists ?? []) {
    if (m.list && m.position != null) entryToBook.set(entryKey(m.list, m.position, m.title), book.id);
  }
}

// --- Build display model ---
const model = (listsData.Lists ?? []).map((list) => {
  const entries = (list['Books/Stories'] ?? []).map((entry) => {
    const primary = entry.TitleSpanish || entry.TitleOriginal || '';
    const bookId = entryToBook.get(entryKey(list.Source, entry.Position, primary)) ?? null;
    const year = entry.FirstPublicationYear ?? null;
    const haystack = normalize([
      entry.TitleSpanish, entry.TitleOriginal, entry.Author,
      year, bookId != null ? 'read' : 'unread'
    ].filter(v => v !== null && v !== undefined).join(' '));
    return {
      pos: entry.Position,
      titleSpanish: entry.TitleSpanish || entry.TitleOriginal || '',
      titleOriginal: entry.TitleOriginal || '',
      author: entry.Author || '',
      year,
      bookId,
      haystack
    };
  });
  const readCount = entries.filter(e => e.bookId != null).length;
  return {
    name: list.Source,
    notes: list.Notes || '',
    entries,
    readCount,
    total: entries.length
  };
});

// --- DOM refs ---
const root = document.getElementById('lists-root');
const filterInput = document.getElementById('filter');
const overview = document.getElementById('lists-overview');
const filteredOut = document.getElementById('lists-filtered');
const sectionTpl = document.getElementById('tpl-list-section');
const rowTpl = document.getElementById('tpl-list-row');
const tocRow = document.getElementById('lists-toc-row');
const tocItemTpl = document.getElementById('tpl-toc-item');
const toolbarSticky = document.querySelector('.toolbar-sticky');
const slot = (root, name) => root.querySelector(`[data-slot="${name}"]`);

const listAnchor = (idx) => `list-${idx}`;

// --- Build a single row ---
const buildRow = (entry) => {
  const frag = rowTpl.content.cloneNode(true);
  const li = frag.querySelector('li');
  li.classList.add(entry.bookId != null ? 'read' : 'unread');
  if (entry.bookId != null) li.dataset.bookId = entry.bookId;

  slot(frag, 'pos').textContent = String(entry.pos).padStart(2, '0');

  const check = slot(frag, 'check');
  if (entry.bookId != null) {
    check.classList.add('check-read');
    check.textContent = '✓';
  } else {
    check.classList.add('check-empty');
  }

  const yearEl = slot(frag, 'year');
  if (entry.year != null) {
    yearEl.textContent = entry.year < 0 ? `${-entry.year} BC` : String(entry.year);
    yearEl.dateTime = String(entry.year);
  } else {
    yearEl.textContent = '–';
    yearEl.classList.add('list-year-missing');
  }

  const titleEl = slot(frag, 'title');
  if (entry.bookId != null) {
    const a = document.createElement('a');
    a.href = `index.html#${entry.bookId}`;
    a.className = 'book-link';
    a.textContent = entry.titleSpanish;
    titleEl.appendChild(a);
  } else {
    titleEl.textContent = entry.titleSpanish;
  }

  const origEl = slot(frag, 'original');
  if (entry.titleOriginal && normalize(entry.titleOriginal) !== normalize(entry.titleSpanish)) {
    origEl.textContent = entry.titleOriginal;
    origEl.hidden = false;
  } else {
    origEl.remove();
  }

  slot(frag, 'author').textContent = entry.author;

  return frag;
};

// --- Build a single list section ---
const buildSection = (list, visibleEntries, anchorId) => {
  const frag = sectionTpl.content.cloneNode(true);
  const section = slot(frag, 'section');
  section.id = anchorId;
  slot(frag, 'name').textContent = list.name;
  const notesEl = slot(frag, 'notes');
  if (list.notes) {
    notesEl.textContent = list.notes;
    notesEl.hidden = false;
  } else {
    notesEl.remove();
  }
  slot(frag, 'count').textContent = `${list.readCount} / ${list.total}`;

  const rows = slot(frag, 'rows');
  for (const entry of visibleEntries) rows.appendChild(buildRow(entry));

  return frag;
};

const buildTocItem = (list, anchorId, visibleEntries) => {
  const frag = tocItemTpl.content.cloneNode(true);
  const link = slot(frag, 'link');
  link.href = `#${anchorId}`;
  slot(frag, 'name').textContent = list.name;
  slot(frag, 'count').textContent = `${visibleEntries.filter(e => e.bookId != null).length}/${visibleEntries.length}`;
  return frag;
};

// --- Render with current filter ---
const render = () => {
  const q = normalize(filterInput.value);
  root.replaceChildren();
  tocRow.replaceChildren();

  let visibleEntryCount = 0;
  let visibleReadCount = 0;
  let visibleListCount = 0;

  model.forEach((list, idx) => {
    const visible = q
      ? list.entries.filter(e => e.haystack.includes(q))
      : list.entries;
    if (visible.length === 0) return;
    visibleListCount++;
    visibleEntryCount += visible.length;
    visibleReadCount += visible.filter(e => e.bookId != null).length;
    const anchorId = listAnchor(idx);
    tocRow.appendChild(buildTocItem(list, anchorId, visible));
    root.appendChild(buildSection(list, visible, anchorId));
  });

  if (visibleEntryCount === 0) {
    const p = document.createElement('p');
    p.className = 'font-body text-sm color-mid p-5';
    p.textContent = 'No entries match.';
    root.appendChild(p);
  }

  if (q) {
    filteredOut.textContent = `${visibleReadCount} / ${visibleEntryCount} matching · ${visibleListCount} lists`;
  } else {
    filteredOut.textContent = '';
  }
};

// Sticky list headers tuck under the sticky toolbar — keep the offset in
// sync with the toolbar's actual height so the header lands flush against
// it on every viewport size. Cheap measurement via ResizeObserver.
const updateStickyOffset = () => {
  const h = toolbarSticky?.getBoundingClientRect().height ?? 0;
  document.documentElement.style.setProperty('--toolbar-h', `${Math.round(h)}px`);
};
const ro = new ResizeObserver(updateStickyOffset);
if (toolbarSticky) ro.observe(toolbarSticky);
window.addEventListener('resize', updateStickyOffset);
updateStickyOffset();

// --- ?book=<id> focus: scroll to the first matching row, briefly
// highlight every row that matches the same book id across all lists.
const focusBookFromQuery = () => {
  const params = new URLSearchParams(location.search);
  const id = params.get('book');
  if (!id) return;
  const rows = root.querySelectorAll(`.list-row[data-book-id="${CSS.escape(id)}"]`);
  if (rows.length === 0) return;
  rows.forEach(r => r.classList.add('focus-pulse'));
  // Match the CSS animation duration before removing the class.
  setTimeout(() => rows.forEach(r => r.classList.remove('focus-pulse')), 2400);
  rows[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
};

// --- Init ---
const totalEntries = model.reduce((s, l) => s + l.total, 0);
const totalRead = model.reduce((s, l) => s + l.readCount, 0);
overview.textContent = `${totalRead} / ${totalEntries} read · ${model.length} lists`;

filterInput.addEventListener('input', render);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.activeElement === filterInput) {
    filterInput.blur();
    return;
  }
  if (document.activeElement === filterInput) return;
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    filterInput.focus();
  }
});

render();
focusBookFromQuery();

// --- Service worker registration ---
const { registerServiceWorker } = await import('./register-sw.js');
registerServiceWorker(() => {
  // Reload to pick up new lists.json / db.json after SW update.
  location.reload();
});
