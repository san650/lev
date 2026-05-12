# frozen_string_literal: true

require_relative "constants"
require_relative "console_ui"
require_relative "db"
require_relative "authors"
require_relative "text"
require_relative "git"
require_relative "http_client"
require_relative "lookup/lookup"
require_relative "book_form/flatten"
require_relative "book_form/build_options"
require_relative "book_form/collectors"
require_relative "book_form/pickers"
require_relative "book_form/cli_picker"
require_relative "book_form/author_resolution"
require_relative "lookup/standardize"

# Collect normalized ISBN candidates from the original query (if it is an
# ISBN) plus every identifier returned by the lookup sources.
def collect_candidate_isbns(query, pairs)
  isbns = []
  q = normalize_isbn(query)
  isbns << q if q
  pairs.each do |_source, record|
    (record["identifiers"] || []).each do |id|
      cleaned = normalize_isbn(id["value"])
      isbns << cleaned if cleaned
    end
  end
  isbns.uniq
end

def find_existing_book(books, title:, isbns:)
  needle = title.to_s.downcase
  books.find do |b|
    next true if b["title"].to_s.downcase == needle

    (b["identifiers"] || []).any? do |id|
      cleaned = normalize_isbn(id["value"])
      cleaned && isbns.include?(cleaned)
    end
  end
end

# Cover download — tries the chosen URL first, then falls back to the
# OpenLibrary ISBN cover endpoint.
def download_cover(cover_url, isbn, book_id, title, http: DEFAULT_HTTP)
  FileUtils.mkdir_p(COVERS_DIR)
  sanitized = sanitize_title(title)
  filename = "#{book_id}-#{sanitized}.jpg"
  dest = File.join(COVERS_DIR, filename)

  if cover_url && !cover_url.empty?
    UI.current.say "\nDownloading cover from #{cover_url}..."
    if http.download(cover_url, dest) && File.size(dest) > 1000
      UI.current.say "  Cover saved: covers/#{filename}"
      return "covers/#{filename}"
    else
      File.delete(dest) if File.exist?(dest)
      UI.current.say "  Cover download failed or too small, trying ISBN fallback..."
    end
  end

  if isbn && !isbn.empty?
    ol_url = "https://covers.openlibrary.org/b/isbn/#{URI.encode_www_form_component(isbn)}-L.jpg"
    UI.current.say "  Trying OpenLibrary ISBN cover..."
    if http.download(ol_url, dest) && File.size(dest) > 1000
      UI.current.say "  Cover saved: covers/#{filename}"
      return "covers/#{filename}"
    end
    File.delete(dest) if File.exist?(dest)
  end

  UI.current.say "  No cover available."
  nil
end

