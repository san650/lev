# frozen_string_literal: true

# precommit.rb — Pre-commit validation:
#   1. Format and validate docs/db.json
#   2. Syntax-check every Ruby file under src/
#   3. Syntax-check every Ruby file under scripts/
#   4. Run the test suite
# Any failure exits non-zero; the hook then aborts the commit.

require "json"
require "tempfile"
require "fileutils"
require "open3"

require_relative "constants"
require_relative "lists_index"

# DB_PATH and LISTS_PATH come from constants.rb / lists_index.rb. We define
# PRECOMMIT_ROOT for backward-compat with any callers that already use it.
PRECOMMIT_ROOT = ROOT_DIR

# ---------------------------------------------------------------------------
# ISBN-13 hyphenation using embedded range data from isbn-international.org
# ---------------------------------------------------------------------------

# Registration group ranges for 978 prefix.
# Each entry: [range, group_length]
ISBN_GROUPS_978 = [
  [0..5, 1], [7..7, 1],
  [80..94, 2],
  [600..625, 3], [950..989, 3],
  [9926..9989, 4],
  [99901..99981, 5],
].freeze

# Registrant ranges per group. After extracting the group, the remaining
# digits (registrant + publication) are right-padded with zeros to 7 digits
# and compared against these ranges to determine the registrant length.
# Source: ISBN RangeMessage (isbn-international.org)
ISBN_REGISTRANT_RANGES = {
  "0" => [
    [0, 1999999, 2], [2000000, 2279999, 3], [2280000, 2289999, 4],
    [2290000, 6389999, 3], [6390000, 6397999, 4], [6398000, 6399999, 7],
    [6400000, 6479999, 3], [6480000, 6489999, 7], [6500000, 6599999, 4],
    [6600000, 6999999, 3], [7000000, 8499999, 4], [8500000, 8999999, 5],
    [9000000, 9499999, 6], [9500000, 9999999, 7],
  ],
  "1" => [
    [0, 999999, 2], [1000000, 3999999, 3], [4000000, 5499999, 4],
    [5500000, 8697999, 5], [8698000, 9989999, 6], [9990000, 9999999, 7],
  ],
  "2" => [
    [0, 1999999, 2], [2000000, 3499999, 3], [3500000, 3999999, 5],
    [4000000, 6999999, 3], [7000000, 8399999, 4], [8400000, 8999999, 5],
    [9000000, 9499999, 6], [9500000, 9999999, 7],
  ],
  "3" => [
    [0, 299999, 2], [300000, 339999, 3], [400000, 699999, 3],
    [2000000, 6999999, 4], [7000000, 8499999, 5], [8500000, 8999999, 5],
    [9000000, 9499999, 6], [9500000, 9539999, 7], [9600000, 9799999, 5],
    [9800000, 9899999, 6], [9900000, 9999999, 5],
  ],
  "4" => [
    [0, 1999999, 2], [2000000, 6999999, 3], [7000000, 8499999, 4],
    [8500000, 8999999, 5], [9000000, 9499999, 6], [9500000, 9999999, 7],
  ],
  "5" => [
    [0, 499999, 2], [500000, 999999, 3], [1000000, 1999999, 4],
    [2000000, 3619999, 5], [3700000, 4499999, 4], [4500000, 6039999, 5],
    [6050000, 6999999, 4], [7000000, 8499999, 3], [8500000, 8999999, 4],
    [9000000, 9099999, 5], [9100000, 9199999, 4], [9200000, 9299999, 5],
    [9300000, 9499999, 4], [9500000, 9799999, 5], [9800000, 9899999, 4],
    [9900000, 9909999, 7], [9910000, 9999999, 5],
  ],
  "7" => [
    [0, 999999, 2], [1000000, 4999999, 3], [5000000, 7999999, 4],
    [8000000, 8999999, 5], [9000000, 9999999, 6],
  ],
  "84" => [
    [0, 1099999, 2], [1100000, 1199999, 6], [1200000, 1299999, 4],
    [1300000, 1399999, 3], [1400000, 1499999, 5], [1500000, 1999999, 5],
    [2000000, 6999999, 3], [7000000, 8499999, 4], [8500000, 8999999, 5],
    [9000000, 9199999, 4], [9200000, 9239999, 6], [9240000, 9299999, 5],
    [9300000, 9499999, 6], [9500000, 9699999, 5], [9700000, 9999999, 4],
  ],
  "85" => [
    [0, 1999999, 2], [2000000, 4549999, 3], [4550000, 5299999, 4],
    [5300000, 5399999, 5], [5400000, 5999999, 4], [6000000, 6999999, 5],
    [7000000, 7999999, 4], [8000000, 8499999, 5], [8500000, 8999999, 4],
    [9000000, 9249999, 5], [9250000, 9999999, 6],
  ],
  "87" => [
    [0, 2999999, 2], [4000000, 6499999, 3], [7000000, 7999999, 4],
    [8500000, 9699999, 5], [9700000, 9999999, 6],
  ],
  "88" => [
    [0, 1999999, 2], [2000000, 3119999, 3], [3120000, 3149999, 5],
    [3150000, 3189999, 4], [3190000, 5999999, 3], [6000000, 8499999, 4],
    [8500000, 8999999, 5], [9000000, 9299999, 6], [9300000, 9499999, 4],
    [9500000, 9999999, 5],
  ],
  "89" => [
    [0, 2499999, 2], [2500000, 5499999, 3], [5500000, 8499999, 4],
    [8500000, 9499999, 5], [9500000, 9699999, 6], [9700000, 9899999, 5],
    [9900000, 9999999, 6],
  ],
  "950" => [
    [0, 499999, 2], [500000, 899999, 3], [900000, 989999, 4],
    [990000, 999999, 5],
  ],
  "987" => [
    [0, 999999, 2], [1000000, 1999999, 4], [2000000, 2999999, 5],
    [3000000, 3599999, 2], [3600000, 4499999, 4], [4500000, 4899999, 5],
    [4900000, 4999999, 6], [5000000, 8249999, 3], [8250000, 8279999, 6],
    [8300000, 8499999, 4], [8500000, 8999999, 5], [9000000, 9499999, 4],
    [9500000, 9999999, 5],
  ],
  "989" => [
    [0, 1999999, 1], [2000000, 3499999, 2], [3500000, 4999999, 3],
    [5000000, 7999999, 4], [8000000, 9499999, 5], [9500000, 9999999, 6],
  ],
}.freeze

