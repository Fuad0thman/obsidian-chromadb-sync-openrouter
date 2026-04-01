# Obsidian ChromaDB Sync

**Status:** Planning
**Date:** 2026-01-06

---

## Overview

Sync an Obsidian vault to ChromaDB for semantic search via Claude Code MCP.

### Environment

| Component | Location |
|-----------|----------|
| Obsidian Vault | Daily driver machine (git-tracked) |
| ChromaDB | Nautilus homelab (`10.10.10.136:8001`) |
| MCP Server | Already configured, working |

---

## Infrastructure Details

### Nautilus Server Access

```bash
ssh 10.10.10.136
```

The server "nautilus" runs the following AI infrastructure:

| Service | Port | Notes |
|---------|------|-------|
| ChromaDB | 8001 | Vector database for semantic search |
| Open WebUI | 3000 | Web interface (optional, not needed for this project) |
| Ollama | 11434 | LLM backend (listening on 0.0.0.0) |
| SearXNG | 8880 | Web search aggregator |

### ChromaDB Configuration

**Endpoint:** `http://10.10.10.136:8001`

**Docker container:**
```bash
docker run -d \
    --name chromadb \
    -p 8001:8000 \
    -v chromadb-data:/chroma/chroma \
    --restart always \
    chromadb/chroma:latest
```

**Existing collections:**
- `bcm11_manuals` - BCM 11 PDF documentation (4486 chunks)

**Embedding model:** `sentence-transformers/all-MiniLM-L6-v2`

### Existing MCP Server Reference

A working ChromaDB MCP server exists at:
```
/home/gauol/Scratch/Projects-Code/openWebUI/chromadb_mcp.py
```

**Key dependencies (in project .venv):**
- `chromadb` - Vector database client
- `sentence-transformers` - Embedding generation
- `mcp` - Official MCP Python SDK (FastMCP)

**MCP configuration in `~/.claude.json`:**
```json
{
  "/home/gauol/Scratch/Projects-Code/openWebUI": {
    "mcpServers": {
      "chromadb": {
        "type": "stdio",
        "command": "/home/gauol/Scratch/Projects-Code/openWebUI/.venv/bin/python",
        "args": ["/home/gauol/Scratch/Projects-Code/openWebUI/chromadb_mcp.py"]
      }
    }
  }
}
```

**MCP tools exposed:**
- `chromadb_list_collections` - List available collections
- `chromadb_query(collection, query, top_k)` - Semantic search

### Ingestion Script Reference

Existing ingestion script at:
```
/home/gauol/Scratch/Projects-Code/openWebUI/chromadb_ingest.py
```

Supports: PDF, Markdown, TXT files with directory recursion and `--pdf`/`--md`/`--txt` filters.

### Vault Stats

- Size: ~6.9 GB
- Daily changes: ~20 files max
- Features used: `[[wikilinks]]`, frontmatter, some tags

---

## Research: Existing Solutions

### Graph RAG MCP Server

**Source:** https://github.com/ferparra/graph-rag-mcp-server

**Key Ideas:**
- Stores graph relationships (wikilinks, backlinks, tags) in **ChromaDB metadata** - no separate graph DB
- Semantic chunking respects markdown structure (headers, sections, code blocks)
- Configurable chunk size: 100-3000 tokens
- File watcher for real-time sync
- Requires Gemini API for PARA classification (optional)

**MCP Tools Exposed:**
- `search_notes` - Vector search
- `answer_question` - RAG Q&A with citations
- `graph_neighbors` - Related notes via graph
- `get_backlinks` - Notes linking to target
- `get_notes_by_tag` - Filter by tags
- `reindex_vault` - Full reindex

### ObsidianRAG

**Source:** https://github.com/Vasallo94/ObsidianRAG

**Key Ideas:**
- Hybrid search: 60% vector + 40% BM25
- CrossEncoder reranking (BAAI/bge-reranker-v2-m3)
- Follows `[[wikilinks]]` during retrieval to expand context
- Score filtering (removes < 0.3 relevance)

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Daily Driver                            │
│                                                             │
│  ┌─────────────┐    ┌──────────────────────────────────┐   │
│  │  Obsidian   │    │  obsidian-chromadb-sync          │   │
│  │  Vault      │───▶│                                  │   │
│  │  (git)      │    │  • Git-based diff detection      │   │
│  └─────────────┘    │  • Markdown-aware chunking       │   │
│        │            │  • Wikilink/tag extraction       │   │
│        │            │  • Frontmatter → metadata        │   │
│        ▼            │  • Incremental sync              │   │
│  ┌─────────────┐    └──────────────────────────────────┘   │
│  │ .sync_state │                    │                       │
│  │ (commit SHA)│                    │ HTTP                  │
│  └─────────────┘                    ▼                       │
└─────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                        ┌─────────────────────────┐
                        │      Nautilus           │
                        │      10.10.10.136       │
                        │                         │
                        │  ┌─────────────────┐    │
                        │  │   ChromaDB      │    │
                        │  │   :8001         │    │
                        │  └─────────────────┘    │
                        │                         │
                        │  ┌─────────────────┐    │
                        │  │   MCP Server    │    │
                        │  │   (existing)    │    │
                        │  └─────────────────┘    │
                        └─────────────────────────┘
