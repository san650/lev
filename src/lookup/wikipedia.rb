# frozen_string_literal: true

require_relative "../http_client"
require_relative "../cache/cache"
require_relative "standardize"

WIKIPEDIA_BOOK_KEYWORDS = {
  "es" => /(?:libro|novela|ficha de libro|t[ií]tulo[_ ]orig|isbn)/i,
  "en" => /(?:novel|book|original[_ ]title|isbn)/i
}.freeze

WIKIPEDIA_ORIG_TITLE_RE = {
  "es" => /t[ií]tulo[_ ]orig(?:inal)?\s*=\s*(.+)/i,
  "en" => /(?:orig[_ ]title|name[_ ]orig|original[_ ]title)\s*=\s*(.+)/i
}.freeze

def search_wikipedia(title, author = nil, language: "es", http: DEFAULT_HTTP)
  language = language.to_s.downcase
  language = "es" unless WIKIPEDIA_BOOK_KEYWORDS.key?(language)

  query = title.dup
  query << " #{author}" if author && !author.empty?
  encoded = URI.encode_www_form_component(query)
  url = "https://#{language}.wikipedia.org/w/api.php?action=query&list=search&srsearch=#{encoded}&format=json&srlimit=5&srnamespace=0"

  warn "Searching #{language.upcase} Wikipedia..."
  data = http.get_json(url)
  return nil unless data && data.dig("query", "search")&.any?

  book_keywords = WIKIPEDIA_BOOK_KEYWORDS[language]
  orig_title_re = WIKIPEDIA_ORIG_TITLE_RE[language]

  data.dig("query", "search").each do |result|
    page_title = result["title"]
    next unless page_title

    parse_url = "https://#{language}.wikipedia.org/w/api.php?action=parse&page=#{URI.encode_www_form_component(page_title)}&prop=wikitext&format=json&redirects=1"
    page_data = http.get_json(parse_url)
    wikitext = page_data&.dig("parse", "wikitext", "*")
    next unless wikitext
    next unless wikitext =~ book_keywords

    info = {}

    if wikitext =~ orig_title_re
      val = $1.strip.sub(/\s*[|\}].*/, "").strip
      val = val.gsub(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/, '\1').gsub(/'{2,}/, "").strip
      info[:original_title] = val unless val.empty?
    end

    if wikitext =~ /isbn\s*=\s*([\d][-\d ]+[\dXx])/i
      isbn = $1.strip.gsub(/[- ]/, "")
      info[:isbn] = isbn if isbn =~ /\A\d{10,13}\z/
    end

    next if info.empty?

    info[:page_title] = page_title
    info[:url] = "https://#{language}.wikipedia.org/wiki/#{URI.encode_www_form_component(page_title)}"
    info[:language] = language
    warn "  Found: #{page_title}"
    return info
  end

  warn "  No relevant information found."
  nil
rescue StandardError => e
  warn "  Wikipedia search failed: #{e.message}"
  nil
end

LANGUAGE_CODE_MAP = { "eng" => "en", "spa" => "es" }.freeze

def detect_language(records)
  records.flatten.compact.each do |rec|
    raw = rec["language"]
    next unless raw
    lang = LANGUAGE_CODE_MAP[raw] || raw
    return lang if %w[es en].include?(lang)
  end
  "es"
end

def best_title(records)
  records.flatten.compact.map { |r| r["title"] }.compact.first
end

def best_author(records)
  records.flatten.compact.map { |r| (r["authors"] || []).first }.compact.first
end

def fetch_wikipedia(records, http: DEFAULT_HTTP)
  title = best_title(records)
  return nil unless title

  language = detect_language(records)
  author = best_author(records)
  cache_query = [title, author, language].compact.join("|")

  cached("wikipedia", cache_query) do
    info = search_wikipedia(title, author, language: language, http: http)
    next nil unless info

    standardize(
      title: info[:page_title],
      original_title: info[:original_title],
      isbn_13: info[:isbn]&.length == 13 ? info[:isbn] : nil,
      isbn_10: info[:isbn]&.length == 10 ? info[:isbn] : nil,
      url: info[:url],
      language: info[:language]
    )
  end
end