def hyphenate_isbn13(isbn)
  return isbn if isbn.include?("-")

  digits = isbn.gsub(/\s/, "")
  return isbn unless digits.match?(/\A\d{13}\z/)

  prefix = digits[0, 3]
  return isbn unless prefix == "978" || prefix == "979"
  return isbn unless prefix == "978" # only 978 ranges embedded for now

  rest = digits[3..] # 10 digits: group + registrant + publication + check

  # Find group length
  group_len = nil
  ISBN_GROUPS_978.each do |range, len|
    val = rest[0, len].to_i
    if range.include?(val)
      group_len = len
      break
    end
  end
  return isbn unless group_len

  group = rest[0, group_len]
  check = rest[-1]
  reg_pub = rest[group_len..-2] # registrant + publication (without check)

  # Look up registrant length
  ranges = ISBN_REGISTRANT_RANGES[group]
  return isbn unless ranges

  # Right-pad to 7 digits for range comparison
  cmp = "#{reg_pub}#{"0" * 7}"[0, 7].to_i

  reg_len = nil
  ranges.each do |range_start, range_end, len|
    if cmp >= range_start && cmp <= range_end
      reg_len = len
      break
    end
  end
  return isbn unless reg_len&.positive?

  registrant = reg_pub[0, reg_len]
  publication = reg_pub[reg_len..]

  "#{prefix}-#{group}-#{registrant}-#{publication}-#{check}"
