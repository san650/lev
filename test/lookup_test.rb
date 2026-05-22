# frozen_string_literal: true

require_relative "test_helper"

class NormalizeISBNTest < Test::Unit::TestCase
  def test_isbn_13_passthrough
    assert_equal "9788445078259", normalize_isbn("9788445078259")
  end

  def test_isbn_with_dashes_and_spaces
    assert_equal "9788445078259", normalize_isbn("978-84-450-7825-9")
    assert_equal "9788445078259", normalize_isbn(" 978 8445078259 ")
  end

  def test_isbn_10_passthrough_uppercase_x
    assert_equal "020161622X", normalize_isbn("020161622x")
  end

  def test_invalid_isbn_returns_nil
    assert_nil normalize_isbn("not an isbn")
    assert_nil normalize_isbn("12345")
  end
end

class IsbnMatchesTest < Test::Unit::TestCase
  def test_dashes_and_case_normalized
    assert isbn_matches?("978-84-450-7825-9", "9788445078259")
    assert isbn_matches?("020161622X", "020161622X")
    assert isbn_matches?("020161622x", "020161622X")
  end

  def test_no_match
    refute isbn_matches?("9780000000000", "9788445078259")
  end

  def test_nil_candidate
    refute isbn_matches?(nil, "9788445078259")
  end
end

class StandardizeTest < Test::Unit::TestCase
  def test_minimal_record_drops_nil_fields
    record = standardize(title: "T")
    assert_equal "T", record["title"]
    refute record.key?("subtitle"), "nil subtitle dropped"
    refute record.key?("publisher"), "nil publisher dropped"
    assert_equal [], record["authors"], "empty authors array preserved"
    assert_equal [], record["identifiers"], "empty identifiers array preserved"
  end

  def test_isbn_13_built_into_identifiers
    record = standardize(title: "T", isbn_13: "9788445078259")
    assert_equal [{ "type" => "ISBN_13", "value" => "9788445078259" }], record["identifiers"]
  end

  def test_both_isbns_kept_in_order
    record = standardize(title: "T", isbn_13: "9788445078259", isbn_10: "8445078259")
    assert_equal "ISBN_13", record["identifiers"][0]["type"]
    assert_equal "ISBN_10", record["identifiers"][1]["type"]
  end

  def test_publish_date_falls_back_into_first_publishing_date
    record = standardize(title: "T", publish_date: "2020")
    assert_equal "2020", record["first_publishing_date"]
    refute record.key?("publish_dates"), "publish_dates is no longer in the schema"
  end

  def test_first_publishing_date_takes_priority_over_publish_date
    record = standardize(title: "T", first_publishing_date: "1946", publish_date: "2020")
    assert_equal "1946", record["first_publishing_date"]
  end

  def test_first_publishing_date_extracted_from_iso_date
    record = standardize(title: "T", publish_date: "2011-04-12")
    assert_equal "2011", record["first_publishing_date"]
  end

  def test_first_publishing_date_extracted_from_free_text
    record = standardize(title: "T", first_publishing_date: "April 1946, Doubleday")
    assert_equal "1946", record["first_publishing_date"]
  end

  def test_first_publishing_date_dropped_when_no_year_found
    record = standardize(title: "T", first_publishing_date: "n/a")
    refute record.key?("first_publishing_date")
  end

  def test_explicit_identifiers_passthrough
    ids = [{ "type" => "ISBN_13", "value" => "9788445078259" }]
    record = standardize(title: "T", identifiers: ids)
    assert_equal ids, record["identifiers"]
  end
end

class ExtractYearTest < Test::Unit::TestCase
  def test_isolated_year
    assert_equal "1946", extract_year("1946")
  end

  def test_iso_date
    assert_equal "2011", extract_year("2011-04-12")
  end

  def test_free_text
    assert_equal "1946", extract_year("April 1946")
    assert_equal "1990", extract_year("1990s")
  end

  def test_picks_first_year_when_multiple
    assert_equal "2011", extract_year("2011-2014")
  end

  def test_no_year
    assert_nil extract_year("n/a")
    assert_nil extract_year("")
    assert_nil extract_year(nil)
  end

  def test_long_digit_run_does_not_match
    assert_nil extract_year("12345")
    assert_nil extract_year("9788445078259")
  end
