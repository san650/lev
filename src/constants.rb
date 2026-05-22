# frozen_string_literal: true

# Centralized constants for the Lev book tracker.

ROOT_DIR = File.expand_path("..", __dir__)
DB_PATH = File.join(ROOT_DIR, "docs", "db.json")
COVERS_DIR = File.join(ROOT_DIR, "docs", "covers")
DEFAULT_CACHE_DIR = File.join(ROOT_DIR, ".cache")

CACHE_TTL_SECONDS = 48 * 60 * 60
HTTP_TIMEOUT = 10 # seconds

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " \
             "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"

SOURCE_LABELS = {
  "openlibrary" => "OpenLibrary API",
  "openlibrary_html" => "OpenLibrary HTML",
  "goodreads" => "Goodreads",
  "wikipedia" => "Wikipedia"
}.freeze
