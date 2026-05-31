# frozen_string_literal: true

require "json"
require "set"
require_relative "constants"
require_relative "lists_index"

# Build a similarity graph over the recommended-lists corpus.
#
# A BOOK NODE = (normalized primary title with volume-suffix stripped,
# normalized first author). Two books are adjacent when they appear in
# the same curated list; edge weight = number of shared lists.
#
# AN AUTHOR NODE = normalized author name. Two authors are adjacent when
# they share a list (each has ≥1 entry in it); edge weight = number of
# shared lists.
#
# The serialized graph (docs/graph.json) carries ONLY relationships —
# integer node ids, entry-id references, db cross-refs, edges, and
# precomputed top neighbors. The client merges with docs/db.json and
# docs/lists.json at render time to recover titles, authors, years, etc.

GRAPH_PATH = File.join(ROOT_DIR, "docs", "graph.json")
TOP_NEIGHBORS_PER_NODE = 30
# Threshold for a "real" similarity edge — fewer than 3 shared lists is
# noise (two books happen to appear together by coincidence). Applied to
# both the global edges array AND each node's top_neighbors, so anything
# the client sees is a signal-grade connection.
MIN_EDGE_WEIGHT = 3

module Graph
  module_function

  def build_and_save!
    db = load_db_safe
    lists_data = ListsIndex.load_lists_data
    payload = build_payload(db, lists_data)
    # Compact output — graph.json is fully derived from lists.json + db.json
    # so diff-friendliness doesn't help anyone here, and pretty-printing
    # roughly triples the on-wire size of the top_neighbors arrays.
    File.write(GRAPH_PATH, JSON.generate(payload) + "\n", encoding: "UTF-8")
    payload
  end

  def build_payload(db, lists_data)
    {
      "generated_at" => Time.now.strftime("%Y-%m-%d"),
      "books" => build_book_graph(db, lists_data),
      "authors" => build_author_graph(db, lists_data)
    }
  end

  # ---- Book graph -------------------------------------------------------

  def build_book_graph(db, lists_data)
    # node_key (normalized title+author tuple) -> node hash
    node_by_key = {}
    db_book_index = index_db_books(db)
    # list_id -> [node_id, ...] for edge generation
    list_membership = Hash.new { |h, k| h[k] = [] }
    node_counter = 0

    (lists_data["Lists"] || []).each do |list|
      list_id = list["id"]
      (list["Books/Stories"] || []).each do |entry|
        key = book_node_key(entry)
        node = node_by_key[key]
        if node.nil?
          node_counter += 1
          db_book = match_db_book(entry, db_book_index)
          node = {
            "id" => node_counter,
            "entry_ids" => [],
            "list_ids" => [],
            "db_book_id" => db_book ? db_book["id"] : nil
          }
          node_by_key[key] = node
        end
        node["entry_ids"] << entry["id"] if entry["id"] && !node["entry_ids"].include?(entry["id"])
        node["list_ids"] << list_id if list_id && !node["list_ids"].include?(list_id)
        list_membership[list_id] << node["id"] unless list_membership[list_id].include?(node["id"])
      end
    end

    isolated_db_book_ids = []
    (db["books"] || []).each do |book|
      next if node_by_key.values.any? { |n| n["db_book_id"] == book["id"] }
      isolated_db_book_ids << book["id"]
    end

    edges_full = co_occurrence_edges(list_membership)
    finalize_top_neighbors!(node_by_key.values, edges_full)

    {
      "nodes" => node_by_key.values.map { |n|
        {
          "id" => n["id"],
          "entry_ids" => n["entry_ids"],
          "list_ids" => n["list_ids"],
          "list_count" => n["list_ids"].length,
          "db_book_id" => n["db_book_id"],
          "neighbor_count" => n["neighbor_count"],
          "top_neighbors" => n["top_neighbors"]
        }
      }.sort_by { |n| -n["list_count"] },
      "edges" => filter_edges_for_global(edges_full),
      "isolated_db_book_ids" => isolated_db_book_ids.sort
    }
  end

  def book_node_key(entry)
    primary = entry["TitleSpanish"].to_s.empty? ? entry["TitleOriginal"] : entry["TitleSpanish"]
    title_key = ListsIndex.strip_suffix(ListsIndex.normalize(primary.to_s))
    first_author = ListsIndex.split_authors(entry["Author"]).first || entry["Author"].to_s
    author_key = ListsIndex.normalize(first_author)
    [title_key, author_key]
  end

  def match_db_book(entry, db_book_index)
    primary = entry["TitleSpanish"].to_s.empty? ? entry["TitleOriginal"] : entry["TitleSpanish"]
    title_key = ListsIndex.strip_suffix(ListsIndex.normalize(primary.to_s))
    ListsIndex.split_authors(entry["Author"]).each do |a|
      hit = db_book_index[[title_key, ListsIndex.normalize(a)]]
      return hit if hit
    end
    nil
  end

  def index_db_books(db)
    idx = {}
    (db["books"] || []).each do |book|
      title_variants = ListsIndex.title_variants_for_book(book)
      author_keys = Set.new
      (book["author_ids"] || []).each do |aid|
        a = (db["authors"] || []).find { |x| x["id"] == aid }
        next unless a
        author_keys << ListsIndex.normalize(a["name"])
        (a["aliases"] || []).each { |al| author_keys << ListsIndex.normalize(al) }
      end
      title_variants.each do |t|
        author_keys.each do |ak|
          idx[[t, ak]] ||= book
        end
      end
    end
    idx
  end

  # ---- Author graph -----------------------------------------------------

  def build_author_graph(db, lists_data)
    node_by_key = {}
    db_author_index = index_db_authors(db)
    list_membership = Hash.new { |h, k| h[k] = [] }
    node_counter = 0

    (lists_data["Lists"] || []).each do |list|
      list_id = list["id"]
      (list["Books/Stories"] || []).each do |entry|
        ListsIndex.split_authors(entry["Author"]).each do |raw_name|
          key = ListsIndex.normalize(raw_name)
          next if key.empty?
          node = node_by_key[key]
          if node.nil?
            node_counter += 1
            db_author = db_author_index[key]
            node = {
              "id" => node_counter,
              "name" => db_author ? db_author["name"] : raw_name,
              "db_author_id" => db_author ? db_author["id"] : nil,
              "entry_ids" => [],
              "list_ids" => []
            }
            node_by_key[key] = node
          end
          node["entry_ids"] << entry["id"] if entry["id"] && !node["entry_ids"].include?(entry["id"])
          node["list_ids"] << list_id if list_id && !node["list_ids"].include?(list_id)
          list_membership[list_id] << node["id"] unless list_membership[list_id].include?(node["id"])
        end
      end
    end

    # Include db authors absent from any list, so the user's whole library
    # is reachable from the list view.
    (db["authors"] || []).each do |author|
      key = ListsIndex.normalize(author["name"])
      next if key.empty? || node_by_key.key?(key)
      node_counter += 1
      node_by_key[key] = {
        "id" => node_counter,
        "name" => author["name"],
        "db_author_id" => author["id"],
        "entry_ids" => [],
        "list_ids" => []
      }
    end

    edges_full = co_occurrence_edges(list_membership)
    finalize_top_neighbors!(node_by_key.values, edges_full)

    {
      "nodes" => node_by_key.values.map { |n|
        {
          "id" => n["id"],
          "name" => n["name"],
          "db_author_id" => n["db_author_id"],
          "entry_ids" => n["entry_ids"],
          "list_ids" => n["list_ids"],
          "list_count" => n["list_ids"].length,
          "neighbor_count" => n["neighbor_count"],
          "top_neighbors" => n["top_neighbors"]
        }
      }.sort_by { |n| -n["list_count"] },
      "edges" => filter_edges_for_global(edges_full)
    }
  end

  def index_db_authors(db)
    idx = {}
    (db["authors"] || []).each do |a|
      idx[ListsIndex.normalize(a["name"])] = a
      (a["aliases"] || []).each { |al| idx[ListsIndex.normalize(al)] ||= a }
    end
    idx
  end

  # ---- Shared edge computation -----------------------------------------

  def co_occurrence_edges(list_membership)
    weights = Hash.new(0)
    list_membership.each_value do |ids|
      ids.combination(2) do |a, b|
        pair = a < b ? [a, b] : [b, a]
        weights[pair] += 1
      end
    end
    weights.map { |(a, b), w| { "a" => a, "b" => b, "w" => w } }
  end

  def filter_edges_for_global(edges)
    edges
      .select { |e| e["w"] >= MIN_EDGE_WEIGHT }
      .map { |e| [e["a"], e["b"], e["w"]] }
      .sort_by { |t| -t[2] }
  end

  # Walk all edges once, populate per-node top-N neighbor arrays. Edges
  # below MIN_EDGE_WEIGHT are dropped here too — the focused view should
  # never see noise. Stored as compact `[id, w]` tuples to halve token
  # count vs. an object literal.
  def finalize_top_neighbors!(nodes, edges)
    by_node = Hash.new { |h, k| h[k] = [] }
    edges.each do |e|
      next if e["w"] < MIN_EDGE_WEIGHT
      by_node[e["a"]] << [e["b"], e["w"]]
      by_node[e["b"]] << [e["a"], e["w"]]
    end
    nodes.each do |node|
      neighbors = by_node[node["id"]]
      neighbors.sort_by! { |t| [-t[1], t[0]] }
      node["top_neighbors"] = neighbors.first(TOP_NEIGHBORS_PER_NODE)
      node["neighbor_count"] = neighbors.length
    end
  end

  # ---- Misc ------------------------------------------------------------

  def load_db_safe
    require_relative "db"
    load_db
  rescue StandardError
    { "authors" => [], "books" => [], "publishers" => [] }
  end
end
