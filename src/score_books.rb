# frozen_string_literal: true

require_relative "console_ui"
require_relative "db"
require_relative "display"
require_relative "distribution"
require_relative "interactive_select"
require_relative "prompts"
require_relative "git"
require_relative "constants"

COMPARISON_COUNT = 20
COMPARISON_CHOICES = [
  { label: "A: first book is better", key: "a", value: :a },
  { label: "B: second book is better", key: "b", value: :b },
  { label: "C: are the same", key: "c", value: :same }
].freeze
SKIP_LABEL = "[ skip — proceed to comparisons ]"

def section(title)
  UI.current.say "\n"
  UI.current.say "=" * 50
  UI.current.say "  #{title}"
  UI.current.say "=" * 50
end

def sort_books_by_title(books)
  books.sort_by { |b| b["title"].to_s.unicode_normalize(:nfkd).downcase }
end

def format_book_with_score(book, db)
  score = book["score"].is_a?(Numeric) ? book["score"] : "–"
  "#{format_book_title_author(book, db)} (#{score}/10)"
end

def select_books_to_update(books, db)
  sorted = sort_books_by_title(books)
  items = [SKIP_LABEL] + sorted.map { |b| format_book_with_score(b, db) }

  section "Select books to update"
  UI.current.say "Space toggles selection. Enter confirms. Pick the skip row to go straight to comparisons."

  indexes = interactive_select(items, prompt_label: "Books to update", multi: true)
  return [] unless indexes

  indexes.reject { |i| i == 0 }.map { |i| sorted[i - 1] }
end

def update_selected_scores(selected_books, db)
  return false if selected_books.empty?

  section "Update selected scores"
  UI.current.say "Press enter to keep a score unchanged."

  changed = false
  selected_books.each do |book|
    UI.current.say ""
    UI.current.say format_book_title_author(book, db).to_s
    UI.current.say "  Current score: #{book["score"] || "none"}/10"

    new_score = prompt_score_update(book["score"])
    next unless new_score && new_score != book["score"]

    book["score"] = new_score
    changed = true
  end
  changed
end

def random_pair(books)
  books.sample(2)
end

def run_comparisons(books, db, count)
  comparisons = []

  count.times do |idx|
    first, second = random_pair(books)

    section "Comparison #{idx + 1}/#{count}"
    UI.current.say "A: #{format_book_title_author(first, db)}"
    UI.current.say "B: #{format_book_title_author(second, db)}"
    UI.current.say ""

    choice = interactive_choice(COMPARISON_CHOICES, prompt_label: "Which is better?")
    abort "\nCancelled." unless choice

    comparisons << { first: first, second: second, result: choice[:value] }
  end

  comparisons
end

def comparison_consistent?(comparison)
  a = comparison[:first]["score"]
  b = comparison[:second]["score"]
  return false unless a.is_a?(Numeric) && b.is_a?(Numeric)

  case comparison[:result]
  when :a then a > b
  when :b then b > a
  when :same then a == b
  end
end

def result_phrase(book_id, comparison)
  is_first = comparison[:first]["id"] == book_id
  case comparison[:result]
  when :a then is_first ? "you said this is better" : "you said the other is better"
  when :b then is_first ? "you said the other is better" : "you said this is better"
  when :same then "you said they're the same"
  end
end

def review_disagreements(comparisons, db, books)
  inconsistent = comparisons.reject { |c| comparison_consistent?(c) }

  section "Score disagreements"

  if inconsistent.empty?
    UI.current.say "\n  No disagreements."
    return false
  end

  ordered_ids = inconsistent.flat_map { |c| [c[:first]["id"], c[:second]["id"]] }.uniq
  changed = false

  UI.current.say "Press enter to keep a score unchanged."

  ordered_ids.each do |id|
    book = books.find { |b| b["id"] == id }
    next unless book

    relevant = inconsistent.select { |c| c[:first]["id"] == id || c[:second]["id"] == id }

    UI.current.say ""
    UI.current.say "#{format_book_title_author(book, db)} (#{book["score"]}/10)"
    relevant.each do |c|
      other = c[:first]["id"] == id ? c[:second] : c[:first]
      UI.current.say "  vs #{format_book_title_author(other, db)} (#{other["score"]}/10) — #{result_phrase(id, c)}"
    end

    new_score = prompt_score_update(book["score"])
    next unless new_score && new_score != book["score"]

    book["score"] = new_score
    changed = true
  end

  changed
end

def score_books_cli
  section "Lev — Score books"

  db = load_db
  books = db["books"]

  if books.empty?
    UI.current.say "\nNo books in the database."
    exit 0
  end

  selected = select_books_to_update(books, db)
  changed = update_selected_scores(selected, db)

  scored = books.select { |b| numeric_score?(b) }
  if scored.size >= 2
    comparisons = run_comparisons(scored, db, COMPARISON_COUNT)
    changed = review_disagreements(comparisons, db, books) || changed
  else
    UI.current.say "\nLess than two scored books; skipping comparisons."
  end

  print_distribution(books)

  if changed
    save_db(db)
    git_commit_paths(DB_PATH, "Reranking books")
    UI.current.say "\nScores saved."
  else
    UI.current.say "\nNo score changes."
  end
end
