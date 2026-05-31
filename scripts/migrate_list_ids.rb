#!/usr/bin/env ruby
# frozen_string_literal: true

# One-time migration: assign stable int IDs to every list and every
# entry in docs/lists.json so downstream artifacts (graph.json) can
# reference them without duplicating the entries' content.
#
# Adds:
#   - top-level `next_list_id`, `next_entry_id` counters
#   - `id` on each list (sequential by current order)
#   - `id` on each entry (sequential global counter, preserves order)
#
# Idempotent: lists/entries already carrying an `id` are left alone and
# the counters are bumped past their max.

require "json"
require "fileutils"
require "tempfile"
require_relative "../src/constants"

LISTS_PATH = File.join(ROOT_DIR, "docs", "lists.json")
abort("docs/lists.json not found") unless File.exist?(LISTS_PATH)

data = JSON.parse(File.read(LISTS_PATH, encoding: "UTF-8"))
lists = data["Lists"] || []

existing_list_ids = lists.map { |l| l["id"] }.compact
existing_entry_ids = lists.flat_map { |l| (l["Books/Stories"] || []).map { |e| e["id"] } }.compact

next_list_id  = (existing_list_ids.max  || 0) + 1
next_entry_id = (existing_entry_ids.max || 0) + 1

assigned_lists = 0
assigned_entries = 0

lists.each do |list|
  unless list["id"]
    # Lead `id` so it sits at the top of each list object in pretty-print.
    new_list = { "id" => next_list_id }.merge(list)
    list.replace(new_list)
    next_list_id += 1
    assigned_lists += 1
  end
  (list["Books/Stories"] || []).each do |entry|
    next if entry["id"]
    new_entry = { "id" => next_entry_id }.merge(entry)
    entry.replace(new_entry)
    next_entry_id += 1
    assigned_entries += 1
  end
end

# Hoist counters to the top of the file for visibility.
ordered = {}
ordered["GeneratedAt"]  = data["GeneratedAt"] if data.key?("GeneratedAt")
ordered["next_list_id"]  = next_list_id
ordered["next_entry_id"] = next_entry_id
data.each { |k, v| ordered[k] = v unless ordered.key?(k) }

FileUtils.mkdir_p(File.dirname(LISTS_PATH))
tmp = Tempfile.new(["lists", ".json"], File.dirname(LISTS_PATH))
begin
  tmp.write(JSON.pretty_generate(ordered, indent: "  "))
  tmp.write("\n")
  tmp.close
  FileUtils.mv(tmp.path, LISTS_PATH)
rescue StandardError
  tmp.close
  tmp.unlink
  raise
end

puts "Assigned #{assigned_lists} list id#{assigned_lists == 1 ? '' : 's'} and #{assigned_entries} entry id#{assigned_entries == 1 ? '' : 's'}."
puts "next_list_id  = #{next_list_id}"
puts "next_entry_id = #{next_entry_id}"
