# frozen_string_literal: true

require_relative "test_helper"

class FlattenLookupTest < Test::Unit::TestCase
  def test_arrays_are_unrolled_to_pairs
    result = {
      "openlibrary" => [{ "title" => "A" }, { "title" => "B" }],
      "wikipedia" => { "title" => "C" }
    }
    pairs = flatten_lookup(result)
    assert_equal 3, pairs.size
    sources = pairs.map(&:first)
    assert_includes sources, "OpenLibrary API"
    assert_includes sources, "Wikipedia"
  end

  def test_unknown_source_uses_raw_key
    pairs = flatten_lookup({ "unknown_source" => { "title" => "A" } })
    assert_equal [["unknown_source", { "title" => "A" }]], pairs
  end
end

class ValuesEqualTest < Test::Unit::TestCase
  def test_strings_compared_by_value
    assert values_equal?("foo", "foo")
    refute values_equal?("foo", "bar")
  end

  def test_hashes_compared_orderless
    a = { "name" => "X", "order" => 1 }
    b = { "order" => 1, "name" => "X" }
    assert values_equal?(a, b)
  end

  def test_hash_vs_string_inequality
    refute values_equal?({ "n" => 1 }, "1")
  end
end

class BuildOptionsTest < Test::Unit::TestCase
  def test_dedupes_by_value_and_merges_sources
    candidates = [
      { value: "Ray Bradbury", source: "Goodreads", context: "Title: X" },
      { value: "Ray Bradbury", source: "OpenLibrary API", context: "Title: X" }
    ]
    options = build_options(candidates)
    assert_equal 1, options.size
    assert_equal "Ray Bradbury", options.first[:value]
    assert_match(/Goodreads/, options.first[:label])
    assert_match(/OpenLibrary API/, options.first[:label])
  end

  def test_distinct_values_kept_separate
    candidates = [
      { value: "Ray Bradbury", source: "Goodreads", context: "" },
      { value: "Asimov", source: "Goodreads", context: "" }
    ]
    options = build_options(candidates)
    assert_equal 2, options.size
  end

  def test_format_value_lambda_applied
    candidates = [{ value: { "type" => "ISBN_13", "value" => "978" }, source: "G", context: "" }]
    options = build_options(candidates, format_value: ->(v) { "#{v["type"]}: #{v["value"]}" })
    assert_match(/ISBN_13: 978/, options.first[:label])
  end
end

class MergeCurrentTest < Test::Unit::TestCase
  def test_synthetic_option_prepended_when_no_match
    options = [{ value: "B", label: "B (Source: G)" }]
    merged = merge_current(options, "A", ->(v) { v.to_s })
    assert_equal 2, merged.size
    assert_equal "A", merged.first[:value]
    assert_match(/Current/, merged.first[:label])
  end

  def test_existing_option_tagged_when_match
    options = [{ value: "A", label: "A (Source: G)" }]
    merged = merge_current(options, "A", ->(v) { v.to_s })
    assert_equal 1, merged.size
    assert_match(/\[Current\]/, merged.first[:label])
  end

  def test_nil_or_empty_current_is_a_noop
    options = [{ value: "B", label: "B" }]
    assert_equal options, merge_current(options, nil, ->(v) { v.to_s })
    assert_equal options, merge_current(options, "", ->(v) { v.to_s })
    assert_equal options, merge_current(options, [], ->(v) { v.to_s })
  end
end

class CollectFieldTest < Test::Unit::TestCase
  def test_collects_string_fields
    pairs = [
      ["Goodreads", { "title" => "T1" }],
      ["OpenLibrary API", { "title" => "T2" }],
      ["Wikipedia", { "title" => nil }]
    ]
    candidates = collect_field(pairs) { |r| r["title"] }
    assert_equal 2, candidates.size
    assert_equal ["T1", "T2"], candidates.map { |c| c[:value] }
  end

  def test_array_fields_flattened
    pairs = [["Goodreads", { "authors" => ["A", "B"] }]]
    candidates = collect_field(pairs) { |r| r["authors"] }
    assert_equal 2, candidates.size
    assert_equal ["A", "B"], candidates.map { |c| c[:value] }
  end

  def test_blank_values_filtered_out
    pairs = [["Goodreads", { "title" => "" }], ["OpenLibrary API", { "title" => "  " }]]
    assert_empty collect_field(pairs) { |r| r["title"] }
  end
end

