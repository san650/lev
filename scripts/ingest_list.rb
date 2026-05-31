#!/usr/bin/env ruby
# frozen_string_literal: true

# Ingest a new curated list (or several) into docs/lists.json and refresh
# the derived indices. Usage:
#
#   make ingest path/to/new-list.json
#   ruby scripts/ingest_list.rb path/to/new-list.json
#
# The input file shape is documented in src/ingest_list.rb. The script:
#   1. validates and appends new lists to docs/lists.json (atomic write)
#   2. runs scripts/rebuild_lists_index.rb (recomputes per-book in_lists)
#   3. runs scripts/rebuild_graph.rb       (recomputes docs/graph.json)
#
# Idempotent: lists whose Source already exists are skipped.

require_relative "../src/ingest_list"

input_path = ARGV.first
if input_path.nil? || input_path == "" || %w[-h --help].include?(input_path)
  warn "usage: make ingest <path/to/list.json>"
  exit 1
end

begin
  result = IngestList.run!(input_path)
rescue IngestList::IngestError => e
  warn "ingest failed: #{e.message}"
  exit 1
end

if result[:appended].empty?
  warn "No reindex needed."
  exit 0
end

puts ""
puts "→ Rebuilding per-book in_lists..."
system(RbConfig.ruby, File.expand_path("../scripts/rebuild_lists_index.rb", __dir__)) ||
  abort("reindex failed")

puts ""
puts "→ Rebuilding similarity graph..."
system(RbConfig.ruby, File.expand_path("../scripts/rebuild_graph.rb", __dir__)) ||
  abort("graph rebuild failed")

puts ""
puts "Done. Review docs/lists.json, docs/db.json, docs/graph.json before committing."