end

def format_isbns!(books)
  books.each do |book|
    (book["identifiers"] || []).each do |id|
      next unless id["type"] == "ISBN"

      id["value"] = hyphenate_isbn13(id["value"])
    end
  end
end

# --- Step 1: db.json --------------------------------------------------------

def validate_db_json
  unless File.exist?(DB_PATH)
    warn "  db.json not found, skipping format."
    return
  end

  raw = File.read(DB_PATH, encoding: "UTF-8")
  data = JSON.parse(raw)

  unless data.is_a?(Hash) && data.key?("authors") && data.key?("books")
    raise "db.json is not in expected format (expected { authors, books })."
  end

  authors = data["authors"]
  books = data["books"]

  authors.sort_by! { |a| a["id"].to_i }
  id_remap = {}
  authors.each_with_index do |author, i|
    old_id = author["id"]
    new_id = i + 1
    id_remap[old_id] = new_id if old_id != new_id
    author["id"] = new_id
  end

  unless id_remap.empty?
    books.each do |book|
      book["author_ids"] = (book["author_ids"] || []).map { |aid| id_remap[aid] || aid }
    end
  end

  books.sort_by! { |b| b["id"].to_i }
  books.each_with_index { |book, i| book["id"] = i + 1 }

  format_isbns!(books)

  formatted = JSON.pretty_generate(data)
  JSON.parse(formatted) # paranoid round-trip check

  tmp = Tempfile.new("db", File.dirname(DB_PATH))
  tmp.write(formatted)
  tmp.write("\n")
  tmp.close
  FileUtils.mv(tmp.path, DB_PATH)

  system("git", "add", DB_PATH)

  puts "  db.json formatted (#{authors.size} authors, #{books.size} books)"
rescue JSON::ParserError => e
  raise "db.json is not valid JSON — #{e.message}"
end

# --- Step 1b: lists.json dedupe --------------------------------------------
#
# Walks every list entry and unifies its TitleSpanish / TitleOriginal /
# Author spellings against a single canonical source:
#
#   - When the entry matches a db book (via the existing fuzzy matcher),
#     we copy the spellings straight from db.json. db is the source of
#     truth, so "Anna Karénina" written three different ways across three
#     lists collapses to the one form db carries.
#   - When no db book matches, we still want list-internal coherence — the
#     first time we see an (normalized-title, normalized-author) pair we
#     stash its spellings as canonical, and rewrite any later entry that
#     loosely resolves to the same identity.
#
# Returns the number of fields rewritten so the caller can log it.

def canonical_from_db(db)
  authors_by_id = (db["authors"] || []).each_with_object({}) { |a, h| h[a["id"]] = a }
  (db["books"] || []).each_with_object({}) do |book, h|
    next unless book["id"]
    names = (book["author_ids"] || []).map { |aid| authors_by_id[aid]&.dig("name") }.compact
    next if names.empty?
    h[book["id"]] = {
      "TitleSpanish" => book["title"],
      "TitleOriginal" => book["original_title"].to_s.empty? ? book["title"] : book["original_title"],
      "Author" => names.join(", ")
    }
  end
end

def literal_key_for(entry)
  primary = entry["TitleSpanish"].to_s.empty? ? entry["TitleOriginal"] : entry["TitleSpanish"]
  title_key = ListsIndex.strip_suffix(ListsIndex.normalize(primary.to_s))
  first_author = ListsIndex.split_authors(entry["Author"]).first || entry["Author"].to_s
  [title_key, ListsIndex.normalize(first_author)]
end

