.PHONY: server add edit update review author score distribution format lookup import reindex test help

# Order matters for the help / unknown-target message — keep it readable.
LEV_TARGETS := server add edit update review author score distribution format lookup import reindex test

help:
	@echo "Lev — available make targets:"
	@for t in $(LEV_TARGETS); do echo "  make $$t"; done

server:
	python3 -m http.server 8000 -d docs

add:
	ruby scripts/add_book.rb $(filter-out $@,$(MAKECMDGOALS))

edit update:
	ruby scripts/edit_book.rb

review:
	ruby scripts/add_review.rb

author:
	ruby scripts/edit_author.rb

score:
	ruby scripts/score_books.rb $(filter-out $@,$(MAKECMDGOALS))

distribution:
	ruby scripts/distribution.rb

format:
	ruby scripts/precommit.rb

lookup:
	@ruby scripts/lookup.rb $(filter-out $@,$(MAKECMDGOALS))

import:
	ruby scripts/import_queue.rb

reindex:
	ruby scripts/rebuild_lists_index.rb $(filter-out $@,$(MAKECMDGOALS))

test:
	@ruby -Isrc -Itest -e "Dir['test/**/*_test.rb'].sort.each { |f| load f }" 2>/dev/null

# Catch-all: surface unknown targets with a clear error and the list of
# available commands. `lookup` and `add` use the same pattern to forward
# free-form arguments — they go through this rule too, so we whitelist
# them via $(filter ...).
%:
	@if [ "$@" = "$(filter $@,$(MAKECMDGOALS))" ] && [ -z "$(filter $@,$(LEV_TARGETS))" ] && [ "$$(echo '$(MAKECMDGOALS)' | awk '{print $$1}')" = "$@" ]; then \
		printf "make: unknown target '%s'\n\n" "$@" >&2; \
		printf "Available targets:\n" >&2; \
		for t in $(LEV_TARGETS); do printf "  make %s\n" "$$t" >&2; done; \
		exit 2; \
	fi
