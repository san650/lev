# frozen_string_literal: true

require_relative "test_helper"

class CacheKeyTest < Test::Unit::TestCase
  def test_isbn_13_returns_normalized_isbn
    assert_equal "9788445078259", cache_key("9788445078259")
    assert_equal "9788445078259", cache_key("978-84-450-7825-9")
    assert_equal "9788445078259", cache_key(" 978 8445078259 ")
  end

  def test_isbn_10_returns_normalized_isbn
    assert_equal "0345342968", cache_key("0345342968")
    assert_equal "020161622X", cache_key("020161622X")
  end

  def test_free_text_returns_sha1
    key1 = cache_key("Martian Chronicles")
    key2 = cache_key("martian chronicles")
    key3 = cache_key("  MARTIAN CHRONICLES  ")
    assert_match(/\A[0-9a-f]{40}\z/, key1)
    assert_equal key1, key2, "case insensitive"
    assert_equal key1, key3, "trim insensitive"
  end

  def test_different_text_yields_different_keys
    refute_equal cache_key("foo"), cache_key("bar")
  end
end

class MemoryCacheTest < Test::Unit::TestCase
  def setup
    @cache = MemoryCache.new
  end

  def test_read_miss_returns_nil
    assert_nil @cache.read("openlibrary", "missing")
  end

  def test_round_trip
    @cache.write("openlibrary", "abc", { "title" => "Foo" })
    assert_equal({ "title" => "Foo" }, @cache.read("openlibrary", "abc"))
  end

  def test_does_not_cache_nil
    @cache.write("openlibrary", "key", nil)
    assert_nil @cache.read("openlibrary", "key")
  end

  def test_does_not_cache_empty_array
    @cache.write("openlibrary", "key", [])
    assert_nil @cache.read("openlibrary", "key")
  end

  def test_does_not_cache_empty_hash
    @cache.write("openlibrary", "key", {})
    assert_nil @cache.read("openlibrary", "key")
  end

  def test_ttl_expiry
    now = Time.now
    cache = MemoryCache.new(ttl: 60, clock: -> { now })
    cache.write("s", "k", "x")
    now += 30
    assert_equal "x", cache.read("s", "k"), "fresh read returns value"
    now += 31
    assert_nil cache.read("s", "k"), "expired read returns nil"
  end

  def test_clear_empties_store
    @cache.write("s", "k", "v")
    @cache.clear
    assert_equal 0, @cache.size
    assert_nil @cache.read("s", "k")
  end
end

class DiskCacheTest < Test::Unit::TestCase
  def setup
    @tmp = Dir.mktmpdir
    @cache = DiskCache.new(dir: @tmp, ttl: 60)
  end

  def teardown
    FileUtils.rm_rf(@tmp)
  end

  def test_round_trip_persists_to_disk
    @cache.write("openlibrary", "9788445078259", { "title" => "Crónicas marcianas" })
    expected_path = File.join(@tmp, "openlibrary", "9788445078259.json")
    assert File.exist?(expected_path), "wrote fixture to disk"

    payload = JSON.parse(File.read(expected_path))
    assert_equal({ "title" => "Crónicas marcianas" }, payload["result"])
    assert_kind_of Integer, payload["cached_at"]
  end

  def test_read_returns_persisted_result
    @cache.write("s", "k", { "v" => 1 })
    assert_equal({ "v" => 1 }, @cache.read("s", "k"))
  end

  def test_read_miss_when_file_absent
    assert_nil @cache.read("s", "missing")
  end

  def test_does_not_cache_empty
    @cache.write("s", "k", [])
    assert_equal [], Dir.glob(File.join(@tmp, "**/*.json"))
  end

  def test_ttl_expiry_via_mtime
    @cache.write("s", "k", "x")
    path = File.join(@tmp, "s", "k.json")
    File.utime(Time.now - 120, Time.now - 120, path)
    assert_nil @cache.read("s", "k")
  end

  def test_invalid_json_treated_as_miss
    FileUtils.mkdir_p(File.join(@tmp, "s"))
    File.write(File.join(@tmp, "s", "k.json"), "not json")
    assert_nil @cache.read("s", "k")
  end

  def test_env_var_overrides_default_dir
    original = ENV["LEV_CACHE_DIR"]
    ENV["LEV_CACHE_DIR"] = @tmp
    cache = DiskCache.new
    assert_equal @tmp, cache.dir
  ensure
    ENV["LEV_CACHE_DIR"] = original
  end

  def test_clear_removes_all_entries
    @cache.write("s", "k", "x")
    @cache.clear
    refute File.exist?(File.join(@tmp, "s", "k.json"))
  end
