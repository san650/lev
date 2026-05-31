# Lev — Personal Book Tracker

## Project Overview

Single-page book tracking app at books.42.uy. No frameworks — vanilla HTML/CSS/JS. Ruby CLI tools for data management.

## Claude Code Persona

Read `PERSONA.md` file to define the Claude Code Persona

## Commands

```bash
make server         # python3 -m http.server 8000 -d docs
make add            # ruby scripts/add_book.rb — search Goodreads, scrape metadata, download cover
make edit | update  # ruby scripts/edit_book.rb — refetch metadata from Goodreads, field-by-field update
make review         # ruby scripts/add_review.rb — select book, edit review via $EDITOR
make author         # ruby scripts/edit_author.rb — manage authors: edit name, aliases, merge, delete
make score          # ruby scripts/score_books.rb — bulk-set scores
make distribution   # ruby scripts/distribution.rb — print score/year/etc. distributions
make format         # ruby scripts/precommit.rb — sort + pretty-print db.json
make lookup         # ruby scripts/lookup.rb <ISBN-or-text-query> — fetch metadata from Open Library, Goodreads, Wikipedia (debug tool, does not mutate db.json)
make import         # ruby scripts/import_queue.rb — batch-import books from queue/
make reindex        # ruby scripts/rebuild_lists_index.rb — recompute per-book in_lists from docs/lists.json (pass --dry to preview)
make graph          # ruby scripts/rebuild_graph.rb — recompute docs/graph.json (similarity edges for graph.html)
make ingest <file>  # ruby scripts/ingest_list.rb — append new lists from a JSON file, then auto-run reindex + graph
make test           # run test/**/*_test.rb
```

Mutating scripts auto-commit to git after changes: "Add/Edit/Review &lt;title&gt; - &lt;author&gt; book".

## Design System

### Palette (five colors only)

| Variable | Hex | Usage |
|----------|-----|-------|
| `--c-deep` | `#1E104E` | Toolbar, primary text, dark sections |
| `--c-purple` | `#452E5A` | Secondary text, cover columns, footer |
| `--c-orange` | `#FF653F` | Accent, high scores, focus, hover inversion |
| `--c-yellow` | `#FFC85C` | Score badges, row hover, input focus |
| `--c-white` | `#FFFFFF` | Page background |

Derived: `--surface: #F4F1F7`, `--surface-alt: #EAE5F0`

### Typography — four fonts, each with a distinct role

| CSS Variable | Font | Weight | Role |
|-------------|------|--------|------|
| `--f-brand` | Space Mono | 700 | Toolbar brand, section labels, count strip |
| `--f-title` | DM Serif Display | 400 | Book titles, modal titles, review text |
| `--f-body` | Work Sans | 400, 600 | Author names, body text, metadata values |
| `--f-mono` | JetBrains Mono | 700 | ISBNs, scores, years, labels, placeholders |

Fonts are self-hosted WOFF2 files in `assets/`. Do not use Google Fonts CDN.

### Visual Rules

- **No borders.** Separate sections using background color changes only.
- **No rounded corners.** Keep the brutalist aesthetic.
- **No shadows.** Use color contrast for depth.
- **No external libraries.** All CSS and JS is hand-written.
- **Desktop**: app centered, max-width 640px.
- **Mobile-first** responsive design. Modal fills entire viewport on mobile.

### CSS Architecture — Layers + Utility-First

Three CSS layers declared at the top: `@layer reset, utility, component;`

- **`@layer reset`**: box-sizing, margin reset, base body styles
- **`@layer utility`**: one-property classes composed in HTML markup
- **`@layer component`**: stateful styles that can't be utility-composed (`:hover`, `:nth-child`, `::backdrop`, `dialog[open]`, `.selected`, responsive breakpoints)

Design tokens (`:root` custom properties) and `@font-face` live **outside** layers.

Each utility class maps to **one property**. Styling is composed by applying multiple classes in HTML markup:

```html
<nav class="bg-deep flex items-center gap-4 px-5 py-4">
  <span class="font-brand text-lg fw-700 uppercase tracking-wide color-white">Lev</span>
</nav>
```

Naming convention (Tailwind-inspired, simplified):
- Colors: `bg-deep`, `bg-purple`, `color-orange`, `color-white`, etc.
- Typography: `font-brand`, `font-title`, `text-lg`, `fw-700`, `uppercase`, `italic`
- Spacing: `p-4`, `px-5`, `py-3`, `gap-4`, `m-auto`
- Layout: `flex`, `flex-col`, `flex-1`, `grid`, `items-center`, `justify-between`

