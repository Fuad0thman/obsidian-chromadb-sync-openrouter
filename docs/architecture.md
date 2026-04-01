# Architecture

## System Overview

Obsidian ChromaDB Sync is a multi-component system for semantic search over Obsidian vaults.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User's Machine                                  │
│  ┌─────────────────┐                                                        │
│  │    Obsidian     │                                                        │
│  │  ┌───────────┐  │                                                        │
│  │  │  Plugin   │──┼──────────────────────────────┐                         │
│  │  └───────────┘  │                              │                         │
│  └─────────────────┘                              │                         │
│                                                   │                         │
│  ┌─────────────────┐                              │                         │
│  │  Claude Code    │                              │                         │
│  │  ┌───────────┐  │                              │                         │
│  │  │ MCP Client│──┼──────────────────┐           │                         │
│  │  └───────────┘  │                  │           │                         │
│  └─────────────────┘                  │           │                         │
└───────────────────────────────────────┼───────────┼─────────────────────────┘
                                        │           │
                                   SSE  │      HTTP │
                                  :8004 │     :8002 │
                                        ▼           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Docker Host                                     │
│                                                                              │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐          │
│  │   MCP Server    │    │  Backend API    │    │    ChromaDB     │          │
│  │   (SSE)         │───▶│  (FastAPI)      │───▶│   (Vector DB)   │          │
│  │   :8003         │    │  :8002          │    │   :8000         │          │
│  └─────────────────┘    └────────┬────────┘    └─────────────────┘          │
│                                  │                                           │
│                                  │ HTTP :11434                               │
│                                  ▼                                           │
│                         ┌─────────────────┐                                  │
│                         │     Ollama      │                                  │
│                         │ (optional, RAG) │                                  │
│                         └─────────────────┘                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Sync Flow (Plugin → Backend → ChromaDB)

1. **File Detection**: Plugin detects new/modified files via Obsidian vault events
2. **Content Hashing**: SHA256 hash computed to detect changes
3. **Parsing**: Markdown parsed into chunks by headers; PDFs split by pages
4. **Metadata Extraction**: Frontmatter, wikilinks, tags, folder tags extracted
5. **Embedding**: Backend generates embeddings via sentence-transformers
6. **Storage**: Vectors stored in ChromaDB with metadata

### Query Flow (Client → Backend → ChromaDB)

1. **Query Received**: Natural language query from plugin or MCP
2. **Query Embedding**: Backend embeds the query
3. **Vector Search**: ChromaDB returns nearest neighbors
4. **Optional RAG**: If using synthesis, Ollama generates answer from context
5. **Response**: Results with source files, distances, metadata

## Component Details

### Obsidian Plugin

**Location**: `plugin/`

**Key Files**:
- `src/main.ts` - Plugin entry, commands, event handlers
- `src/settings.ts` - Configuration UI and storage
- `src/parser.ts` - Markdown parsing and chunking
- `src/sync-manager.ts` - Sync orchestration, dirty tracking
- `src/chromadb-client.ts` - Backend HTTP client
- `src/chat-view.ts` - Sidebar UI for search/chat/sync

**Responsibilities**:
- Monitor vault for file changes
- Parse and chunk documents
- Send content to backend for embedding
- Provide search UI within Obsidian

### Backend API

**Location**: `backend/`

**Key Files**:
- `server.py` - FastAPI application with all endpoints
- `parser.py` - Markdown parsing utilities
- `ingestion.py` - PDF extraction and chunking

**Endpoints**:
| Method | Path | Description |
|--------|------|-------------|
| POST | `/sync/markdown` | Sync markdown file |
| POST | `/sync/pdf` | Sync PDF file |
| POST | `/query` | Semantic search |
| POST | `/query/synthesize` | RAG synthesis |
| POST | `/delete` | Delete file chunks |
| POST | `/delete/folder` | Delete folder chunks |
| GET | `/collections` | List collections |
| POST | `/collections/folder-tags` | Get folder tags |
| GET | `/graph/outgoing/{collection}/{path}` | Outgoing links |
| GET | `/graph/incoming/{collection}/{path}` | Incoming links |
| GET | `/graph/related/{collection}/{path}` | Related documents |