end

class CachedHelperTest < Test::Unit::TestCase
  def setup
    Cache.default = MemoryCache.new
  end

  def test_first_call_yields_and_caches
    calls = 0
    result = cached("source", "query") do
      calls += 1
      ["record"]
    end
    assert_equal ["record"], result
    assert_equal 1, calls
  end

  def test_second_call_hits_cache
    calls = 0
    body = -> { calls += 1; ["x"] }
    cached("source", "query", &body)
    cached("source", "query", &body)
    assert_equal 1, calls, "block was only invoked once"
  end

  def test_explicit_cache_argument
    cache = MemoryCache.new
    cached("source", "key", cache: cache) { ["a"] }
    assert_equal ["a"], cache.read("source", cache_key("key"))
  end
end

class AuthorHelpersTest < Test::Unit::TestCase
  def test_find_or_create_author_creates
    db = { "authors" => [], "books" => [] }
    author = find_or_create_author(db, "Ray Bradbury")
    assert_equal 1, author["id"]
    assert_equal "Ray Bradbury", author["name"]
    assert_equal [], author["aliases"]
    assert_equal 1, db["authors"].size
  end

  def test_find_or_create_author_returns_existing
    db = { "authors" => [{ "id" => 1, "name" => "Ray Bradbury", "aliases" => [] }], "books" => [] }
    author = find_or_create_author(db, "Ray Bradbury")
    assert_equal 1, author["id"]
    assert_equal 1, db["authors"].size
  end

  def test_find_author_by_name_case_insensitive
    db = { "authors" => [{ "id" => 1, "name" => "Ray Bradbury", "aliases" => [] }], "books" => [] }
    assert_equal 1, find_author_by_name(db, "ray bradbury")["id"]
  end

  def test_find_author_by_alias
    db = { "authors" => [{ "id" => 1, "name" => "Ray Bradbury", "aliases" => ["Ray D. Bradbury", "RB"] }], "books" => [] }
    assert_equal 1, find_author_by_name(db, "Ray D. Bradbury")["id"]
    assert_equal 1, find_author_by_name(db, "rb")["id"]
  end

  def test_find_author_returns_nil_for_missing
    db = { "authors" => [{ "id" => 1, "name" => "Ray Bradbury", "aliases" => [] }], "books" => [] }
    assert_nil find_author_by_name(db, "Isaac Asimov")
    assert_nil find_author_by_name(db, "")
    assert_nil find_author_by_name(db, nil)
  end

  def test_resolve_author_names
    db = { "authors" => [
      { "id" => 1, "name" => "Ray Bradbury", "aliases" => [] },
      { "id" => 2, "name" => "Co-author", "aliases" => [] }
    ], "books" => [] }
    book = { "author_ids" => [1, 2] }
    assert_equal ["Ray Bradbury", "Co-author"], resolve_author_names(db, book)
  end

  def test_resolve_author_names_skips_missing_ids
    db = { "authors" => [{ "id" => 1, "name" => "Ray Bradbury", "aliases" => [] }], "books" => [] }
    assert_equal ["Ray Bradbury"], resolve_author_names(db, { "author_ids" => [1, 99] })
  end
end