# Orchestrator — pure-ish, takes db + picker + http and produces (or
# persists when save: true) a new book entry.
def add_book(db:, query:, http: DEFAULT_HTTP, picker: CLIPicker.new, save: true, download_covers: true)
  books = db["books"]

  pairs = []
  if !query.to_s.empty?
    result = lookup(query, http: http)
    pairs = flatten_lookup(result)
  end

  candidate_isbns = collect_candidate_isbns(query, pairs)

  title_candidates = collect_field(pairs, exclude_context: :title) { |r| r["title"] }
  title = picker.single("Title", title_candidates, required: true)

  existing = find_existing_book(books, title: title, isbns: candidate_isbns)
  return { existing: existing } if existing

  subtitle_candidates = collect_field(pairs) { |r| r["subtitle"] }
  subtitle = picker.single("Subtitle", subtitle_candidates).to_s

  original_candidates = collect_field(pairs) { |r| r["original_title"] }
  original_title = picker.single("Original title", original_candidates).to_s

  first_pub_candidates = collect_field(pairs) { |r| r["first_publishing_date"] }
  first_pub = extract_year(picker.single("First publishing year", first_pub_candidates)).to_s

  authors_candidates = collect_field(pairs) { |r| r["authors"] }
  authors_candidates = canonicalize_author_candidates(db, authors_candidates)
  author_names = picker.multi("Authors", authors_candidates)
  author_names = picker.author_fallback_names if author_names.empty?
  author_ids = author_names.empty? ? [] : resolve_author_ids(db, author_names)

  identifiers_candidates = collect_identifiers(pairs)
  picked_ids = picker.multi("Identifiers (ISBN-10 / ISBN-13)",
                            identifiers_candidates,
                            format_value: ->(v) { "#{v["type"]}: #{v["value"]}" })
  identifiers = picked_ids.map do |id|
    next id if id.is_a?(Hash)
    val = id.to_s.gsub(/[\s\-]/, "")
    type = val.length == 13 ? "ISBN_13" : (val.length == 10 ? "ISBN_10" : "ISBN")
    { "type" => type, "value" => val }
  end

  publisher = picker.publisher(pairs, db)

  saga_candidates = collect_sagas(pairs)
  saga = picker.single("Saga",
                       saga_candidates,
                       format_value: ->(v) { "#{v["name"]} ##{v["order"]}" })
  saga = nil if saga.is_a?(String) && saga.empty?
  if saga.is_a?(String) && !saga.empty?
    saga = { "name" => saga, "order" => picker.saga_order }
  end

  cover_candidates = collect_field(pairs) { |r| r["cover_url"] }
  cover_url = picker.single("Cover URL", cover_candidates)
  cover_url = nil if cover_url.to_s.empty?

  score = picker.required_score

  book_id = next_id(books)
  primary_isbn = (identifiers.find { |id| id["type"] == "ISBN_13" } ||
                  identifiers.find { |id| id["type"] == "ISBN_10" })&.dig("value")

  cover_path = download_covers ? download_cover(cover_url, primary_isbn, book_id, title, http: http) : nil
  covers = cover_path ? [{ "file" => cover_path, "default" => true }] : []

  book = {
    "id" => book_id,
    "title" => title,
    "subtitle" => subtitle.to_s,
    "original_title" => original_title.to_s,
    "first_publishing_date" => first_pub.to_s,
    "author_ids" => author_ids,
    "identifiers" => identifiers,
    "covers" => covers,
    "publisher" => publisher,
    "saga" => saga,
    "score" => score,
    "review" => ""
  }

  return { book: book, saved: false } unless picker.confirm_save

  if save
    books << book
    save_db(db)
  end

  { book: book, saved: save }
end

# CLI entrypoint — invoked from scripts/add_book.rb.
def add_book_cli(argv = ARGV)
  UI.current.say "=" * 50
  UI.current.say "  Lev — Add a Book"
  UI.current.say "=" * 50

  db = load_db
  query = argv.join(" ").strip
  if query.empty?
    query = prompt("\nLookup (ISBN or title; blank to enter manually)")
  else
    UI.current.say "\nLookup: #{query}"
  end

  if query.empty?
    UI.current.say "\nSkipping lookup — manual entry."
  else
    UI.current.say "\nLookup query: #{query}"
  end

  outcome = add_book(db: db, query: query, picker: CLIPicker.new)

  if outcome[:existing]
    book = outcome[:existing]
    names = resolve_author_names(db, book)
    author_name = names.first || "Unknown"
    UI.current.say "\n  Book already exists: \"#{book["title"]}\" by #{author_name} (ID: #{book["id"]})"
    UI.current.say "  To edit it, run: ruby scripts/edit_book.rb"
    exit 0
  end

  book = outcome[:book]

  UI.current.say "\n" + "=" * 50
  UI.current.say "  Book Summary"
  UI.current.say "=" * 50
  UI.current.say "  Title:       #{book["title"]}"
  UI.current.say "  Subtitle:    #{book["subtitle"]}" unless book["subtitle"].empty?
  UI.current.say "  Original:    #{book["original_title"]}" unless book["original_title"].empty?
  UI.current.say "  Authors:     #{resolve_author_names(db, book).join(", ")}"
  UI.current.say "  First pub:   #{book["first_publishing_date"]}" unless book["first_publishing_date"].empty?
  book["identifiers"].each { |id| UI.current.say "  #{id["type"]}:    #{id["value"]}" }
  UI.current.say "  Publisher:   #{book["publisher"]}"
  UI.current.say "  Saga:        #{book["saga"]["name"]} ##{book["saga"]["order"]}" if book["saga"]
  UI.current.say "  Score:       #{book["score"]}/10"
  cover_file = book["covers"].first&.dig("file")
  UI.current.say "  Cover:       #{cover_file || "none"}"
  UI.current.say "  ID:          #{book["id"]}"
  UI.current.say ""

  if outcome[:saved]
    UI.current.say "Book saved to db.json! (ID: #{book["id"]})"
    git_auto_commit("Add", book, db, include_covers: true)
  else
    UI.current.say "Cancelled. Book not saved."
  end
end
