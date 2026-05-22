# frozen_string_literal: true

require_relative "../http_client"
require_relative "open_library"
require_relative "goodreads"
require_relative "wikipedia"
require_relative "standardize"

# Returns a hash keyed by source label. Each value is a single record (ISBN
# lookup) or an array of records (text query). Wikipedia, when present, is
# always a single record (it augments the other sources).
def lookup(query, http: DEFAULT_HTTP)
  isbn = normalize_isbn(query)
  isbn ? lookup_isbn(isbn, http: http) : lookup_text(query, http: http)
end

def lookup_isbn(isbn, http: DEFAULT_HTTP)
  warn "Looking up ISBN #{isbn}"

  openlibrary = fetch_openlibrary_isbn(isbn, http: http)
  goodreads = fetch_goodreads(isbn, limit: 1, http: http).first

  result = {}
  result["openlibrary"] = openlibrary if openlibrary
  result["goodreads"] = goodreads if goodreads

  wiki = fetch_wikipedia(result.values, http: http)
  result["wikipedia"] = wiki if wiki

  result
end

def lookup_text(query, http: DEFAULT_HTTP)
  warn "Searching for: #{query}"

  openlibrary_api = fetch_openlibrary_query(query, http: http)
  openlibrary_html = fetch_openlibrary_html(query, http: http)
  goodreads = fetch_goodreads(query, http: http)

  result = {}
  result["openlibrary"] = openlibrary_api unless openlibrary_api.empty?
  result["openlibrary_html"] = openlibrary_html unless openlibrary_html.empty?
  result["goodreads"] = goodreads unless goodreads.empty?

  wiki = fetch_wikipedia(result.values, http: http)
  result["wikipedia"] = wiki if wiki

  result
end
