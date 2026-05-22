# frozen_string_literal: true

require "json"

require_relative "constants"
require_relative "console_ui"
require_relative "prompts"
require_relative "db"
require_relative "authors"
require_relative "git"
require_relative "lookup/standardize"
require_relative "add_book"
require_relative "book_form/cli_picker"

QUEUE_DIR = File.join(ROOT_DIR, "queue")

def queue_files
  Dir.glob(File.join(QUEUE_DIR, "*.json")).sort
end

def find_book_by_isbn(books, isbn)
  books.find do |b|
    (b["identifiers"] || []).any? do |id|
      cleaned = normalize_isbn(id["value"])
      cleaned && cleaned == isbn
    end
  end
end

def press_enter
  UI.current.readline("Press Enter to continue... ")
end

def scan_label(scan, isbn)
  title = scan.dig("meta", "title")
  title && !title.empty? ? "\"#{title}\" — ISBN #{isbn}" : "ISBN #{isbn}"
end

def import_queue_cli
  UI.current.say "=" * 50
  UI.current.say "  Lev — Import Queue"
  UI.current.say "=" * 50

  files = queue_files
  if files.empty?
    UI.current.say "\nNo files in queue/."
    return
  end

  UI.current.say "\nFound #{files.size} file(s) in queue/:"
  files.each { |f| UI.current.say "  - #{File.basename(f)}" }

  db = load_db
  totals = { added: 0, existing: 0, skipped: 0 }

  files.each do |path|
    UI.current.say "\n" + "=" * 50
    UI.current.say "  File: #{File.basename(path)}"
    UI.current.say "=" * 50

    json = JSON.parse(File.read(path))
    scans = Array(json["scans"])
    per_file = { added: 0, existing: 0, skipped: 0 }

    scans.each_with_index do |scan, i|
      UI.current.say "\n--- Scan #{i + 1}/#{scans.size} ---"
      isbn = normalize_isbn(scan["isbn"])
      if isbn.nil? || isbn.empty?
        UI.current.warn "  Missing or invalid ISBN — skipped."
        per_file[:skipped] += 1
        next
      end

      label = scan_label(scan, isbn)
      UI.current.say label
      unless prompt_yes_no("Import this book?", default: "y")
        UI.current.say "Skipped."
        per_file[:skipped] += 1
        next
      end

      existing = find_book_by_isbn(db["books"], isbn)
      if existing
        name = resolve_author_names(db, existing).first || "Unknown"
        UI.current.say "Exists: \"#{existing["title"]}\" by #{name} (id #{existing["id"]}) — ISBN #{isbn}"
        per_file[:existing] += 1
      else
        outcome = add_book(db: db, query: isbn, picker: CLIPicker.new)

        if outcome[:existing]
          book = outcome[:existing]
          name = resolve_author_names(db, book).first || "Unknown"
          UI.current.say "Exists: \"#{book["title"]}\" by #{name} (id #{book["id"]}) — ISBN #{isbn}"
          per_file[:existing] += 1
        elsif outcome[:saved]
          git_auto_commit("Add", outcome[:book], db, include_covers: true)
          UI.current.say "Added: \"#{outcome[:book]["title"]}\" (id #{outcome[:book]["id"]})"
          per_file[:added] += 1
        else
          UI.current.say "Skipped."
          per_file[:skipped] += 1
        end
      end

      next if i == scans.size - 1

      UI.current.say label
      unless prompt_yes_no("Continue to next book?", default: "y")
        UI.current.say "Stopping at user request."
        break
      end
    end

    UI.current.say "\nFile summary — Added: #{per_file[:added]} · Existing: #{per_file[:existing]} · Skipped: #{per_file[:skipped]}"
    if prompt_yes_no("Delete #{File.basename(path)}?", default: "n")
      File.delete(path)
      UI.current.say "Deleted #{path}"
    end

    totals.each_key { |k| totals[k] += per_file[k] }
  end

  UI.current.say "\n" + "=" * 50
  UI.current.say "  Run summary — Added: #{totals[:added]} · Existing: #{totals[:existing]} · Skipped: #{totals[:skipped]}"
  UI.current.say "=" * 50
end
