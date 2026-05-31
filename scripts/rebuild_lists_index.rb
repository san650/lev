#!/usr/bin/env ruby
# frozen_string_literal: true

# Rebuild per-book `in_lists` from docs/lists.json. Also adds list-side
# author names as aliases on db authors when they token-match (this catches
# variants like "Lev Tolstói" / "Fiódor Dostoievski" that the matcher
# already collapses, but records them explicitly for data hygiene).
#
# Usage:
#   ruby scripts/rebuild_lists_index.rb           # apply aliases + recompute
#   ruby scripts/rebuild_lists_index.rb --dry     # show changes, don't write

require_relative "../src/db"
require_relative "../src/lists_index"

dry = ARGV.include?("--dry")

db = load_db
lists_data = ListsIndex.load_lists_data

before_aliases = db["authors"].sum { |a| (a["aliases"] || []).length }
proposals = ListsIndex.propose_aliases(db, lists_data)

puts "Alias proposals: #{proposals.length}"
proposals.first(20).each do |p|
  puts "  +alias for ##{p[:author_id]} #{p[:current_name].inspect} → #{p[:alias].inspect}"
end
puts "  ...(#{proposals.length - 20} more)" if proposals.length > 20

applied = ListsIndex.apply_aliases!(db, proposals)
puts "Applied: #{applied}"

ListsIndex.recompute_all!(db, lists_data)

membership_total = db["books"].sum { |b| (b["in_lists"] || []).length }
books_in_any_list = db["books"].count { |b| (b["in_lists"] || []).any? }
puts "Books with at least one list: #{books_in_any_list} / #{db["books"].length}"
puts "Total list memberships: #{membership_total}"

after_aliases = db["authors"].sum { |a| (a["aliases"] || []).length }
puts "Aliases: #{before_aliases} → #{after_aliases}"

if dry
  puts "\n[--dry] db.json not written."
else
  save_db(db)
  puts "\nWrote docs/db.json."
end
