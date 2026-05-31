#!/usr/bin/env ruby
# frozen_string_literal: true

# Build the similarity graph used by docs/graph.html. Reads docs/lists.json
# and docs/db.json, writes docs/graph.json.

require_relative "../src/graph"

payload = Graph.build_and_save!

books = payload["bk"]
authors = payload["au"]
puts "Wrote docs/graph.json."
puts "  Books:   #{books['ns'].length} nodes, #{books['es'].length} edges"
puts "  Authors: #{authors['ns'].length} nodes, #{authors['es'].length} edges"

w_counts = ->(edges) {
  buckets = Hash.new(0)
  # edges are emitted as compact tuples: [a, b, w]
  edges.each { |e| buckets[e[2]] += 1 }
  buckets.sort.reverse.map { |w, c| "w=#{w}:#{c}" }.join(" ")
}
puts "  Book edge weights:   #{w_counts.call(books['es'])}"
puts "  Author edge weights: #{w_counts.call(authors['es'])}"
puts "  graph.json size:     #{(File.size('docs/graph.json') / 1024.0).round(1)} KB"