### Semantic HTML

Use semantic elements everywhere: `<nav>`, `<main>`, `<header>`, `<footer>`, `<dialog>`, `<section>`, `<article>`, `<kbd>`, `<time>`. Avoid generic `<div>` and `<span>` when a semantic element exists for the purpose. Use `<div>` only as a layout/grouping wrapper with no semantic meaning.

### JavaScript — Modern ES Modules

- `<script type="module">` — no global scope pollution
- Target: latest Chrome + iOS Safari (iPhone 12, iOS 26.4+)
- Use: `const`/`let`, arrow functions, template literals, optional chaining, `async`/`await`, `structuredClone`, `Array.at()`
- **Prefer CSS over JS.** Hover states, transitions, animations, responsive behavior, alternating backgrounds — all CSS. JS handles only: data fetching, DOM rendering, search filtering, dialog open/close wiring.
- Dialog animation uses CSS `@starting-style`, not JS

### Interactions

- Book row hover: yellow background, score inverts colors.
- Search input focus: background turns yellow.
- Modal: uses native `<dialog>` tag. Click outside or ESC to close.

### Keyboard Navigation

Global `keydown` listener with `selectedIndex` tracking. All keybindings are suppressed when the search input is focused (except ESC to blur).

| Key | Action |
|-----|--------|
| Arrow Down/Up | Navigate book list |
| Enter / Space | Open selected book detail |
| Esc | Close dialog / blur search / return to list |
| F | Focus search bar |
| ? | Open help modal with keybinding reference |

## File Conventions

- `docs/` contains everything served by GitHub Pages: `index.html` (book list), `stats.html`, `lists.html`, `404.html`, `CNAME`, `manifest.webmanifest`, `sw.js`, `assets/`, `covers/`, `db.json`, `lists.json`.
- `docs/db.json`: pretty-printed object with `authors` (sorted by name), `books` (sorted by title), `publishers`. Saga books sort by saga name then order within the group.
- `docs/lists.json`: curated recommended book lists. Read-only at runtime; sourced manually.
- Cover files: `docs/covers/<id>-<sanitized-title>.<ext>` (lowercase, hyphens, no spaces).
- Ruby code is split across two directories:
  - `scripts/` — thin executable entry points (one per `make` target), each `require_relative`s a module from `src/`.
  - `src/` — library modules with shared logic (`db.rb`, `authors.rb`, `lists_index.rb`, `http_client.rb`, `lookup/`, `book_form/`, etc.).
- `test/` holds `*_test.rb` files run by `make test`.
- `queue/` holds pending books for `make import`.
- `specs/` holds brainstorm and planning docs (e.g. `YYYY-MM-DD-<topic>-brainstorm.md`). All design discussions, brainstorms, and implementation plans go here — never in `docs/` (which is reserved for the deployed site).

## Data Schema

`db.json` is an object with three top-level collections:

```json
{ "authors": [...], "books": [...], "publishers": [...] }
```

**Authors** have: `id`, `name`, `aliases[]`. Sorted alphabetically by name.

**Books** have: `id`, `title`, `subtitle` (optional), `original_title`, `first_publishing_date`, `publish_dates[]`, `author_ids[]` (references to author IDs), `identifiers[]` (with `type` and `value`), `covers[]` (with `file` and `default`), `publisher`, `score` (1-10, optional — null shows as "–"), `review`, `saga` (optional — `{ "name": "...", "order": 1 }` or null), `in_lists` (optional — array of `{ list, position, title }` recomputed by `make reindex`). Sorted alphabetically by title.

### Saga Grouping (Option A — Group Header)

Books in a saga are grouped together under a colored header row (purple bg, brand font, yellow text). Within a group, books sort by `saga.order`. A yellow 3px separator marks the end of each saga group. Standalone books (no saga) sort alphabetically by title around the saga groups. Saga groups sort by saga name among the standalone books.

### Text Overflow

Book rows have fixed height. Title and subtitle each allow max 2 lines with ellipsis (`-webkit-line-clamp: 2`). Original title and author are single-line with `text-overflow: ellipsis`.

## Lists

