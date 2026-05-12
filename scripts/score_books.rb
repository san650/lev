#!/usr/bin/env ruby
# frozen_string_literal: true

require_relative "../src/score_books"

trap("INT") do
  puts "\nAborted."
  exit 130
end

begin
  score_books_cli(ARGV)
rescue Interrupt
  puts "\n\nCancelled."
  exit 1
rescue StandardError => e
  warn "\nError: #{e.message}"
  warn e.backtrace.first(5).map { |line| "  #{line}" }.join("\n")
  exit 1
end
