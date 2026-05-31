  // --- Data: same SWR pattern as index.html ---
  let db = await (await fetch('db.json')).json();
  let listsData = await (await fetch('lists.json')).json().catch(() => ({ Lists: [] }));
  let books = Array.isArray(db?.books) ? db.books : [];
  let authors = Array.isArray(db?.authors) ? db.authors : [];
  let authorById = new Map(authors.map(a => [a.id, a]));

  const bookAuthorNames = (book) =>
    (book.author_ids ?? []).map(id => authorById.get(id)?.name).filter(Boolean);

  // --- Metric computation ---

  // 1. Total books, 2. total authors, 7. years tracked
  const computeHero = (books, authors) => {
    const years = books
      .map(b => parseInt(b.first_publishing_date, 10))
      .filter(Number.isFinite);
    const min = years.length ? Math.min(...years) : null;
    const max = years.length ? Math.max(...years) : null;
    return {
      books: books.length,
      authors: authors.length,
      yearMin: min,
      yearMax: max,
      yearSpan: min != null && max != null ? max - min + 1 : null
    };
  };

  // 3. Perfect 10s — alphabetical by title
  const computePerfectTens = (books) =>
    books
      .filter(b => b.score === 10)
      .sort((a, b) => a.title.localeCompare(b.title, 'es'));

  // 4. Score distribution
  const computeScoreDistribution = (books) => {
    const counts = Array(10).fill(0);
    for (const b of books) {
      if (typeof b.score === 'number' && b.score >= 1 && b.score <= 10) {
        counts[b.score - 1]++;
      }
    }
    return counts; // index 0 = score 1, ..., index 9 = score 10
  };

  // 4b. Score distribution stats — mean and deviation from scale midpoint.
  const computeScoreStats = (books) => {
    const scores = books.map(b => b.score).filter(s => typeof s === 'number');
    if (scores.length === 0) return null;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const midpoint = 5.5;
    return { mean, midpoint, delta: mean - midpoint };
  };

  // 5. Highest-ranked authors — Bayesian weighted
  // weight(n, mean) = mean * (1 - exp(-n/3))
  const computeRankedAuthors = (books, authors, top = 5) => {
    const byAuthor = new Map();
    for (const b of books) {
      if (typeof b.score !== 'number') continue;
      for (const aid of (b.author_ids ?? [])) {
        if (!byAuthor.has(aid)) byAuthor.set(aid, []);
        byAuthor.get(aid).push(b.score);
      }
    }
    const ranked = [];
    for (const [aid, scores] of byAuthor) {
      const author = authorById.get(aid);
      if (!author) continue;
      const n = scores.length;
      const mean = scores.reduce((a, b) => a + b, 0) / n;
      const weight = mean * (1 - Math.exp(-n / 3));
      ranked.push({ name: author.name, n, mean, weight });
    }
    ranked.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name, 'es'));
    return ranked.slice(0, top);
  };

  // 6. Most-read authors
  const computeMostRead = (books, authors, top = 5) => {
    const counts = new Map();
    for (const b of books) {
      for (const aid of (b.author_ids ?? [])) {
        counts.set(aid, (counts.get(aid) ?? 0) + 1);
      }
    }
    const ranked = [];
    for (const [aid, count] of counts) {
      const author = authorById.get(aid);
      if (!author) continue;
      ranked.push({ name: author.name, count });
    }
    ranked.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'));
    return ranked.slice(0, top);
  };

  // 7b. Books per decade — only populated decades, oldest first.
  const computeBooksPerDecade = (books) => {
    const counts = new Map();
    for (const b of books) {
      const year = parseInt(b.first_publishing_date, 10);
      if (!Number.isFinite(year)) continue;
      const decade = Math.floor(year / 10) * 10;
      counts.set(decade, (counts.get(decade) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([decade, count]) => ({ decade, count }))
      .sort((a, b) => a.decade - b.decade);
  };

  // 8. Best book per decade — only populated decades, all ties, alphabetical
  const computeBestPerDecade = (books) => {
    const byDecade = new Map();
    for (const b of books) {
      const year = parseInt(b.first_publishing_date, 10);
      if (!Number.isFinite(year)) continue;
      if (typeof b.score !== 'number') continue;
      const decade = Math.floor(year / 10) * 10;
      if (!byDecade.has(decade)) byDecade.set(decade, []);
      byDecade.get(decade).push(b);
    }
    const result = [];
    for (const [decade, bs] of byDecade) {
      const max = Math.max(...bs.map(b => b.score));
      const winners = bs
        .filter(b => b.score === max)
        .sort((a, b) => a.title.localeCompare(b.title, 'es'));
      result.push({ decade, score: max, books: winners });
    }
    result.sort((a, b) => a.decade - b.decade);
    return result;
  };

  // 9. Lists section — totals + top-10 by list appearances.
  // Each list entry is keyed by (normalized primary title, normalized
  // author) so the same work counted across multiple lists collapses to
  // one row. Read state is sourced from the precomputed in_lists map.
  const normalizeKey = (s) => (s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();

  const splitListAuthors = (str) => (str ?? '')
    .split(/\s*(?:,|;|\sy\s|\sand\s|&)\s*/i)
    .map(s => s.trim())
    .filter(Boolean);

  // Mirrors src/lists_index.rb: full normalized name + significant tokens
  // (≥4 chars, not an honorific) so "Frank Herbert" and "Frank Patrick
  // Herbert" share the "herbert" token.
  const AUTHOR_NOISE = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'sir', 'lord']);
  const listAuthorVariants = (name) => {
    const n = normalizeKey(name);
    if (!n) return [];
    const out = [n];
    for (const t of n.split(' ')) {
      if (t.length >= 4 && !AUTHOR_NOISE.has(t)) out.push(t);
    }
    return out;
  };

  const computeListsIndex = (books, authors, listsData) => {
    // (listName, position, normTitle) -> bookId, from db.in_lists.
    // Title disambiguates rows that share a Position (publication ties).
    const entryKey = (list, position, title) =>
      `${list}##${position}##${normalizeKey(title)}`;
    const entryToBook = new Map();
    for (const b of books) {
      for (const m of b.in_lists ?? []) {
        if (m.list && m.position != null) entryToBook.set(entryKey(m.list, m.position, m.title), b.id);
      }
    }

    // Read-author key set: every variant (full + tokens) of every db author
    // who has at least one book. List-side authors that share any of these
    // variants are considered "read".
    const dbAuthorBookCount = new Map();
    for (const b of books) for (const aid of (b.author_ids ?? [])) {
      dbAuthorBookCount.set(aid, (dbAuthorBookCount.get(aid) ?? 0) + 1);
    }
    const readAuthorKeys = new Set();
    for (const a of authors) {
      if (!dbAuthorBookCount.get(a.id)) continue;
      for (const v of listAuthorVariants(a.name)) readAuthorKeys.add(v);
      for (const al of (a.aliases ?? [])) for (const v of listAuthorVariants(al)) readAuthorKeys.add(v);
    }
    const isAuthorRead = (name) =>
      listAuthorVariants(name).some(v => readAuthorKeys.has(v));

    const byBook = new Map(); // key -> {primaryTitle, originalTitle, author, lists: Set, bookId}
    const byAuthor = new Map(); // normName -> {name, count, isRead}
    const authorsRead = new Set();
    const authorsAll = new Set();

    for (const list of listsData.Lists ?? []) {
      for (const e of list['Books/Stories'] ?? []) {
        const primary = e.TitleSpanish || e.TitleOriginal || '';
        const author = e.Author || '';
        const key = normalizeKey(primary) + '||' + normalizeKey(author);
        let rec = byBook.get(key);
        if (!rec) {
          rec = {
            primaryTitle: primary,
            originalTitle: e.TitleOriginal && e.TitleOriginal !== primary ? e.TitleOriginal : '',
            author,
            lists: new Set(),
            bookId: null
          };
          byBook.set(key, rec);
        }
        rec.lists.add(list.Source);
        if (rec.bookId == null) {
          const bid = entryToBook.get(entryKey(list.Source, e.Position, primary));
          if (bid != null) rec.bookId = bid;
        }
        for (const a of splitListAuthors(author)) {
          const an = normalizeKey(a);
          if (!an) continue;
          authorsAll.add(an);
          if (rec.bookId != null) authorsRead.add(an);
          let ar = byAuthor.get(an);
          if (!ar) {
            ar = { name: a, count: 0, isRead: isAuthorRead(a) };
            byAuthor.set(an, ar);
          }
          ar.count++;
        }
      }
    }

    const totals = {
      lists: (listsData.Lists ?? []).length,
      books: byBook.size,
      authors: authorsAll.size,
      booksRead: [...byBook.values()].filter(r => r.bookId != null).length,
      authorsRead: authorsRead.size
    };

    const top = [...byBook.values()]
      .sort((a, b) => b.lists.size - a.lists.size ||
                      a.primaryTitle.localeCompare(b.primaryTitle, 'es'))
      .slice(0, 10);

    const topAuthors = [...byAuthor.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'))
      .slice(0, 10);

    return { totals, top, topAuthors };
  };

  // --- Renderers ---

  const $ = (id) => document.getElementById(id);

  const renderHero = (h, scoreStats) => {
    $('hero-books').textContent = h.books;
    $('hero-authors').textContent = h.authors;
    $('hero-span').textContent = h.yearSpan ?? '–';
    $('hero-avg').textContent = scoreStats ? scoreStats.mean.toFixed(1) : '–';
  };

  const renderPerfectTens = (list) => {
    const ul = $('perfect-tens');
    ul.replaceChildren();
    if (list.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No perfect 10s yet.';
      ul.appendChild(li);
      return;
    }
    for (const b of list) {
      const li = document.createElement('li');
      const mark = document.createElement('span');
      mark.className = 'trophy-mark';
      mark.textContent = '10';
      const title = document.createElement('a');
      title.className = 'trophy-title flex-1 book-link';
      title.href = `index.html#${b.id}`;
      title.textContent = b.title;
      const author = document.createElement('span');
      author.className = 'trophy-author';
      author.textContent = bookAuthorNames(b).join(', ') || 'Unknown';
      li.append(mark, title, author);
      ul.appendChild(li);
    }
  };

  const renderScoreStats = (stats) => {
    const el = $('score-stats');
    if (!stats) { el.textContent = ''; return; }
    const sign = stats.delta >= 0 ? '+' : '';
    el.textContent = `mean ${stats.mean.toFixed(2)} · midpoint ${stats.midpoint.toFixed(2)} · Δ ${sign}${stats.delta.toFixed(2)}`;
  };

  const renderScoreChart = (counts) => {
    const wrap = $('score-chart');
    wrap.replaceChildren();
    const max = Math.max(...counts, 1);
    // Render in descending order (10 → 1)
    for (let s = 10; s >= 1; s--) {
      const count = counts[s - 1];
      const row = document.createElement('div');
      row.className = 'score-chart-row';

      const badge = document.createElement('span');
      badge.className = `badge score-${s}`;
      badge.textContent = s;

      const bar = document.createElement('span');
      bar.className = `bar score-${s}`;
      bar.style.width = `${(count / max) * 100}%`;
      if (count === 0) bar.style.opacity = '0.3';

      const num = document.createElement('span');
      num.className = 'count';
      num.textContent = count;

      row.append(badge, bar, num);
      wrap.appendChild(row);
    }
  };

  const renderRankedAuthors = (ranked) => {
    const ol = $('ranked-authors');
    ol.replaceChildren();
    if (ranked.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Not enough scored books yet.';
      ol.appendChild(li);
      return;
    }
    ranked.forEach((r, i) => {
      const li = document.createElement('li');
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = i + 1;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = r.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${r.weight.toFixed(2)} · ${r.n} ${r.n === 1 ? 'book' : 'books'} · avg ${r.mean.toFixed(1)}`;
      li.append(rank, name, meta);
      ol.appendChild(li);
    });
  };

  const renderMostRead = (ranked) => {
    const ol = $('read-authors');
    ol.replaceChildren();
    if (ranked.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No books yet.';
      ol.appendChild(li);
      return;
    }
    ranked.forEach((r, i) => {
      const li = document.createElement('li');
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = i + 1;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = r.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${r.count} ${r.count === 1 ? 'book' : 'books'}`;
      li.append(rank, name, meta);
      ol.appendChild(li);
    });
  };

  const renderBooksPerDecade = (data) => {
    const wrap = $('decade-chart');
    wrap.replaceChildren();
    if (data.length === 0) return;
    const max = Math.max(...data.map(d => d.count), 1);
    for (const { decade, count } of data) {
      const row = document.createElement('div');
      row.className = 'decade-chart-row';

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = `${decade}s`;

      const bar = document.createElement('span');
      bar.className = 'bar';
      bar.style.width = `${(count / max) * 100}%`;
      if (count === 0) bar.style.opacity = '0.2';

      const num = document.createElement('span');
      num.className = 'count';
      num.textContent = count;

      row.append(label, bar, num);
      wrap.appendChild(row);
    }
  };

  const renderDecades = (groups) => {
    const wrap = $('decade-list');
    wrap.replaceChildren();
    if (groups.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty px-5 py-3 color-mid';
      p.textContent = 'No decade data yet.';
      wrap.appendChild(p);
      return;
    }
    for (const g of groups) {
      const block = document.createElement('div');
      block.className = 'decade-group';

      // Left: marker — dot + year label styled like a title.
      const marker = document.createElement('div');
      marker.className = 'decade-marker';
      const dot = document.createElement('span');
      dot.className = 'decade-dot';
      const label = document.createElement('span');
      label.className = 'decade-label';
      label.textContent = `${g.decade}s`;
      marker.append(dot, label);

      // Middle: book titles + authors. All books in a decade share the
      // same score (it's the decade max), so the score is rendered once
      // per group on the right column.
      const books = document.createElement('div');
      books.className = 'decade-books';
      for (const b of g.books) {
        const row = document.createElement('div');
        row.className = 'decade-row';
        const title = document.createElement('a');
        title.className = 'decade-title book-link';
        title.href = `index.html#${b.id}`;
        title.textContent = b.title;
        const author = document.createElement('span');
        author.className = 'decade-author';
        author.textContent = bookAuthorNames(b).join(', ') || 'Unknown';
        row.append(title, author);
        books.appendChild(row);
      }

      // Right: shared score badge for the group.
      const score = document.createElement('span');
      score.className = 'decade-score';
      score.textContent = `${g.score}/10`;

      block.append(marker, books, score);
      wrap.appendChild(block);
    }
  };

  const renderListsTotals = (t) => {
    $('lists-stat-lists').textContent = t.lists;
    $('lists-stat-books').textContent = t.books;
    $('lists-stat-authors').textContent = t.authors;
    $('lists-stat-books-read').textContent = t.booksRead;
    $('lists-stat-authors-read').textContent = t.authorsRead;
  };

  const renderMostListed = (top) => {
    const ol = $('most-listed');
    ol.replaceChildren();
    if (top.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No list data yet.';
      ol.appendChild(li);
      return;
    }
    top.forEach((rec, i) => {
      const li = document.createElement('li');

      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = i + 1;

      const check = document.createElement('span');
      check.className = `list-check ${rec.bookId != null ? 'check-read' : 'check-empty'}`;
      check.setAttribute('aria-hidden', 'true');
      if (rec.bookId != null) check.textContent = '✓';

      const titleBlock = document.createElement('div');
      titleBlock.className = 'most-listed-titles min-w-0';
      const title = document.createElement(rec.bookId != null ? 'a' : 'span');
      title.className = 'most-listed-title';
      if (rec.bookId != null) {
        title.href = `index.html#${rec.bookId}`;
        title.classList.add('book-link');
      }
      title.textContent = rec.primaryTitle;
      titleBlock.appendChild(title);
      if (rec.originalTitle) {
        const orig = document.createElement('p');
        orig.className = 'most-listed-original';
        orig.textContent = rec.originalTitle;
        titleBlock.appendChild(orig);
      }
      const author = document.createElement('p');
      author.className = 'most-listed-author';
      author.textContent = rec.author;
      titleBlock.appendChild(author);

      const count = document.createElement('span');
      count.className = 'most-listed-count';
      count.textContent = `${rec.lists.size}`;

      li.append(rank, check, titleBlock, count);
      ol.appendChild(li);
    });
  };

  const renderMostListedAuthors = (top) => {
    const ol = $('most-listed-authors');
    ol.replaceChildren();
    if (top.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No list data yet.';
      ol.appendChild(li);
      return;
    }
    top.forEach((rec, i) => {
      const li = document.createElement('li');
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = i + 1;
      const check = document.createElement('span');
      check.className = `list-check ${rec.isRead ? 'check-read' : 'check-empty'}`;
      check.setAttribute('aria-hidden', 'true');
      if (rec.isRead) check.textContent = '✓';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = rec.name;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = rec.count;
      li.append(rank, check, name, count);
      ol.appendChild(li);
    });
  };

  // --- Render everything ---
  const renderAll = () => {
    const scoreStats = computeScoreStats(books);
    renderHero(computeHero(books, authors), scoreStats);
    renderPerfectTens(computePerfectTens(books));
    renderScoreStats(scoreStats);
    renderScoreChart(computeScoreDistribution(books));
    renderRankedAuthors(computeRankedAuthors(books, authors));
    renderMostRead(computeMostRead(books, authors));
    renderBooksPerDecade(computeBooksPerDecade(books));
    renderDecades(computeBestPerDecade(books));
    const listsIndex = computeListsIndex(books, authors, listsData);
    renderListsTotals(listsIndex.totals);
    renderMostListed(listsIndex.top);
    renderMostListedAuthors(listsIndex.topAuthors);
  };

  renderAll();

  // --- Service worker — refresh on db.json change ---
  const { registerServiceWorker } = await import('./register-sw.js');
  registerServiceWorker(async () => {
    try {
      db = await (await fetch('db.json')).json();
      listsData = await (await fetch('lists.json')).json().catch(() => listsData);
      books = Array.isArray(db?.books) ? db.books : [];
      authors = Array.isArray(db?.authors) ? db.authors : [];
      authorById = new Map(authors.map(a => [a.id, a]));
      renderAll();
    } catch (err) {
      console.warn('Failed to refresh db.json after SW update:', err);
    }
  });