```

---

## Core Features

| Feature | Implementation |
|---------|----------------|
| **Git-based sync** | `git diff --name-status <last_sha>..HEAD` to find changes |
| **Markdown chunking** | Split on headers (configurable depth), respect code blocks |
| **Wikilink extraction** | Parse `[[links]]` → store as metadata for graph queries |
| **Frontmatter parsing** | YAML → searchable metadata fields |
| **Tag extraction** | `#tags` → metadata array |
| **Backlink tracking** | For each note, store what links TO it |
| **Incremental updates** | Delete old chunks → insert new for changed files |
| **Deletion handling** | Remove chunks for deleted/renamed files |

---

## ChromaDB Document Schema

```python
{
    "id": "work_vault/path/to/note_chunk_0",
    "document": "chunk text content...",
    "embedding": [...],
    "metadata": {
        # File info
        "source": "path/to/note.md",
        "filename": "note.md",
        "chunk_index": 0,
        "total_chunks": 5,

        # Frontmatter fields (examples)
        "title": "My Note Title",
        "created": "2024-01-15",
        "status": "active",
        "project": "some-project",

        # Tags
        "tags": ["project", "work"],

        # Graph relationships
        "outgoing_links": ["other-note", "another-note"],
        "incoming_links": ["linking-note"],  # backlinks

        # Structure
        "header_path": "## Section > ### Subsection",
    }
}
```

---

## Sync Strategies

### 1. Git-based Incremental (Recommended)

```bash
# Get changed files since last sync
git diff --name-status <last_commit_sha>..HEAD -- "*.md"

# Returns:
# M  path/to/modified.md
# A  path/to/added.md
# D  path/to/deleted.md
# R  old/path.md -> new/path.md
```

**Pros:**
- Reliable change detection
- Handles renames properly
- Already using git

**Cons:**
- Only syncs committed changes

### 2. File Watcher (Real-time)

Use `watchdog` or `inotify` to detect changes immediately.

**Pros:**
- Instant updates
- No commit required

**Cons:**
- More complex
- Needs to run continuously
- May trigger on autosave noise

### 3. Modification Time

Compare `mtime` against last sync timestamp.

**Pros:**
- Simple

**Cons:**
- Misses copied files
- Doesn't detect deletions well

---

## Sync Trigger Options

| Trigger | How |
|---------|-----|
| **Git post-commit hook** | `.git/hooks/post-commit` calls sync script |
| **Cron/systemd timer** | Periodic sync (hourly, daily) |
| **Manual** | Run `obsidian-sync sync` when needed |
| **Watch daemon** | Background process with file watcher |

---

## Open Questions

1. **Vault path** - Full path to work vault?

2. **Collection name** - What to call it in ChromaDB? (e.g., `work_vault`)

3. **Chunking preference**:
   - Header-based (split on `##`, keeps sections coherent)
   - Size-based (~1000 chars with overlap)
   - Hybrid (headers as boundaries, split large sections)

4. **Frontmatter fields** - Any specific fields to make searchable?

5. **Sync trigger** - Git hook, cron, or manual?

---

## Implementation Plan

### Phase 1: Core Sync Script

- [ ] Markdown parser with header-aware chunking
- [ ] Frontmatter extraction (YAML)
- [ ] Wikilink/tag extraction via regex
- [ ] ChromaDB client (reuse existing code)
- [ ] Git diff integration
- [ ] Sync state tracking (last commit SHA)

### Phase 2: Incremental Sync Logic

- [ ] Handle additions (ingest new files)
- [ ] Handle modifications (delete old chunks, ingest new)
- [ ] Handle deletions (remove chunks)
- [ ] Handle renames (delete old, ingest as new)

### Phase 3: Backlink Tracking

- [ ] Build link graph during ingestion
- [ ] Store incoming_links in metadata
- [ ] Update backlinks when notes change

### Phase 4: MCP Integration

- [ ] Add collection to existing MCP server
- [ ] Or create vault-specific MCP with graph tools

### Phase 5: Automation

- [ ] Git hook setup script
- [ ] Systemd timer option
- [ ] Initial bulk ingestion script

---

## Files to Create

```
obsidian-chromadb-sync/
├── PLANNING.md              # This file
├── README.md                # Usage docs
├── pyproject.toml           # Dependencies
├── src/
│   ├── __init__.py
│   ├── sync.py              # Main sync logic
│   ├── parser.py            # Markdown parsing, chunking
│   ├── extractor.py         # Frontmatter, wikilinks, tags
│   ├── chromadb_client.py   # ChromaDB operations
│   └── git_diff.py          # Git change detection
├── scripts/
│   ├── install_hook.sh      # Git hook installer
│   └── initial_ingest.py    # Bulk ingestion
└── tests/
    └── ...
```

---

## Dependencies

```toml
[project]
dependencies = [
    "chromadb",
    "sentence-transformers",
    "pyyaml",           # Frontmatter parsing
    "gitpython",        # Git operations
    "rich",             # CLI output
]
```

---

## References

- Graph RAG MCP: https://github.com/ferparra/graph-rag-mcp-server
- ObsidianRAG: https://github.com/Vasallo94/ObsidianRAG
- Obsidian sync strategies: https://www.digitalbrainbase.com/t/strategies-for-keeping-openwebuis-rag-in-sync-with-local-folders-e-g-obsidian-vaults/222
- Existing ChromaDB setup: `~/Scratch/Projects-Code/openWebUI/`