class TextHelpersTest < Test::Unit::TestCase
  def test_decode_html_named_entities
    assert_equal "<a> & b", decode_html("&lt;a&gt; &amp; b")
    assert_equal "It's", decode_html("It&#39;s")
  end

  def test_decode_html_numeric_entities
    assert_equal "©", decode_html("&#169;")
    assert_equal "©", decode_html("&#xA9;")
  end

  def test_strip_tags
    assert_equal "Hello world", strip_tags("<b>Hello</b> <i>world</i>")
  end

  def test_sanitize_title_lowercases
    assert_equal "the-martian-chronicles", sanitize_title("The Martian Chronicles")
  end

  def test_sanitize_title_strips_diacritics
    assert_equal "cronicas-marcianas", sanitize_title("Crónicas Marcianas")
    assert_equal "naive-cafe", sanitize_title("Naïve Café")
    assert_equal "ano-nuevo", sanitize_title("Año Nuevo")
    assert_equal "uber-alles", sanitize_title("Über Alles")
    assert_equal "amelie", sanitize_title("Amélie")
  end

  def test_sanitize_title_whitespace_to_hyphen
    assert_equal "foo-bar-baz", sanitize_title("foo  bar\tbaz")
  end

  def test_sanitize_title_ascii_punctuation_to_underscore
    assert_equal "foo-_-bar", sanitize_title("foo & bar")
    assert_equal "foo_bar", sanitize_title("foo!bar")
  end

  def test_sanitize_title_collapses_repeats_and_trims
    assert_equal "foo-bar", sanitize_title("--foo--bar--")
    assert_equal "foo-bar", sanitize_title("__foo__bar__".tr("_", "-"))
  end

  def test_sanitize_title_non_ascii_residue_becomes_underscore
    assert_equal "hello", sanitize_title("Hello 日本").split("-").first
    assert_equal "_", sanitize_title("a 日 b").split("-")[1]
  end
end

class DBHelpersTest < Test::Unit::TestCase
  def test_next_id_with_empty_array
    assert_equal 1, next_id([])
  end

  def test_next_id_increments_max
    books = [{ "id" => 1 }, { "id" => 5 }, { "id" => 3 }]
    assert_equal 6, next_id(books)
  end

  def test_save_db_round_trip
    Dir.mktmpdir do |dir|
      original = DB_PATH
      stub_db_path = File.join(dir, "db.json")
      Object.send(:remove_const, :DB_PATH)
      Object.const_set(:DB_PATH, stub_db_path)

      db = { "authors" => [{ "id" => 1, "name" => "Ray Bradbury", "aliases" => [] }],
             "books" => [{ "id" => 1, "title" => "The Martian Chronicles" }] }
      save_db(db)
      loaded = load_db
      assert_equal "Ray Bradbury", loaded["authors"].first["name"]
      assert_equal "The Martian Chronicles", loaded["books"].first["title"]
    ensure
      Object.send(:remove_const, :DB_PATH)
      Object.const_set(:DB_PATH, original)
    end
  end
end

class PublisherHelpersTest < Test::Unit::TestCase
  def test_sanitize_publisher_returns_canonical_when_match
    canonical = load_publishers.first
    skip "no publishers configured" if canonical.nil?
    assert_equal canonical, sanitize_publisher(canonical.downcase)
  end

  def test_sanitize_publisher_returns_input_when_no_match
    assert_equal "Unknown Press", sanitize_publisher("Unknown Press")
  end

  def test_sanitize_publisher_handles_blank
    assert_nil sanitize_publisher(nil)
    assert_equal "", sanitize_publisher("")
  end

  def test_load_publishers_uses_db_when_given
    db = { "publishers" => ["Zebra Press", "Alpha Books"] }
    assert_equal ["Alpha Books", "Zebra Press"], load_publishers(db)
  end

  def test_load_publishers_returns_empty_when_db_has_none
    assert_equal [], load_publishers({ "publishers" => [] })
    assert_equal [], load_publishers({})
  end

  def test_add_publisher_appends_to_db
    db = { "authors" => [], "books" => [], "publishers" => ["Existing"] }
    add_publisher(db, "Newcomer")
    assert_equal ["Existing", "Newcomer"], db["publishers"]
  end

  def test_add_publisher_is_case_insensitive_no_op_for_duplicates
    db = { "authors" => [], "books" => [], "publishers" => ["Minotauro"] }
    add_publisher(db, "minotauro")
    assert_equal ["Minotauro"], db["publishers"]
  end

  def test_add_publisher_initializes_missing_key
    db = { "authors" => [], "books" => [] }
    add_publisher(db, "FirstOne")
    assert_equal ["FirstOne"], db["publishers"]
  end
end