Recommended book lists (Goodreads, NYT, Guardian, TIME, awards, etc.) are stored in `docs/lists.json` and rendered by `docs/lists.html` + `docs/assets/lists.js`. Top-level `next_list_id` and `next_entry_id` counters track stable int IDs assigned to each list and each entry — these IDs are the join keys consumed by the graph build and must never be re-used. Each list entry is `{ id, Position, TitleOriginal, TitleSpanish, Author, FirstPublicationYear, ... }`; each list is `{ id, Source, SourceUrl?, Notes, Confidence, ConfidenceReason, "Books/Stories": [...] }`.

`src/lists_index.rb` matches list entries to db books by normalized title + author tokens (NFD strip diacritics, lowercase, ASCII alphanumerics + CJK). It also resolves sagas: a list entry that names a saga collapses to its first volume when the db contains ≥2 books in that saga.

`make reindex` runs `scripts/rebuild_lists_index.rb` which:
1. Proposes list-side author names as aliases when they token-match a db author whose book the entry already resolved to (data hygiene).
2. Writes per-book `in_lists` arrays back into `db.json`. Pass `--dry` to preview without writing.

`make ingest <file>` is the one-shot import path for adding new curated lists. It validates the input schema, appends new lists to `docs/lists.json` (assigning fresh int IDs to the list and its entries from the top-of-file counters), then chains `make reindex` and `make graph` so all derived indices stay coherent. Skips lists whose `Source` is already present, so it's safe to re-run.

## Similarity Graph

`docs/graph.html` exposes the lists corpus as two interactive 1-hop similarity graphs — one over books, one over authors. The user picks a node from a filterable list; the page centers it in an SVG stage, fans its strongest neighbors around it, and shows full metadata (title, author, year, lists membership, read status, score) in a docked detail panel.

### Similarity algorithm (in plain words)

For each curated list in `docs/lists.json`, take every pair of books that appear together in that list and add **1** to their similarity score. Do the same for authors (each list contributes a +1 to every pair of authors that has at least one book in it). After processing all 22 lists, each pair carries a number from 1 to 22 — its **co-occurrence weight**, which is just "how many of these recommended lists agree these two belong together."

Pairs of weight 1 or 2 are coincidence and discarded. Only edges with **w ≥ 3** are written to `docs/graph.json`. In the focused view, each book/author also carries its `top_neighbors` array sorted by weight, so the radial layout is cheap to render: the heaviest connections sit closest to the center.

This is mathematically the same as the unnormalized intersection of the two nodes' list-membership sets: `w(A, B) = |Lists(A) ∩ Lists(B)|`. Books that appear in many lists naturally accumulate more neighbors; books in only one or two lists have no incident edges at all (their lists likely don't overlap with enough peers to clear the w ≥ 3 floor). That's fine — the graph is a map of canon, not of coverage.

### Files

- `src/graph.rb` builds the graph. Emits a slim `docs/graph.json` carrying only IDs and relationships — no titles, authors, or years. The client merges with `db.json` and `lists.json` at render time.
- `scripts/rebuild_graph.rb` is the CLI entry point used by `make graph`.
- `scripts/migrate_list_ids.rb` is a one-shot used once to assign initial IDs to legacy lists.json — kept for reference, idempotent if re-run.
- `docs/assets/graph.js` does the merge + SVG rendering + hash routing.

### graph.json shape

```json
{
  "generated_at": "...",
  "books":   { "nodes": [...], "edges": [[a, b, w], ...], "isolated_db_book_ids": [...] },
  "authors": { "nodes": [...], "edges": [[a, b, w], ...] }
}
```

Each node: `{ id, entry_ids, list_ids, list_count, db_book_id?, top_neighbors: [[id, w], ...], neighbor_count }`. Edges are compact `[a, b, w]` tuples (~50% smaller than object literals) sorted by weight descending.

The file is compact-printed (no pretty whitespace) because it's a fully-derived artifact — `make graph` rewrites it from scratch, so diff-friendliness adds no value.

## PWA / Service Worker

`docs/sw.js` precaches the app shell + assets and serves `db.json` with stale-while-revalidate. **Bump `VERSION` at the top of `sw.js` whenever shell assets change** so deployed clients refresh on next launch. Shell assets include the three HTML pages, their JS modules, fonts, icons, `lists.json`, and `graph.json`.

## Deployment

GitHub Pages serving from `docs/` directory with custom domain books.42.uy. 404.html redirects to index.html. CNAME file required.