class CollectIdentifiersTest < Test::Unit::TestCase
  def test_extracts_each_identifier_with_context
    pairs = [["Goodreads", {
      "title" => "The Martian Chronicles",
      "identifiers" => [
        { "type" => "ISBN_13", "value" => "9788445078259" },
        { "type" => "ISBN_10", "value" => "8445078259" }
      ]
    }]]
    candidates = collect_identifiers(pairs)
    assert_equal 2, candidates.size
    assert_equal "ISBN_13", candidates.first[:value]["type"]
    assert_match(/Title: The Martian Chronicles/, candidates.first[:context])
  end

  def test_skips_blank_values
    pairs = [["G", { "title" => "T", "identifiers" => [{ "type" => "ISBN_13", "value" => "" }] }]]
    assert_empty collect_identifiers(pairs)
  end
end

class CollectSagasTest < Test::Unit::TestCase
  def test_extracts_saga_with_default_order
    pairs = [["G", { "title" => "T", "saga" => { "name" => "Foundation" } }]]
    candidates = collect_sagas(pairs)
    assert_equal 1, candidates.size
    assert_equal({ "name" => "Foundation", "order" => 1 }, candidates.first[:value])
  end

  def test_skips_records_without_saga
    pairs = [["G", { "title" => "T" }], ["H", { "title" => "T", "saga" => nil }]]
    assert_empty collect_sagas(pairs)
  end
end

class CanonicalizeAuthorCandidatesTest < Test::Unit::TestCase
  def setup
    @db = {
      "authors" => [
        { "id" => 1, "name" => "Ray Bradbury", "aliases" => ["Ray D. Bradbury", "R. Bradbury"] },
        { "id" => 2, "name" => "Isaac Asimov", "aliases" => [] }
      ],
      "books" => []
    }
  end

  def test_alias_value_is_replaced_with_canonical_name
    candidates = [{ value: "Ray D. Bradbury", source: "Goodreads", context: "" }]
    result = canonicalize_author_candidates(@db, candidates)
    assert_equal "Ray Bradbury", result.first[:value]
    assert_equal "Goodreads", result.first[:source]
  end

  def test_canonical_name_is_left_alone
    candidates = [{ value: "Ray Bradbury", source: "OpenLibrary API", context: "" }]
    result = canonicalize_author_candidates(@db, candidates)
    assert_same candidates.first, result.first
  end

  def test_unknown_author_is_left_alone
    candidates = [{ value: "Octavia Butler", source: "Goodreads", context: "" }]
    result = canonicalize_author_candidates(@db, candidates)
    assert_equal "Octavia Butler", result.first[:value]
  end

  def test_alias_and_canonical_collapse_after_build_options
    candidates = [
      { value: "Ray D. Bradbury", source: "OpenLibrary API", context: "" },
      { value: "Ray Bradbury",    source: "Goodreads",       context: "" }
    ]
    result = canonicalize_author_candidates(@db, candidates)
    options = build_options(result)
    assert_equal 1, options.size, "alias and canonical merge into a single option"
    assert_equal "Ray Bradbury", options.first[:value]
    assert_match(/OpenLibrary API/, options.first[:label])
    assert_match(/Goodreads/, options.first[:label])
  end
end

class ResolveAuthorIDsTest < Test::Unit::TestCase
  def test_creates_new_authors
    db = { "authors" => [], "books" => [] }
    ids = resolve_author_ids(db, ["Ray Bradbury", "Other"])
    assert_equal [1, 2], ids
    assert_equal 2, db["authors"].size
  end

  def test_reuses_existing_authors
    db = {
      "authors" => [{ "id" => 1, "name" => "Ray Bradbury", "aliases" => [] }],
      "books" => []
    }
    ids = resolve_author_ids(db, ["Ray Bradbury"])
    assert_equal [1], ids
    assert_equal 1, db["authors"].size
  end
end

class ScriptedPickerTest < Test::Unit::TestCase
  def test_returns_canned_answers_by_field_name
    picker = ScriptedPicker.new(
      "Title" => "T",
      "Authors" => ["A"],
      "Publisher" => "P",
      "Score" => 7,
      "ConfirmSave" => true
    )
    assert_equal "T", picker.single("Title", [])
    assert_equal ["A"], picker.multi("Authors", [])
    assert_equal "P", picker.publisher([])
    assert_equal 7, picker.required_score
    assert picker.confirm_save
  end

  def test_raises_on_missing_answer
    picker = ScriptedPicker.new
    assert_raise(KeyError) { picker.single("Title", []) }
  end
end
