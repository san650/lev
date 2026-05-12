#!/usr/bin/env ruby
# frozen_string_literal: true

require_relative "../src/import_queue"

begin
  import_queue_cli
rescue Interrupt
  puts "\n\nCancelled."
  exit 1
rescue StandardError => e
  warn "\nError: #{e.message}"
  warn e.backtrace.first(5).map { |l| "  #{l}" }.join("\n")
  exit 1
end
