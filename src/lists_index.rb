# frozen_string_literal: true

require "json"
require "set"
require_relative "constants"

# Read-only index of recommended book lists (docs/lists.json), mirrored from
# the JS matcher in docs/assets/lists.js. Source of truth for which db books
# appear in which list and at what position. Writes the result back into the
# `in_lists` field on each book so the frontend doesn't need to re-run the
# matcher.

LISTS_PATH = File.join(ROOT_DIR, "docs", "lists.json")
SAGA_COMPLETE_THRESHOLD = 2
AUTHOR_NOISE = %w[jr sr ii iii iv phd md sir lord].freeze

module ListsIndex
  module_function

  def load_lists_data
    return { "Lists" => [] } unless File.exist?(LISTS_PATH)
    JSON.parse(File.read(LISTS_PATH, encoding: "UTF-8"))
  end

  # NFD strip diacritics, lowercase, keep ASCII alphanumerics + CJK.
  def normalize(str)
    return "" if str.nil?
    s = str.to_s.unicode_normalize(:nfkd)
    s = s.gsub(/\p{M}+/, "")
    s = s.downcase
    s = s.gsub(/[^a-z0-9一-鿿]+/, " ")
    s.strip
  end

  # Strip a trailing roman-numeral or 1-2 digit volume marker so "Los
  # demonios I" / "Los demonios II" collapse to the same key.
  def strip_suffix(norm)
    norm.sub(/\s+(i{1,3}|iv|v|vi{1,3}|\d{1,2})\z/, "").strip
  end

  def title_variants_for(*titles)
    out = Set.new
    titles.each do |t|
      n = normalize(t)
      next if n.empty?
      out << n
      s = strip_suffix(n)
      out << s if !s.empty? && s != n
    end
    out
  end

  def title_variants_for_book(book)
    title_variants_for(book["title"], book["original_title"], book["subtitle"])
  end

  def author_variants(name)
    n = normalize(name)
    return [] if n.empty?
    out = [n]
    n.split(" ").each do |t|
      out << t if t.length >= 4 && !AUTHOR_NOISE.include?(t)
    end
    out
  end

  def split_authors(str)
    return [] if str.nil?
    str.to_s.split(/\s*(?:,|;|\sy\s|\sand\s|&)\s*/i).map(&:strip).reject(&:empty?)
  end

  def author_keys_for_book(book, db)
    keys = Set.new
    (book["author_ids"] || []).each do |aid|
      author = db["authors"].find { |a| a["id"] == aid }
      next unless author
      author_variants(author["name"]).each { |v| keys << v }
      (author["aliases"] || []).each do |al|
        author_variants(al).each { |v| keys << v }
      end
    end
    keys
  end

  # Split a title into fragments when it looks like a compilation. " y " /
  # " and " / " & " / ":" / ";".
  def split_title_fragments(title)
    title.to_s.split(/\s+(?:y|and|&)\s+|\s*[;:]\s*/i).map(&:strip).reject(&:empty?)
  end

  def build_title_index(db)
    idx = {}
    db["books"].each do |book|
      keys = author_keys_for_book(book, db)
      title_variants_for_book(book).each do |t|
        (idx[t] ||= []) << { book_id: book["id"], author_keys: keys }
      end
    end
    idx
  end

  def build_saga_index(db)
    idx = {}
    db["books"].each do |book|
      name = book.dig("saga", "name")
      next if name.nil? || name.empty?
      key = normalize(name)
      next if key.empty?
      entry = (idx[key] ||= { book_ids: [], author_keys: Set.new })
      entry[:book_ids] << book["id"]
      author_keys_for_book(book, db).each { |k| entry[:author_keys] << k }
    end
    idx
  end

  def author_matches?(author_keys, candidates)
    candidates.any? { |k| author_keys.include?(k) }
  end

  def match_fragment(fragment, author_candidates, title_idx, saga_idx)
    title_variants_for(fragment).each do |t|
      hits = title_idx[t]
      if hits
        hits.each do |hit|
          return hit[:book_id] if author_matches?(hit[:author_keys], author_candidates)
        end
      end
      saga = saga_idx[t]
      if saga && saga[:book_ids].length >= SAGA_COMPLETE_THRESHOLD &&
         author_matches?(saga[:author_keys], author_candidates)
        return saga[:book_ids].first
      end
    end
    nil
  end

  def match_entry(entry, title_idx, saga_idx)
    author_candidates = Set.new
    split_authors(entry["Author"]).each do |a|
      author_variants(a).each { |v| author_candidates << v }
    end

    [entry["TitleSpanish"], entry["TitleOriginal"]].each do |t|
      next if t.nil? || t.empty?
      id = match_fragment(t, author_candidates, title_idx, saga_idx)
      return id if id
    end

    [entry["TitleSpanish"], entry["TitleOriginal"]].each do |t|
      next if t.nil? || t.empty?
      fragments = split_title_fragments(t)
      next if fragments.length < 2
      ids = fragments.map { |f| match_fragment(f, author_candidates, title_idx, saga_idx) }
      return ids.first if ids.all?
    end

    nil
  end

  # Build per-book reverse index: book_id => [{ list:, position:, title: }, ...].
  # `title` carries the entry's primary title so the frontend can re-key
  # the lookup by (list, position, title) — without it, two list rows that
  # share the same Position (ties in published rankings, eg. "Mugre rosa"
  # and "Las arañas de Marte" both at El Observador #4) would collide on
  # the lookup key and the unmatched row would inherit the matched row's
  # bookId, falsely showing as read.
  def build_membership(db, lists_data = load_lists_data)
    title_idx = build_title_index(db)
    saga_idx = build_saga_index(db)
    membership = Hash.new { |h, k| h[k] = [] }
    (lists_data["Lists"] || []).each do |list|
      list_name = list["Source"]
      (list["Books/Stories"] || []).each do |entry|
        id = match_entry(entry, title_idx, saga_idx)
        next unless id
        primary_title = entry["TitleSpanish"].to_s.empty? ? entry["TitleOriginal"] : entry["TitleSpanish"]
        membership[id] << {
          "list" => list_name,
          "position" => entry["Position"],
          "title" => primary_title
        }
      end
    end
    membership
  end

  # Recompute and assign in_lists on every book in db.
  def recompute_all!(db, lists_data = load_lists_data)
    membership = build_membership(db, lists_data)
    db["books"].each do |book|
      entries = membership[book["id"]] || []
      if entries.empty?
        book.delete("in_lists")
      else
        book["in_lists"] = entries
      end
    end
    db
  end

  # Find list-side author names that token-match an existing db author but
  # aren't recorded as that author's name or alias. Conservative: requires
  # that some book title in the same list entry resolves to the same db book
  # by title-only equality (so we have evidence the author is the same).
  def propose_aliases(db, lists_data = load_lists_data)
    title_idx = build_title_index(db)
    saga_idx = build_saga_index(db)
    proposals = []
    seen = Set.new # (author_id, alias) dedupe

    db_author_name_keys = db["authors"].each_with_object({}) do |a, h|
      keys = Set.new
      author_variants(a["name"]).each { |v| keys << v }
      (a["aliases"] || []).each { |al| author_variants(al).each { |v| keys << v } }
      h[a["id"]] = { author: a, keys: keys, known_names: Set.new([a["name"]] + (a["aliases"] || [])) }
    end

    (lists_data["Lists"] || []).each do |list|
      (list["Books/Stories"] || []).each do |entry|
        bid = match_entry(entry, title_idx, saga_idx)
        next unless bid
        book = db["books"].find { |b| b["id"] == bid }
        next unless book

        # For each list-side author name in this entry, propose it as an
        # alias of any db author the book is attributed to whose existing
        # name/aliases don't already cover the normalized form.
        split_authors(entry["Author"]).each do |raw_name|
          n = normalize(raw_name)
          next if n.empty?
          (book["author_ids"] || []).each do |aid|
            rec = db_author_name_keys[aid]
            next unless rec
            already_known = author_variants(raw_name).any? { |v| rec[:keys].include?(v) && v == n }
            next if already_known
            # require token overlap so we don't add unrelated names
            next unless author_variants(raw_name).any? { |v| rec[:keys].include?(v) }
            # exact-name dedupe (case-sensitive, but list providers use stable casing)
            next if rec[:known_names].include?(raw_name)
            key = [aid, raw_name]
            next if seen.include?(key)
            seen << key
            proposals << { author_id: aid, current_name: rec[:author]["name"], alias: raw_name }
          end
        end
      end
    end

    proposals
  end

  def apply_aliases!(db, proposals)
    return 0 if proposals.empty?
    applied = 0
    proposals.each do |p|
      author = db["authors"].find { |a| a["id"] == p[:author_id] }
      next unless author
      author["aliases"] ||= []
      next if author["aliases"].include?(p[:alias])
      next if author["name"] == p[:alias]
      author["aliases"] << p[:alias]
      applied += 1
    end
    # Keep alias arrays stable + deduped
    db["authors"].each do |a|
      next unless a["aliases"]
      a["aliases"] = a["aliases"].uniq
    end
    applied
  end
end
