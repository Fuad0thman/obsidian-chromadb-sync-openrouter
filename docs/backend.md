# Backend API

## Overview

FastAPI server handling document ingestion, embedding generation, and semantic queries.

## Deployment

### Docker (Recommended)

```bash
docker compose up -d obsidian-sync
```

### Local Development

```bash
cd backend
pip install -r requirements.txt
uvicorn server:app --reload --port 8002
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROMADB_URL` | `http://localhost:8000` | ChromaDB server URL |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server for RAG |
| `OLLAMA_MODEL` | `llama3.2:latest` | Model for synthesis |
| `EMBEDDING_MODEL` | `all-MiniLM-L6-v2` | Sentence transformer model |
| `HNSW_SPACE` | `cosine` | Vector similarity metric |
| `LOG_LEVEL` | `INFO` | Logging level |

### docker-compose.yml

```yaml
obsidian-sync:
  build: ./backend
  ports:
    - "8002:8002"
  environment:
    - CHROMADB_URL=http://chromadb-obsidian:8000
    - OLLAMA_URL=http://host.docker.internal:11434
    - OLLAMA_MODEL=llama3.2:latest
    - EMBEDDING_MODEL=all-MiniLM-L6-v2
    - LOG_LEVEL=INFO
  deploy:
    resources:
      reservations:
        devices:
          - driver: nvidia
            count: 1
            capabilities: [gpu]
```

## API Reference

### Health Check

```
GET /health
```

**Response**:
```json
{
  "status": "healthy",
  "chromadb": "connected"
}
```

### Sync Markdown

```
POST /sync/markdown
```

**Request Body**:
```json
{
  "collection": "vault-test",
  "file_path": "notes/example.md",
  "content": "# Heading\n\nContent here...",
  "chunk_by_headers": true,
  "max_chunk_size": 2000,
  "folder_tag": "notes"
}
```

**Response**:
```json
{
  "success": true,
  "chunks": 3,
  "collection": "vault-test",
  "file_path": "notes/example.md",
  "skipped": false
}
```

### Sync PDF

```
POST /sync/pdf
Content-Type: multipart/form-data
```

**Form Fields**:
- `collection` - Collection name
- `file_path` - Path in vault
- `file` - PDF file
- `chunk_size` - Characters per chunk (default: 1000)
- `chunk_overlap` - Overlap between chunks (default: 200)
- `folder_tag` - Folder tag for filtering

### Query (Semantic Search)

```
POST /query
```

**Request Body**:
```json
{
  "collection": "vault-test",
  "query": "how to configure slurm",
  "top_k": 5,
  "folder_tag": "bcm 11"
}
```

**Response**:
```json
{
  "results": [
    {
      "id": "path/to/file.md_chunk_0",
      "document": "chunk content...",
      "distance": 0.234,
      "metadata": {
        "source": "path/to/file.md",
        "filename": "file.md",
        "chunk_index": 0,
        "header_path": "Section > Subsection",
        "folder_tag": "bcm 11",
        "file_type": "markdown"
      }
    }
  ]
}
```

### Query with Synthesis (RAG)

```
POST /query/synthesize
```

**Request Body**:
```json
{
  "collection": "vault-test",
  "query": "How do I restrict node access to users with running jobs?",
  "top_k": 5,
  "folder_tag": "bcm 11",
  "model": "llama3.2:latest"
}
```

**Response**:
```json
{
  "query": "How do I restrict node access...",
  "answer": "To restrict node access, use the onlywhenjob setting...",
  "model": "llama3.2:latest",
  "sources": [
    {
      "source": "manuals/bcm-11/admin.pdf",
      "filename": "admin.pdf",
      "distance": 0.234
    }
  ],
  "token_count": 256
}
```

### Delete File

```
POST /delete
```

**Request Body**:
```json
{
  "collection": "vault-test",
  "file_path": "notes/deleted.md"
}
```

### Delete Folder

```
POST /delete/folder
```

**Request Body**:
```json
{
  "collection": "vault-test",
  "folder_path": "archive/"
}
```

### List Collections

```
GET /collections
```

**Response**:
```json
[
  {"name": "vault-test", "count": 15549}
]
```

### Get Folder Tags

```
POST /collections/folder-tags
```

**Request Body**:
```json
{
  "collection": "vault-test"
}
```

**Response**:
```json
{
  "tags": ["bcm 09", "bcm 10", "bcm 11", "notes"]
}
```

### Graph: Outgoing Links

```
GET /graph/outgoing/{collection}/{file_path}
```

Returns files that the given file links to.

### Graph: Incoming Links

```
GET /graph/incoming/{collection}/{file_path}
```

Returns files that link to the given file (backlinks).

### Graph: Related Documents

```
GET /graph/related/{collection}/{file_path}?limit=10
```

Returns semantically related documents.

## Chunk Metadata Schema

### Markdown Chunks

```json
{
  "source": "path/to/file.md",
  "filename": "file.md",
  "chunk_index": 0,
  "total_chunks": 5,
  "header_path": "Section > Subsection",
  "heading": "Subsection",
  "folder_tag": "notes",
  "outgoing_links": "other-note,another-note",
  "tags": "project,important",
  "file_type": "markdown",
  "content_hash": "abc123...",
  "embedding_model": "all-MiniLM-L6-v2",
  "schema_version": "1.0",
  "fm_title": "Note Title",
  "fm_status": "active"
}
```

### PDF Chunks

```json
{
  "source": "path/to/file.pdf",
  "filename": "file.pdf",
  "chunk_index": 0,
  "total_chunks": 20,
  "page_start": 1,
  "page_end": 2,
  "folder_tag": "manuals",
  "file_type": "pdf",
  "content_hash": "def456...",
  "embedding_model": "all-MiniLM-L6-v2",
  "schema_version": "1.0"
}
```

## File Structure

```
backend/
├── Dockerfile              # GPU-enabled container
├── requirements.txt        # Python dependencies
├── server.py               # Main FastAPI application
├── parser.py               # Markdown parsing utilities
└── ingestion.py            # PDF extraction and chunking
```

## GPU Support

The backend uses PyTorch with CUDA for accelerated embedding generation:

- Base image: `pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime`
- GPU reserved via docker-compose `deploy.resources`
- Falls back to CPU if GPU unavailable

## Embedding Model

Default: `all-MiniLM-L6-v2` (sentence-transformers)
- 384 dimensions
- Fast inference
- Good general-purpose embeddings

To change models:
1. Set `EMBEDDING_MODEL` environment variable
2. Rebuild container to download new model
3. **Full re-index required** - embeddings incompatible between models
