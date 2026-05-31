# frozen_string_literal: true

require "json"
require "fileutils"
require "tempfile"
require_relative "constants"
require_relative "lists_index"

# Append one or more curated book lists into docs/lists.json. Accepts a
# JSON file in either of two shapes:
#
#   { "Lists": [ { Source, Notes, Confidence, ConfidenceReason,
#                  "Books/Stories": [...] }, ... ] }
#
# or a single list object (no top-level "Lists" wrapper).
#
# After appending, the caller should run reindex + graph rebuild to bring
# the per-book `in_lists` and the precomputed graph back into sync.

LISTS_FILE = File.join(ROOT_DIR, "docs", "lists.json")

module IngestList
  module_function

  class IngestError < StandardError; end

  REQUIRED_LIST_FIELDS = %w[Source Notes Confidence ConfidenceReason].freeze
  REQUIRED_ENTRY_FIELDS = %w[Position Author].freeze

  def run!(input_path)
    raise IngestError, "no input file given" if input_path.nil? || input_path.empty?
    raise IngestError, "no such file: #{input_path}" unless File.exist?(input_path)

    incoming = parse_file(input_path)
    incoming_lists = normalize_input(incoming)

    incoming_lists.each_with_index { |list, i| validate_list!(list, i) }

    existing = JSON.parse(File.read(LISTS_FILE, encoding: "UTF-8"))
    existing["Lists"] ||= []
    existing["next_list_id"]  ||= ((existing["Lists"].map { |l| l["id"] }.compact.max || 0) + 1)
    existing["next_entry_id"] ||= ((existing["Lists"].flat_map { |l| (l["Books/Stories"] || []).map { |e| e["id"] } }.compact.max || 0) + 1)

    existing_sources = existing["Lists"].map { |l| l["Source"] }
    appended = []
    skipped = []
    incoming_lists.each do |list|
      if existing_sources.include?(list["Source"])
        skipped << list["Source"]
        next
      end
      list_with_ids = assign_ids(list, existing)
      existing["Lists"] << list_with_ids
      appended << list_with_ids["Source"]
    end

    if appended.empty?
      warn "No new lists to append."
      skipped.each { |s| warn "  skipped (already present): #{s}" }
      return { appended: [], skipped: skipped }
    end

    write_atomic(LISTS_FILE, JSON.pretty_generate(reorder_top_level(existing), indent: "  ") + "\n")

    puts "Appended #{appended.length} list#{appended.length == 1 ? '' : 's'} to docs/lists.json:"
    appended.each { |s| puts "  + #{s}" }
    skipped.each { |s| puts "  ~ skipped (already present): #{s}" }

    { appended: appended, skipped: skipped }
  end

  def parse_file(path)
    JSON.parse(File.read(path, encoding: "UTF-8"))
  rescue JSON::ParserError => e
    raise IngestError, "input JSON is invalid: #{e.message}"
  end

  def normalize_input(payload)
    if payload.is_a?(Hash) && payload.key?("Lists")
      payload["Lists"]
    elsif payload.is_a?(Hash) && payload.key?("Source")
      [payload]
    elsif payload.is_a?(Array)
      payload
    else
      raise IngestError, "unrecognized JSON shape — expected { Lists: [...] }, a single list object, or an array"
    end
  end

  def validate_list!(list, idx)
    raise IngestError, "list ##{idx} is not an object" unless list.is_a?(Hash)
    missing = REQUIRED_LIST_FIELDS - list.keys
    raise IngestError, "list ##{idx} (Source=#{list['Source'].inspect}) missing required fields: #{missing.join(', ')}" unless missing.empty?
    entries = list["Books/Stories"]
    raise IngestError, "list ##{idx} (Source=#{list['Source']}) missing or empty 'Books/Stories'" if !entries.is_a?(Array) || entries.empty?

    entries.each_with_index do |entry, ei|
      raise IngestError, "list ##{idx} entry ##{ei} is not an object" unless entry.is_a?(Hash)
      missing_entry = REQUIRED_ENTRY_FIELDS - entry.keys
      raise IngestError, "list ##{idx} entry ##{ei} missing #{missing_entry.join(', ')}" unless missing_entry.empty?
      if entry["TitleOriginal"].to_s.strip.empty? && entry["TitleSpanish"].to_s.strip.empty?
        raise IngestError, "list ##{idx} entry ##{ei} has no TitleOriginal nor TitleSpanish"
      end
    end
  end

  # Assign a stable int id to the list and to each of its entries, bumping
  # the counters tracked at the top of lists.json. New objects are rebuilt
  # so `id` sits at the top of each, matching the migrated file layout.
  def assign_ids(list, existing)
    list_id = existing["next_list_id"]
    existing["next_list_id"] = list_id + 1
    entries = (list["Books/Stories"] || []).map do |entry|
      eid = existing["next_entry_id"]
      existing["next_entry_id"] = eid + 1
      { "id" => eid }.merge(entry)
    end
    rest = list.reject { |k, _| k == "Books/Stories" || k == "id" }
    { "id" => list_id }.merge(rest).merge("Books/Stories" => entries)
  end

  def reorder_top_level(data)
    out = {}
    %w[GeneratedAt next_list_id next_entry_id].each { |k| out[k] = data[k] if data.key?(k) }
    data.each { |k, v| out[k] = v unless out.key?(k) }
    out
  end

  def write_atomic(path, contents)
    FileUtils.mkdir_p(File.dirname(path))
    tmp = Tempfile.new(["lists", ".json"], File.dirname(path))
    begin
      tmp.write(contents)
      tmp.close
      FileUtils.mv(tmp.path, path)
    rescue StandardError
      tmp.close
      tmp.unlink
      raise
    end
  end
end
