# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Obsidian ChromaDB Sync - An Obsidian plugin that syncs vault contents to ChromaDB for semantic search via MCP.

**Architecture:**
- Obsidian plugin (TypeScript) handles parsing, chunking, and HTTP calls
- ChromaDB server (`10.10.10.136:8001`) handles embeddings and vector storage
- No separate Python server needed - plugin talks directly to ChromaDB HTTP API

## Build & Development Commands

```bash
cd plugin

# Install dependencies
npm install

# Development (watch mode)
npm run dev

# Production build
npm run build

# Install to Obsidian vault (symlink or copy)
# Copy plugin/ contents to <vault>/.obsidian/plugins/chromadb-sync/
```

## Project Structure

```
plugin/
├── manifest.json           # Obsidian plugin manifest
├── package.json            # npm dependencies
├── esbuild.config.mjs      # Build configuration
├── src/
│   ├── main.ts             # Plugin entry, commands, ribbon icon
│   ├── settings.ts         # Settings interface and tab
│   ├── parser.ts           # Markdown chunking, frontmatter, wikilinks, tags
│   ├── chromadb-client.ts  # ChromaDB HTTP API client
│   └── sync-manager.ts     # Dirty file tracking, sync orchestration
```

## Key Components

### Parser (`parser.ts`)
- `parseMarkdown()` - Main entry, returns chunks + metadata
- `chunkByHeaders()` - Splits on markdown headers, maintains header path
- `extractWikilinks()` / `extractTags()` - Regex-based extraction
- Simple YAML frontmatter parser (no external dependency)

### ChromaDB Client (`chromadb-client.ts`)
- Direct HTTP to ChromaDB REST API (`/api/v1/...`)
- `ensureCollection()` - Creates collection if missing
- `addDocuments()` / `upsertDocuments()` / `deleteBySource()`
- ChromaDB handles embeddings server-side (default: `all-MiniLM-L6-v2`)

### Sync Manager (`sync-manager.ts`)
- Tracks dirty/deleted files via Obsidian vault events
- `syncFile()` - Parse file → delete old chunks → add new chunks
- `syncDirtyFiles()` - Incremental sync of modified files
- `syncAllFiles()` - Full vault sync (batched)

## Plugin Features

**Commands:**
- `Sync entire vault to ChromaDB` - Full re-sync
- `Sync current file to ChromaDB` - Single file
- `Sync modified files to ChromaDB` - Incremental (dirty files only)
- `Delete ChromaDB collection` - Destructive reset

**Settings:**
- ChromaDB URL and collection name
- Periodic sync toggle + configurable interval
- Chunk by headers toggle + max chunk size
- Folder/pattern exclusions
- Frontmatter/wikilink/tag extraction toggles

## ChromaDB Configuration

- **Endpoint:** `http://10.10.10.136:8001`
- **Embedding:** Server-side via default embedding function
- **Collection metadata:** Uses `hnsw:space: cosine`

## Document Schema

Each chunk stored in ChromaDB:
```typescript
{
    id:       "path/to/note_md_chunk_0",
    document: "chunk text content...",
    metadata: {
        source:         "path/to/note.md",
        filename:       "note",
        chunk_index:    0,
        total_chunks:   5,
        header_path:    "Section > Subsection",
        outgoing_links: "[\"other-note\", \"another-note\"]",  // JSON string
        tags:           "[\"project\", \"work\"]",             // JSON string
        fm_title:       "Note Title",                          // Frontmatter prefixed with fm_
        fm_status:      "active",
    }
}
```
