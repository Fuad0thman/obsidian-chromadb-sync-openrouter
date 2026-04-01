# Obsidian ChromaDB Sync

Sync your Obsidian vault to ChromaDB for semantic search, with MCP integration for Claude Code.

## Overview

This project provides:

1. **Obsidian Plugin** - Syncs vault contents to a ChromaDB backend with a built-in chat interface
2. **Backend API** - FastAPI server handling ingestion, embeddings, and queries
3. **MCP Server** - Model Context Protocol server for Claude Code integration

## Features

### Supported File Types

| Type | Extension | Chunking Strategy |
|------|-----------|-------------------|
| Markdown | `.md` | Header-based with hierarchy |
| PDF | `.pdf` | Page-based with overlap |
| Excel | `.xlsx` | Row-based with header context |
| CSV | `.csv` | Row-based with auto-delimiter detection |
| Word | `.docx` | Paragraph-based with heading hierarchy |

### Plugin Features

- **Right Sidebar Panel** - Integrated search, chat, and sync controls
- **Semantic Search** - Find related content across your vault
- **AI Chat** - RAG-powered Q&A with Ollama
- **@ Mentions** - Reference notes in chat with `@note-name`
- **Slash Commands** - `/search`, `/summarize`, `/related`
- **Folder Tags** - Filter queries by folder-based categories
- **Incremental Sync** - Content hashing prevents re-indexing unchanged files
- **Status Bar** - Real-time sync status and document counts

### MCP Tools for Claude Code

- `search_vault` - Semantic search with folder_tag filtering
- `synthesize_answer` - RAG-powered Q&A
- `list_collections` - Show available collections
- `list_folder_tags` - List folder tags for filtering
- `get_file_chunks` - Get all chunks for a file

## Architecture

```
┌─────────────────┐     HTTP      ┌─────────────────┐     HTTP      ┌─────────────────┐
│  Obsidian       │ ──────────── │  Backend API    │ ──────────── │  ChromaDB       │
│  Plugin         │    :8002     │  (FastAPI)      │    :8000     │  (Vector DB)    │
└─────────────────┘              └─────────────────┘              └─────────────────┘
                                        │
                                        │ HTTP (Ollama)
                                        ▼
                                 ┌─────────────────┐
                                 │  Ollama         │
                                 │  (LLM for RAG)  │
                                 └─────────────────┘

┌─────────────────┐     SSE      ┌─────────────────┐
│  Claude Code    │ ──────────── │  MCP Server     │ ─────── Backend API
│                 │    :8004     │  (FastAPI/SSE)  │
└─────────────────┘              └─────────────────┘
```

## Quick Start

### 1. Deploy the Stack

```bash
docker compose up -d
```

This starts:
- ChromaDB on port 8003 (internal 8000)
- Backend API on port 8002
- MCP Server on port 8004

### 2. Install the Obsidian Plugin

Copy `plugin/` contents to your vault's `.obsidian/plugins/chromadb-sync/` directory.

Or install via BRAT: `https://github.com/your-repo/obsidian-chromadb-sync`

### 3. Configure Claude Code (Optional)

Create `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "obsidian-chromadb": {
      "type": "sse",
      "url": "http://your-server:8004/sse"
    }
  }
}
```

## Configuration

### Backend Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROMADB_URL` | `http://localhost:8000` | ChromaDB server URL |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.2:latest` | Model for RAG synthesis |
| `EMBEDDING_MODEL` | `all-MiniLM-L6-v2` | Sentence transformer model |
| `HNSW_SPACE` | `cosine` | Vector similarity metric |
| `LOG_LEVEL` | `INFO` | Logging level |

### Plugin Settings

Configurable via Obsidian settings UI:

**General**
- Backend URL and collection name
- Sync interval (periodic sync)

**Markdown**
- Chunk by headers toggle
- Max chunk size

**PDF**
- Chunk size and overlap

**Spreadsheets (XLSX/CSV)**
- Rows per chunk
- Max chunk size

**Word Documents (DOCX)**
- Chunk size and overlap

**Filtering**
- Folder inclusions/exclusions
- File pattern exclusions
- Folder tag mappings

## API Endpoints

### Sync Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sync/markdown` | Sync markdown file |
| POST | `/sync/pdf` | Sync PDF file |
| POST | `/sync/xlsx` | Sync Excel spreadsheet |
| POST | `/sync/csv` | Sync CSV file |
| POST | `/sync/docx` | Sync Word document |

### Query Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/query` | Semantic search |
| POST | `/query/synthesize` | RAG synthesis |

### Management Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/collections` | List collections |
| POST | `/collections/folder-tags` | Get folder tags |
| POST | `/delete` | Delete file chunks |
| POST | `/delete/folder` | Delete folder chunks |
| GET | `/ollama/models` | List available Ollama models |

## Document Schema

Each chunk stored in ChromaDB includes:

```typescript
{
    id:         "path/to/file_chunk_0",
    document:   "chunk text content...",
    metadata: {
        source:          "path/to/file.md",
        filename:        "file.md",
        chunk_index:     0,
        total_chunks:    5,
        file_type:       "markdown|pdf|xlsx|csv|docx",
        content_hash:    "sha256...",
        folder_tag:      "category",
        // Type-specific fields:
        header_path:     "Section > Subsection",     // markdown
        page_start:      1,                          // pdf
        sheet_name:      "Sheet1",                   // xlsx
        row_start:       1,                          // xlsx/csv
        heading_path:    "Chapter > Section",        // docx
    }
}
```

## Development

### Plugin Development

```bash
cd plugin
npm install
npm run dev    # Watch mode
npm run build  # Production build
```

### Backend Development

```bash
cd backend
pip install -r requirements.txt
uvicorn server:app --reload --port 8002
```

## Documentation

See `docs/` for detailed documentation:
- [Architecture](docs/architecture.md) - System design and data flow
- [Plugin Guide](docs/plugin.md) - Plugin features and usage
- [Backend API](docs/backend.md) - API reference
- [MCP Integration](docs/mcp.md) - Claude Code setup

## License

MIT