def dedupe_lists_data!(db, lists_data)
  return 0 unless lists_data.is_a?(Hash) && lists_data["Lists"].is_a?(Array)

  title_idx = ListsIndex.build_title_index(db)
  saga_idx = ListsIndex.build_saga_index(db)
  db_canonical = canonical_from_db(db)
  literal_canonical = {} # [title_key, author_key] -> canonical spellings hash

  rewritten = 0
  lists_data["Lists"].each do |list|
    (list["Books/Stories"] || []).each do |entry|
      bid = ListsIndex.match_entry(entry, title_idx, saga_idx)
      canonical = bid ? db_canonical[bid] : nil

      if canonical.nil?
        # No db match — fall back to the first-seen literal identity. Both
        # title and author must be non-empty for the key to be meaningful.
        key = literal_key_for(entry)
        next if key.first.empty? || key.last.empty?
        canonical = literal_canonical[key] ||= {
          "TitleSpanish" => entry["TitleSpanish"],
          "TitleOriginal" => entry["TitleOriginal"],
          "Author" => entry["Author"]
        }
      end

      %w[TitleSpanish TitleOriginal Author].each do |field|
        new_val = canonical[field]
        next if new_val.nil? || new_val.empty?
        next if entry[field] == new_val
        entry[field] = new_val
        rewritten += 1
      end
    end
  end

  rewritten
end

def validate_lists_json
  unless File.exist?(LISTS_PATH)
    warn "  lists.json not found, skipping dedup."
    return
  end
  unless File.exist?(DB_PATH)
    warn "  db.json missing, skipping lists dedup (need db spellings as source of truth)."
    return
  end

  db = JSON.parse(File.read(DB_PATH, encoding: "UTF-8"))
  lists_data = JSON.parse(File.read(LISTS_PATH, encoding: "UTF-8"))

  rewritten = dedupe_lists_data!(db, lists_data)

  if rewritten.zero?
    puts "  lists.json already deduped (0 fields rewritten)"
    return
  end

  formatted = JSON.pretty_generate(lists_data)
  JSON.parse(formatted) # paranoid round-trip

  tmp = Tempfile.new("lists", File.dirname(LISTS_PATH))
  tmp.write(formatted)
  tmp.write("\n")
  tmp.close
  FileUtils.mv(tmp.path, LISTS_PATH)

  system("git", "add", LISTS_PATH)

  puts "  lists.json deduped (#{rewritten} field(s) rewritten — remember to run `make reindex` and `make graph`)"
rescue JSON::ParserError => e
  raise "lists.json is not valid JSON — #{e.message}"
end

# --- Step 2 + 3: Ruby syntax validation -------------------------------------

def validate_ruby_syntax(label, glob)
  files = Dir[glob].sort
  if files.empty?
    puts "  #{label}: no files."
    return
  end

  errors = []
  files.each do |file|
    out, status = Open3.capture2e("ruby", "-c", file)
    next if status.success?

    errors << "    #{file}\n#{out.strip.gsub(/^/, "      ")}"
  end

  if errors.empty?
    puts "  #{label}: #{files.size} file(s) OK"
  else
    raise "#{label}: syntax errors\n#{errors.join("\n")}"
  end
end

# --- Step 4: tests ----------------------------------------------------------

def run_tests
  cmd = %w[make test]
  out, status = Open3.capture2e(*cmd, chdir: PRECOMMIT_ROOT)
  if status.success?
    puts "  tests passed"
  else
    raise "tests failed:\n#{out}"
  end
end

# --- Driver -----------------------------------------------------------------

def precommit_main
  steps = [
    ["1/5 db.json",          -> { validate_db_json }],
    ["2/5 lists.json",       -> { validate_lists_json }],
    ["3/5 src/ syntax",      -> { validate_ruby_syntax("src",     File.join(PRECOMMIT_ROOT, "src", "**", "*.rb")) }],
    ["4/5 scripts/ syntax",  -> { validate_ruby_syntax("scripts", File.join(PRECOMMIT_ROOT, "scripts", "**", "*.rb")) }],
    ["5/5 tests",            -> { run_tests }]
  ]

  steps.each do |label, body|
    puts "▸ #{label}"
    body.call
  end

  puts "✓ precommit OK"
rescue StandardError => e
  warn "✗ precommit failed: #{e.message}"
  exit 1
end

precommit_main if $PROGRAM_NAME == __FILE__
