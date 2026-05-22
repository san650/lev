# frozen_string_literal: true

# Umbrella loader — `require_relative "lev"` (or `require "lev"` with src/
# on the load path) to pull in the entire library in dependency order.

require_relative "constants"
require_relative "text"
require_relative "console_ui"
require_relative "prompts"
require_relative "interactive_select"
require_relative "cache/cache"
require_relative "http_client"
require_relative "db"
require_relative "publishers"
require_relative "authors"
require_relative "display"
require_relative "git"

require_relative "lookup/standardize"
require_relative "lookup/open_library"
require_relative "lookup/goodreads"
require_relative "lookup/wikipedia"
require_relative "lookup/lookup"

require_relative "book_form/flatten"
require_relative "book_form/build_options"
require_relative "book_form/collectors"
require_relative "book_form/pickers"
require_relative "book_form/cli_picker"
require_relative "book_form/scripted_picker"
require_relative "book_form/author_resolution"

require_relative "add_book"
require_relative "edit_book"
require_relative "add_review"
require_relative "edit_author"
require_relative "score_books"
require_relative "lookup_cli"
