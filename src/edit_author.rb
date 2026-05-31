# frozen_string_literal: true

require_relative "console_ui"
require_relative "db"
require_relative "authors"
require_relative "interactive_select"
require_relative "prompts"
require_relative "constants"
require_relative "lists_index"

def format_author_line(author, index, db)
  count = author_book_count(db, author)
  aliases = author["aliases"].empty? ? "" : " (#{author["aliases"].join(", ")})"
  books_label = count == 1 ? "1 book" : "#{count} books"
  format("%2d. %s — %s%s", index + 1, author["name"], books_label, aliases)
end

def edit_author_name(db, author)
  new_name = prompt("New name", default: author["name"], required: true)
  if new_name == author["name"]
    UI.current.say "  Name unchanged."
    return false
  end

  conflict = db["authors"].find { |a| a["id"] != author["id"] && a["name"].downcase == new_name.downcase }
  if conflict
    UI.current.say "  Another author already has that name: #{conflict["name"]} (##{conflict["id"]})"
    UI.current.say "  Use 'Merge' instead to combine authors."
    return false
  end

  old_name = author["name"]
  author["name"] = new_name
  UI.current.say "  Renamed: #{old_name} -> #{new_name}"
  true
end

def edit_aliases(_db, author)
  UI.current.say "\nCurrent aliases: #{author["aliases"].empty? ? "(none)" : author["aliases"].join(", ")}"

  items = ["Add alias", "Remove alias", "Back"]
  idx = interactive_select(items, prompt_label: "Action")
  return false unless idx

  case idx
  when 0
    new_alias = prompt("New alias", required: true)
    if author["aliases"].any? { |a| a.downcase == new_alias.downcase }
      UI.current.say "  Alias already exists."
      return false
    end
    author["aliases"] << new_alias
    UI.current.say "  Added alias: #{new_alias}"
    true
  when 1
    if author["aliases"].empty?
      UI.current.say "  No aliases to remove."
      return false
    end
    rm_idx = interactive_select(author["aliases"], prompt_label: "Select alias to remove")
    return false unless rm_idx
    removed = author["aliases"].delete_at(rm_idx)
    UI.current.say "  Removed alias: #{removed}"
    true
  else
    false
  end
end

def merge_authors(db, source)
  others = db["authors"].reject { |a| a["id"] == source["id"] }
  if others.empty?
    UI.current.say "  No other authors to merge with."
    return false
  end

  UI.current.say "\nMerge #{source["name"]} into which author?"
  items = others.map { |a| "#{a["name"]} (#{author_book_count(db, a)} books)" }
  idx = interactive_select(items, prompt_label: "Select target author")
  return false unless idx

  target = others[idx]

  source_count = author_book_count(db, source)
  UI.current.say "\n  This will move #{source_count} book(s) from #{source["name"]} to #{target["name"]}"
  UI.current.say "  and delete #{source["name"]}."
  return false unless prompt_yes_no("  Continue?", default: "n")

  db["books"].each do |book|
    ids = book["author_ids"] || []
    if ids.include?(source["id"])
      ids.delete(source["id"])
      ids << target["id"] unless ids.include?(target["id"])
      book["author_ids"] = ids
    end
  end

  merged_aliases = (target["aliases"] + source["aliases"] + [source["name"]]).uniq
  merged_aliases.reject! { |a| a.downcase == target["name"].downcase }
  target["aliases"] = merged_aliases

  db["authors"].delete(source)

  UI.current.say "  Merged: #{source["name"]} -> #{target["name"]}"
  true
end

def delete_author(db, author)
  count = author_book_count(db, author)
  if count > 0
    UI.current.say "\n  Cannot delete #{author["name"]} — referenced by #{count} book(s):"
    db["books"].select { |b| (b["author_ids"] || []).include?(author["id"]) }.each do |book|
      UI.current.say "    - #{book["title"]}"
    end
    UI.current.say "  Use 'Merge' to reassign books first."
    return false
  end

  return false unless prompt_yes_no("  Delete #{author["name"]}?", default: "n")

  db["authors"].delete(author)
  UI.current.say "  Deleted: #{author["name"]}"
  true
end

def edit_author_cli
  UI.current.say "=" * 50
  UI.current.say "  Lev — Manage Authors"
  UI.current.say "=" * 50

  db = load_db
  authors = db["authors"]

  if authors.empty?
    UI.current.say "\nNo authors found. Add books first."
    exit 0
  end

  loop do
    authors = db["authors"].sort_by { |a| a["name"].unicode_normalize(:nfkd).downcase }

    UI.current.say "\n"
    items = authors.each_with_index.map { |a, i| format_author_line(a, i, db) }
    items << "Exit"

    idx = interactive_select(items, prompt_label: "Select an author")

    if idx.nil? || idx == authors.size
      UI.current.say "Done."
      break
    end

    author = authors[idx]
    UI.current.say "\nSelected: #{author["name"]}"
    UI.current.say "  Aliases: #{author["aliases"].empty? ? "(none)" : author["aliases"].join(", ")}"
    UI.current.say "  Books:   #{author_book_count(db, author)}"

    actions = ["Edit name", "Edit aliases", "Merge with another author", "Delete", "Back"]
    action_idx = interactive_select(actions, prompt_label: "Action")
    next unless action_idx

    changed = case action_idx
              when 0 then edit_author_name(db, author)
              when 1 then edit_aliases(db, author)
              when 2 then merge_authors(db, author)
              when 3 then delete_author(db, author)
              else false
              end

    if changed
      ListsIndex.recompute_all!(db)
      save_db(db)
      UI.current.say "  Changes saved."
      system("git", "add", DB_PATH)
      system("git", "commit", "-m", "Edit author #{author["name"]}")
    end
  end
end
