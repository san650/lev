#!/usr/bin/env ruby
# frozen_string_literal: true

# Build the similarity graph used by docs/graph.html. Reads docs/lists.json
# and docs/db.json, writes docs/graph.json.

require_relative "../src/graph"

payload = Graph.build_and_save!

books = payload["books"]
authors = payload["authors"]
puts "Wrote docs/graph.json."
puts "  Books:   #{books['nodes'].length} nodes, #{books['edges'].length} edges"
puts "  Authors: #{authors['nodes'].length} nodes, #{authors['edges'].length} edges"

w_counts = ->(edges) {
  buckets = Hash.new(0)
  # edges are emitted as compact tuples: [a, b, w]
  edges.each { |e| buckets[e[2]] += 1 }
  buckets.sort.reverse.map { |w, c| "w=#{w}:#{c}" }.join(" ")
}
puts "  Book edge weights:   #{w_counts.call(books['edges'])}"
puts "  Author edge weights: #{w_counts.call(authors['edges'])}"
puts "  graph.json size:     #{(File.size('docs/graph.json') / 1024.0).round(1)} KB"
