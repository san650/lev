  // Data source: local db.json controlled by the user.
  // DOM construction uses safe textContent and createElement where possible.
  // Template strings for structural HTML only — no user-facing input is rendered.

  // --- Data ---
  // The service worker uses stale-while-revalidate for db.json: we get the
  // cached copy immediately and the SW posts a `db-updated` message later
  // if the network response differs. We can't reload the module on the fly
  // (top-level `await` already ran), so when that message arrives we just
  // re-fetch and re-render in place.
  let db = await (await fetch('db.json')).json();
  let allBooks = Array.isArray(db?.books) ? db.books : [];
  let allAuthors = Array.isArray(db?.authors) ? db.authors : [];
  let authorById = new Map(allAuthors.map(a => [a.id, a]));
  const bookAuthorNames = (book) => (book.author_ids ?? []).map(id => authorById.get(id)?.name).filter(Boolean);

  // --- DOM refs ---
  const bookList = document.getElementById('book-list');
  const bookCount = document.getElementById('book-count');
  const searchInput = document.getElementById('search');
  const sortToggle = document.getElementById('sort-toggle');
  const sortButtons = sortToggle.querySelectorAll('[data-sort]');
  const detailDialog = document.getElementById('book-detail');
  const helpDialog = document.getElementById('help');
  const detailTitle = document.getElementById('detail-title');
  const detailSubtitle = document.getElementById('detail-subtitle');
  const detailOriginal = document.getElementById('detail-original');
  const detailSaga = document.getElementById('detail-saga');
  const detailAuthor = document.getElementById('detail-author');
  const detailCoverWrap = document.getElementById('detail-cover-wrap');
  const detailMetaRows = document.getElementById('detail-meta-rows');
  const detailScore = document.getElementById('detail-score');
  const detailReviewSection = document.getElementById('detail-review-section');
  const detailReview = document.getElementById('detail-review');

  // --- State ---
  const SORT_MODE_STORAGE_KEY = 'lev.sortMode';
  const SORT_MODES = { TITLE: 'title', AUTHOR: 'author', SCORE: 'score', YEAR: 'year' };
  const VALID_SORT_MODES = new Set(Object.values(SORT_MODES));

  const readSortMode = () => {
    try {
      const v = localStorage.getItem(SORT_MODE_STORAGE_KEY);
      return VALID_SORT_MODES.has(v) ? v : SORT_MODES.TITLE;
    } catch {
      return SORT_MODES.TITLE;
    }
  };

  const storeSortMode = (mode) => {
    try {
      localStorage.setItem(SORT_MODE_STORAGE_KEY, mode);
    } catch {
      // Persistence is a nice-to-have; rendering still works without it.
    }
  };

  let displayedBooks = [];
  let selectedIndex = -1;
  let sortMode = readSortMode();

  // --- Fuzzy search (trigram + accent normalization) ---
  const normalize = (str) => str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  const trigrams = (str) => {
    const s = normalize(str);
    if (s.length < 3) return new Set([s]);
    const set = new Set();
    for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
    return set;
  };

  const trigramScore = (query, text) => {
    const qTri = trigrams(query);
    const tTri = trigrams(text);
    let matches = 0;
    for (const t of qTri) if (tTri.has(t)) matches++;
    return qTri.size === 0 ? 0 : matches / qTri.size;
  };

  const bookFields = (book) => [
    book.title,
    book.subtitle ?? '',
    book.original_title ?? '',
    book.saga?.name ?? '',
    ...bookAuthorNames(book)
  ];

  const bookMatchesQuery = (book, query) => {
    const nq = normalize(query);
    // Short queries: fall back to substring match
    if (nq.length < 3) return bookFields(book).some(f => normalize(f).includes(nq));
    return bookFields(book).some(f => trigramScore(query, f) >= 0.5);
  };

  const bookRelevance = (book, query) => {
    return Math.max(...bookFields(book).map(f => trigramScore(query, f)));
  };

  // --- Sorting: saga groups + alphabetical ---
  // Books with a saga group together. Groups sort by saga name among standalone books.
  // Within a group, books sort by saga.order. Standalone books sort by title.
  const buildTitleEntries = (books) => {
    // Separate saga books and standalone books
    const sagas = new Map(); // saga name -> [books]
    const standalone = [];

    for (const book of books) {
      if (book.saga?.name) {
        const key = book.saga.name;
        if (!sagas.has(key)) sagas.set(key, []);
        sagas.get(key).push(book);
      } else {
        standalone.push(book);
      }
    }

    // Sort standalone alphabetically
    standalone.sort((a, b) => a.title.localeCompare(b.title, 'es'));

    // Sort each saga group by order, then by title for books without an order
    for (const group of sagas.values()) {
      group.sort((a, b) => {
        const ao = a.saga.order, bo = b.saga.order;
        if (ao != null && bo != null) return ao - bo;
        if (ao != null) return -1;
        if (bo != null) return 1;
        return a.title.localeCompare(b.title, 'es');
      });
    }

    // Merge: saga groups sort by their name among standalone titles
    // Build a unified list of { type: 'standalone', book } | { type: 'saga', name, books }
    const entries = [];
    for (const book of standalone) entries.push({ type: 'standalone', sortKey: book.title, book });
    for (const [name, books] of sagas) entries.push({ type: 'saga', sortKey: name, name, books });
    entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'es'));

    return entries;
  };

  const buildScoreEntries = (books) => {
    const groups = new Map();
    for (const book of books) {
      const key = book.score != null ? book.score : 'unscored';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(book);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.title.localeCompare(b.title, 'es'));
    }
    const entries = [];
    for (let s = 10; s >= 1; s--) {
      if (groups.has(s)) entries.push({ type: 'score', name: String(s), books: groups.get(s) });
    }
    if (groups.has('unscored')) entries.push({ type: 'score', name: 'Unscored', books: groups.get('unscored') });
    return entries;
  };

  const yearOf = (book) => {
    const d = book.first_publishing_date;
    if (d == null) return null;
    const m = String(d).match(/-?\d{1,4}/);
    return m ? parseInt(m[0], 10) : null;
  };

  const buildYearEntries = (books) => {
    const groups = new Map();
    for (const book of books) {
      const y = yearOf(book);
      const key = y != null ? Math.floor(y / 10) * 10 : 'undated';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(book);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => {
        const ay = yearOf(a) ?? 0;
        const by = yearOf(b) ?? 0;
        if (ay !== by) return by - ay;
        return a.title.localeCompare(b.title, 'es');
      });
    }
    const entries = [];
    const decades = [...groups.keys()].filter(k => typeof k === 'number').sort((a, b) => b - a);
    for (const d of decades) {
      entries.push({ type: 'year', name: `${d}s`, books: groups.get(d) });
    }
    if (groups.has('undated')) entries.push({ type: 'year', name: 'Undated', books: groups.get('undated') });
    return entries;
  };

  const buildAuthorEntries = (books) => {
    const authors = new Map();

    for (const book of books) {
      const names = bookAuthorNames(book);
      const groupNames = names.length > 0 ? names : ['Unknown Author'];

      for (const name of groupNames) {
        if (!authors.has(name)) authors.set(name, []);
        authors.get(name).push(book);
      }
    }

    const entries = [];
    for (const [name, groupBooks] of authors) {
      groupBooks.sort((a, b) => a.title.localeCompare(b.title, 'es'));
      entries.push({ type: 'author', sortKey: name, name, books: groupBooks });
    }
    entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'es'));

    return entries;
  };

  // --- Templates ---
  const bookRowTpl = document.getElementById('tpl-book-row');
  const sagaHeaderTpl = document.getElementById('tpl-saga-header');
  const sagaEndTpl = document.getElementById('tpl-saga-end');
  const metaRowTpl = document.getElementById('tpl-meta-row');

  const slot = (root, name) => root.querySelector(`[data-slot="${name}"]`);

  // --- Cover helpers ---
  const gradientClass = (id) => `ph-${id % 5}`;

  const coverInitials = (book) => {
    const title = book.title ?? '';
    const letters = title.replace(/[^a-zA-Z\u00C0-\u024F]/g, '');
    return letters.slice(0, 2).toUpperCase();
  };

  const buildPlaceholder = (book, cls) => {
    const ph = document.createElement('div');
    ph.className = `${cls} cover-ph ${gradientClass(book.id)}`;
    const initials = coverInitials(book);
    if (initials) {
      const span = document.createElement('span');
      span.className = `cover-initials ${cls === 'cover-lg' ? 'cover-initials-lg' : ''}`;
      span.textContent = initials;
      ph.appendChild(span);
    }
    return ph;
  };

  const createCoverEl = (book, size = 'sm') => {
    const cls = size === 'sm' ? 'cover-sm' : 'cover-lg';
    const fit = size === 'sm' ? 'object-fill' : 'object-contain';
    const defaultCover = book.covers?.find(c => c.default);

    if (defaultCover) {
      const img = document.createElement('img');
      img.src = defaultCover.file;
      img.alt = '';
      img.className = `${cls} ${fit}`;
      img.onerror = () => img.replaceWith(buildPlaceholder(book, cls));
      return img;
    }

    return buildPlaceholder(book, cls);
  };

  // --- Build a single book row from template ---
  const buildBookRow = (book, flatIndex) => {
    const frag = bookRowTpl.content.cloneNode(true);
    const article = frag.querySelector('article');
    article.dataset.index = flatIndex;

    slot(frag, 'cover').appendChild(createCoverEl(book));

    const titleEl = slot(frag, 'title');
    const titleText = document.createElement('span');
    titleText.className = 'row-title-text';
    titleText.textContent = book.title + ' ';
    titleEl.prepend(titleText);
    const yearEl = slot(frag, 'year');
    if (book.first_publishing_date) {
      yearEl.textContent = book.first_publishing_date;
      titleText.appendChild(yearEl);
    } else {
      yearEl.remove();
    }

    // Saga order badge
    const orderEl = slot(frag, 'order');
    if (book.saga?.order != null) {
      orderEl.textContent = `#${book.saga.order}`;
      orderEl.hidden = false;
    } else {
      orderEl.remove();
    }

    // Subtitle
    const subtitleEl = slot(frag, 'subtitle');
    if (book.subtitle) {
      subtitleEl.textContent = book.subtitle;
      subtitleEl.hidden = false;
    } else {
      subtitleEl.remove();
    }

    // Original title
    const origEl = slot(frag, 'original');
    if (book.original_title && book.original_title !== book.title) {
      origEl.textContent = book.original_title;
      origEl.hidden = false;
    } else {
      origEl.remove();
    }

    // Author
    const authorEl = slot(frag, 'author');
    const authors = bookAuthorNames(book).join(', ');
    if (authors) {
      authorEl.textContent = authors;
    } else {
      authorEl.remove();
    }

    // Score
    const scoreEl = slot(frag, 'score');
    const hasScore = book.score != null;
    scoreEl.textContent = hasScore ? book.score : '\u2013';
    if (hasScore) scoreEl.value = book.score;
    if (hasScore) scoreEl.classList.add(`book-score-${book.score}`);

    return frag;
  };

  const updateSortButtons = () => {
    for (const btn of sortButtons) {
      btn.setAttribute('aria-pressed', btn.dataset.sort === sortMode ? 'true' : 'false');
    }
  };

  const buildEntriesForMode = (books) => {
    switch (sortMode) {
      case SORT_MODES.AUTHOR: return buildAuthorEntries(books);
      case SORT_MODES.SCORE:  return buildScoreEntries(books);
      case SORT_MODES.YEAR:   return buildYearEntries(books);
      default:                return buildTitleEntries(books);
    }
  };

  const visibleBooksForQuery = () => {
    const query = searchInput.value.trim();
    if (!query) return allBooks;

    const matches = allBooks.filter(b => bookMatchesQuery(b, query));
    matches.sort((a, b) => bookRelevance(b, query) - bookRelevance(a, query));
    return matches;
  };

  const appendGroup = (entry, startingIndex) => {
    const headerFrag = sagaHeaderTpl.content.cloneNode(true);
    slot(headerFrag, 'saga-name').textContent = entry.name;
    slot(headerFrag, 'saga-count').textContent = `${entry.books.length} ${entry.books.length === 1 ? 'book' : 'books'}`;
    bookList.appendChild(headerFrag);

    const group = document.createElement('div');
    group.className = 'saga-group';
    let flatIndex = startingIndex;
    for (const book of entry.books) {
      group.appendChild(buildBookRow(book, flatIndex));
      flatIndex++;
    }
    bookList.appendChild(group);

    bookList.appendChild(sagaEndTpl.content.cloneNode(true));
    return flatIndex;
  };

  // --- Render book list with selected grouping ---
  const renderBooks = (books) => {
    if (!Array.isArray(books)) books = [];
    selectedIndex = -1;
    bookList.replaceChildren();

    updateSortButtons();

    const entries = buildEntriesForMode(books);

    // Build flat list for keyboard nav and dialog lookup
    const flat = [];
    for (const entry of entries) {
      if (entry.type === 'standalone') flat.push(entry.book);
      else for (const b of entry.books) flat.push(b);
    }
    displayedBooks = flat;

    if (flat.length === 0) {
      const p = document.createElement('p');
      p.className = 'font-body text-sm color-mid p-5';
      p.textContent = 'No books found.';
      bookList.appendChild(p);
    } else {
      let flatIndex = 0;
      for (const entry of entries) {
        if (entry.type === 'standalone') {
          bookList.appendChild(buildBookRow(entry.book, flatIndex));
          flatIndex++;
        } else {
          flatIndex = appendGroup(entry, flatIndex);
        }
      }
    }

    const countLabel = sortMode === SORT_MODES.AUTHOR ? 'row' : 'book';
    bookCount.textContent = `${flat.length} ${flat.length === 1 ? countLabel : `${countLabel}s`}`;

  };

  // --- Search ---
  searchInput.addEventListener('input', () => {
    renderBooks(visibleBooksForQuery());
  });

  sortToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn) return;
    const mode = btn.dataset.sort;
    if (!VALID_SORT_MODES.has(mode) || mode === sortMode) return;
    sortMode = mode;
    storeSortMode(sortMode);
    renderBooks(visibleBooksForQuery());
  });

  // --- Dialog: populate and show ---
  const openBookDetail = (book) => {
    detailTitle.textContent = book.title;

    // Subtitle
    if (book.subtitle) {
      detailSubtitle.textContent = book.subtitle;
      detailSubtitle.hidden = false;
    } else {
      detailSubtitle.hidden = true;
    }

    // Original title
    if (book.original_title && book.original_title !== book.title) {
      detailOriginal.textContent = book.original_title;
      detailOriginal.hidden = false;
    } else {
      detailOriginal.hidden = true;
    }

    // Saga badge
    if (book.saga?.name) {
      detailSaga.textContent = `${book.saga.name} #${book.saga.order}`;
      detailSaga.hidden = false;
    } else {
      detailSaga.hidden = true;
    }

    detailAuthor.textContent = bookAuthorNames(book).join(', ');
    detailCoverWrap.replaceChildren(createCoverEl(book, 'lg'));

    // Meta rows using <template>
    detailMetaRows.replaceChildren();
    const rows = [];
    if (book.first_publishing_date) rows.push({ label: 'Year', value: book.first_publishing_date, mono: true });
    if (book.publisher) rows.push({ label: 'Publisher', value: book.publisher, mono: false });
    for (const id of (book.identifiers ?? [])) rows.push({ label: id.type, value: id.value, mono: true });
    if (book.saga?.name) rows.push({ label: 'Saga', value: `${book.saga.name} #${book.saga.order}`, mono: true });

    for (const r of rows) {
      const frag = metaRowTpl.content.cloneNode(true);
      slot(frag, 'label').textContent = r.label;
      const valueEl = slot(frag, 'value');
      valueEl.textContent = r.value;
      valueEl.classList.add(...(r.mono ? ['font-mono', 'text-xs', 'fw-700'] : ['font-body', 'text-sm']));
      detailMetaRows.appendChild(frag);
    }

    const hasScore = book.score != null;
    detailScore.textContent = hasScore ? book.score : '\u2013';
    if (hasScore) detailScore.value = book.score;

    if (book.review) {
      detailReview.textContent = book.review;
      detailReviewSection.classList.remove('hidden');
    } else {
      detailReviewSection.classList.add('hidden');
    }

    updateDetailNav();
    detailDialog.showModal();

    // Reflect the open book in the URL hash so it can be deep-linked.
    if (book.id != null && location.hash !== `#${book.id}`) {
      history.replaceState(null, '', `#${book.id}`);
    }
  };

  // --- Dialog navigation ---
  const detailPrev = document.getElementById('detail-prev');
  const detailNext = document.getElementById('detail-next');

  const updateDetailNav = () => {
    detailPrev.disabled = selectedIndex <= 0;
    detailNext.disabled = selectedIndex >= displayedBooks.length - 1;
  };

  const navigateDetail = (delta) => {
    const next = selectedIndex + delta;
    if (next < 0 || next >= displayedBooks.length) return;
    selectedIndex = next;
    updateSelection();
    openBookDetail(displayedBooks[selectedIndex]);
  };

  detailPrev.addEventListener('click', () => navigateDetail(-1));
  detailNext.addEventListener('click', () => navigateDetail(1));

  // --- Dialog: close on backdrop click ---
  detailDialog.addEventListener('click', (e) => { if (e.target === detailDialog) detailDialog.close(); });
  helpDialog.addEventListener('click', (e) => { if (e.target === helpDialog) helpDialog.close(); });

  // Close buttons
  document.getElementById('detail-close').addEventListener('click', () => detailDialog.close());
  document.querySelector('.help-close-btn').addEventListener('click', () => helpDialog.close());

  // --- Book row click (event delegation) ---
  bookList.addEventListener('click', (e) => {
    const row = e.target.closest('.book-row');
    if (!row) return;
    const index = parseInt(row.dataset.index, 10);
    selectedIndex = index;
    updateSelection();
    openBookDetail(displayedBooks[index]);
  });

  // --- Selection visual ---
  const updateSelection = () => {
    const rows = bookList.querySelectorAll('.book-row');
    for (const [i, row] of rows.entries()) row.classList.toggle('selected', i === selectedIndex);
    rows[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  };

  // --- Keyboard navigation ---
  document.addEventListener('keydown', (e) => {
    const inSearch = document.activeElement === searchInput;
    const detailOpen = detailDialog.open;
    const helpOpen = helpDialog.open;

    if (e.key === 'Escape') {
      if (detailOpen) {
        requestAnimationFrame(() => bookList.querySelectorAll('.book-row')[selectedIndex]?.focus({ preventScroll: true }));
        return;
      }
      if (helpOpen) return;
      if (inSearch) { e.preventDefault(); searchInput.blur(); return; }
      return;
    }

    if (inSearch) return;

    // Arrow keys navigate books inside the detail dialog
    if (detailOpen && (e.key === 'ArrowDown' || e.key === 'ArrowRight')) {
      e.preventDefault();
      navigateDetail(1);
      return;
    }
    if (detailOpen && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      navigateDetail(-1);
      return;
    }

    if (detailOpen || helpOpen) return;

    const rows = bookList.querySelectorAll('.book-row');
    const maxIndex = rows.length - 1;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, maxIndex);
        updateSelection();
        break;
      case 'ArrowUp':
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        updateSelection();
        break;
      case 'Enter':
      case ' ':
        if (selectedIndex >= 0 && selectedIndex < displayedBooks.length) {
          e.preventDefault();
          openBookDetail(displayedBooks[selectedIndex]);
        }
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        searchInput.focus();
        break;
      case '?':
        e.preventDefault();
        helpDialog.showModal();
        break;
    }
  });

  detailDialog.addEventListener('close', () => {
    bookList.querySelectorAll('.book-row')[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    // Clear the hash so re-opening / sharing a fresh URL won't reopen.
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  });

  // --- Deep link: open the book referenced by location.hash on load and
  // whenever the hash changes (back/forward navigation).
  const openBookFromHash = () => {
    const id = parseInt(location.hash.slice(1), 10);
    if (!Number.isFinite(id)) return;
    const idx = displayedBooks.findIndex(b => b.id === id);
    if (idx === -1) return;
    selectedIndex = idx;
    updateSelection();
    openBookDetail(displayedBooks[idx]);
  };

  window.addEventListener('hashchange', () => {
    if (location.hash) openBookFromHash();
    else if (detailDialog.open) detailDialog.close();
  });

  // --- Init ---
  renderBooks(allBooks);
  openBookFromHash();

  // --- Service worker ---
  // The SW serves db.json stale-while-revalidate; when the background
  // fetch turns up a different payload it posts `db-updated`, so we
  // re-fetch (cache is now fresh) and re-render without a page reload.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');

    navigator.serviceWorker.addEventListener('message', async (event) => {
      if (event.data?.type !== 'db-updated') return;

      try {
        db = await (await fetch('db.json')).json();
        allBooks = Array.isArray(db?.books) ? db.books : [];
        allAuthors = Array.isArray(db?.authors) ? db.authors : [];
        authorById = new Map(allAuthors.map(a => [a.id, a]));
        renderBooks(visibleBooksForQuery());
      } catch (err) {
        console.warn('Failed to refresh db.json after SW update:', err);
      }
    });
  }
