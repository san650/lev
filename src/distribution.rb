# frozen_string_literal: true

require_relative "console_ui"
require_relative "db"

def print_distribution(books)
  scored = books.select { |b| b["score"].is_a?(Numeric) }
  counts = (1..10).each_with_object({}) { |i, h| h[i] = 0 }
  scored.each { |b| counts[b["score"]] += 1 if counts.key?(b["score"]) }

  total = scored.size
  mean = total.positive? ? scored.sum { |b| b["score"] }.fdiv(total).round(2) : 0
  midpoint = 5.5
  delta = (mean - midpoint).round(2)
  delta_sign = delta.positive? ? "+" : ""
  max = [counts.values.max, 1].max
  bar_width = 30

  UI.current.say "\n"
  UI.current.say "=" * 50
  UI.current.say "  Score distribution (n=#{total})"
  UI.current.say "  Mean #{mean} | midpoint #{midpoint} | Δ #{delta_sign}#{delta}"
  UI.current.say "=" * 50
  UI.current.say ""

  (1..10).each do |score|
    n = counts[score]
    width = (n.to_f / max * bar_width).round
    bar = "█" * width
    UI.current.say format("  %2d │ %-#{bar_width}s %d", score, bar, n)
  end
end

def distribution_cli
  db = load_db
  print_distribution(db["books"])
end