### MCP Server

**Location**: `mcp-server/`

**Variants**:
- `obsidian_mcp.py` - stdio transport for local use
- `obsidian_mcp_sse.py` - SSE transport for Docker/remote

**Tools Exposed**:
- `search_vault` - Semantic search
- `synthesize_answer` - RAG Q&A
- `list_collections` - List collections
- `list_folder_tags` - List folder tags
- `get_file_chunks` - Get file content

### ChromaDB

**Role**: Vector database for storing embeddings and metadata

**Collection Metadata**:
- `hnsw:space` - Similarity metric (default: cosine)
- `schema_version` - For future migrations
- `embedding_model` - Model used for embeddings

**Document Metadata** (per chunk):
- `source` - Full file path
- `filename` - File name only
- `chunk_index` - Position in file
- `total_chunks` - Total chunks in file
- `header_path` - Markdown header hierarchy
- `folder_tag` - Folder-based category
- `file_type` - "markdown" or "pdf"
- `content_hash` - For change detection
- `embedding_model` - Model used
- `schema_version` - Schema version

## Folder Tags

Folder tags enable filtered queries. When syncing, files inherit a tag from their parent folder based on plugin configuration.

**Example**:
```
vault/
├── projects/        → folder_tag: "projects"
│   └── alpha.md
├── notes/           → folder_tag: "notes"
│   └── daily.md
└── manuals/
    ├── bcm-09/      → folder_tag: "bcm 09"
    └── bcm-11/      → folder_tag: "bcm 11"
```

Query with `folder_tag="bcm 11"` to search only BCM 11 manuals.

## Content Hashing

SHA256 hashing prevents unnecessary re-indexing:

1. Hash computed from file content
2. Hash stored in chunk metadata (`content_hash`)
3. On sync, existing hash compared to new hash
4. If unchanged, sync skipped (returns `skipped: true`)

## Schema Versioning

Enables future migrations without full rebuilds:

- `SCHEMA_VERSION` in backend config (currently "1.0")
- Stored in collection metadata and each chunk
- Future changes can check version and migrate accordingly

## Vector Database Alternatives

The system currently uses ChromaDB, but the architecture could be adapted to other vector databases if needed.

### Current Implementation: ChromaDB

**Pros**:
- Easy self-hosting (single Docker container)
- Built-in embedding support (sentence-transformers)
- No external API keys required
- Simple REST API
- Free and open source

**Cons**:
- Single-node only (no horizontal scaling)
- Limited production features (no auth, rate limiting)

### Alternative Vector Databases

| Database | Type | Best For |
|----------|------|----------|
| **Pinecone** | Managed cloud | Production SaaS, no ops overhead |
| **Weaviate** | Self-hosted / Cloud | GraphQL API, multi-modal |
| **Qdrant** | Self-hosted / Cloud | High performance, Rust-based |
| **Milvus** | Self-hosted | Large-scale, distributed |
| **pgvector** | PostgreSQL extension | Existing Postgres infrastructure |
| **LanceDB** | Embedded | Serverless, file-based |
| **FAISS** | Library | Research, in-memory only |

### What Would Change for Abstraction

To support multiple vector databases, create a `VectorStore` interface:

```python
class VectorStore(Protocol):
    def add_documents(self, ids, documents, embeddings, metadata) -> None: ...
    def query(self, embedding, n_results, where_filter) -> QueryResult: ...
    def delete(self, where_filter) -> None: ...
    def get_or_create_collection(self, name) -> None: ...
```

**Backend changes**:
- `server.py` - Inject `VectorStore` instead of direct ChromaDB client
- New files: `vectorstore/chromadb.py`, `vectorstore/qdrant.py`, etc.
- Config option to select vector store backend

### What Stays the Same

- **Ingestion pipeline**: Parsing, chunking, metadata extraction unchanged
- **Plugin code**: HTTP client talks to backend API, not vector DB directly
- **Embeddings**: Still generated server-side (sentence-transformers or Ollama)
- **MCP server**: Uses backend API, unaware of vector store implementation
- **Document schema**: Metadata structure remains consistent