end

class FetchOpenLibraryISBNTest < Test::Unit::TestCase
  def setup
    setup_memory_cache
    @http = fixture_http_client
  end

  def test_returns_record_for_known_isbn
    record = fetch_openlibrary_isbn("9788445078259", http: @http)
    refute_nil record
    refute_empty record["title"]
  end
end

class FetchOpenLibraryQueryTest < Test::Unit::TestCase
  def setup
    setup_memory_cache
    @http = fixture_http_client
  end

  def test_returns_records_for_text
    records = fetch_openlibrary_query("the martian chronicles bradbury", http: @http)
    refute_empty records
    assert records.first["title"]
  end
end

class FetchOpenLibraryHTMLTest < Test::Unit::TestCase
  def setup
    setup_memory_cache
    @http = fixture_http_client
  end

  def test_returns_records_for_text
    records = fetch_openlibrary_html("the martian chronicles bradbury", http: @http)
    refute_empty records
  end
end

class FetchGoodreadsTest < Test::Unit::TestCase
  def setup
    setup_memory_cache
    @http = fixture_http_client
  end

  def test_returns_records_for_text
    records = fetch_goodreads("the martian chronicles bradbury", http: @http)
    refute_empty records
    assert records.first["title"]
  end
end

class FetchWikipediaTest < Test::Unit::TestCase
  def setup
    setup_memory_cache
    @http = fixture_http_client
  end

  def test_augments_records
    seed = [{ "title" => "The Martian Chronicles", "authors" => ["Ray Bradbury"], "language" => "en" }]
    record = fetch_wikipedia(seed, http: @http)
    refute_nil record
    refute_empty record["title"]
  end

  def test_returns_nil_when_no_seed_title
    assert_nil fetch_wikipedia([], http: @http)
  end
end

class LookupISBNTest < Test::Unit::TestCase
  def setup
    setup_memory_cache
    @http = fixture_http_client
  end

  def test_aggregates_multiple_sources
    result = lookup_isbn("9788445078259", http: @http)
    assert_kind_of Hash, result
    assert result["openlibrary"], "expected openlibrary present"
  end

  def test_each_source_value_is_a_hash
    result = lookup_isbn("9788445078259", http: @http)
    result.each do |source, value|
      assert_kind_of Hash, value, "#{source} should be a single record for ISBN lookup"
    end
  end
end

class LookupTextTest < Test::Unit::TestCase
  def setup
    setup_memory_cache
    @http = fixture_http_client
  end

  def test_returns_arrays_per_source
    result = lookup_text("the martian chronicles bradbury", http: @http)
    %w[openlibrary openlibrary_html goodreads].each do |source|
      next unless result[source]
      assert_kind_of Array, result[source], "#{source} should be an array for text lookup"
    end
  end

  def test_includes_wikipedia_augmentation
    result = lookup_text("the martian chronicles bradbury", http: @http)
    assert result["wikipedia"], "expected wikipedia augmentation"
    assert_kind_of Hash, result["wikipedia"]
  end
end

class LookupDispatchTest < Test::Unit::TestCase
  def setup
    setup_memory_cache
    @http = fixture_http_client
  end

  def test_isbn_input_routes_to_isbn_lookup
    result = lookup("978-84-450-7825-9", http: @http)
    assert result["openlibrary"].is_a?(Hash), "ISBN path returns single records"
  end

  def test_text_input_routes_to_text_lookup
    result = lookup("the martian chronicles bradbury", http: @http)
    assert result["openlibrary"].is_a?(Array), "text path returns arrays"
  end
end
