#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# Obsidian Sync Backend - FastAPI Server (OpenRouter Integrated)
# ═══════════════════════════════════════════════════════════════════════════

import os
import re
import hashlib
import logging
from typing import Optional, Dict, List, Tuple
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx
from dotenv import load_dotenv

import chromadb
from sentence_transformers import SentenceTransformer
from rank_bm25 import BM25Okapi

# Load environment variables from .env file
load_dotenv()

from parser import parse_markdown, ParserOptions
from ingestion import (
    extract_pdf_pages, chunk_pdf_with_pages,
    extract_xlsx_rows, chunk_xlsx_rows,
    extract_csv_rows, chunk_csv_rows,
    extract_docx_paragraphs, chunk_docx_paragraphs
)

# ───────────────────────────────────────────────────────────────────────────────
# Configuration
# ───────────────────────────────────────────────────────────────────────────────

CHROMA_PERSIST_DIRECTORY = os.getenv("CHROMA_PERSIST_DIRECTORY", "./chromadb_data")
OPENROUTER_API_KEY      = os.getenv("OPENROUTER_API_KEY")
OPENROUTER_MODEL        = os.getenv("OPENROUTER_MODEL", "openai/gpt-4o-mini")
LOG_LEVEL               = os.getenv("LOG_LEVEL", "INFO")

# Schema versioning for future migrations
SCHEMA_VERSION  = "1.0"
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
HNSW_SPACE      = os.getenv("HNSW_SPACE", "cosine")

logging.basicConfig(level=LOG_LEVEL)
logger = logging.getLogger(__name__)

# ───────────────────────────────────────────────────────────────────────────────
# Global State
# ───────────────────────────────────────────────────────────────────────────────

chroma_client: chromadb.PersistentClient = None
embedding_model: SentenceTransformer = None

# BM25 index cache: collection_name -> (index, doc_ids, doc_count)
# Cache is invalidated when doc_count changes
bm25_cache: Dict[str, Tuple[BM25Okapi, List[str], int]] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize connections on startup."""
    global chroma_client, embedding_model

    logger.info(f"Using local ChromaDB at {CHROMA_PERSIST_DIRECTORY}")
    chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIRECTORY)

    logger.info(f"Loading embedding model: {EMBEDDING_MODEL}")
    embedding_model = SentenceTransformer(EMBEDDING_MODEL)
    logger.info("Startup complete")

    yield

    logger.info("Shutting down")


app = FastAPI(
    title="Obsidian Sync Backend",
    description="Ingestion and query API for Obsidian vault sync to ChromaDB",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ───────────────────────────────────────────────────────────────────────────────
# BM25 Hybrid Search Helpers
# ───────────────────────────────────────────────────────────────────────────────

def tokenize_text(text: str) -> List[str]:
    """Simple tokenizer for BM25 - lowercase, split on non-alphanumeric."""
    return re.findall(r'\w+', text.lower())


def get_bm25_index(collection_name: str, folder_tag: Optional[str] = None) -> Tuple[BM25Okapi, List[str]]:
    """
    Get or build BM25 index for a collection.

    Returns (bm25_index, doc_ids) where doc_ids[i] corresponds to corpus[i].
    Cache is invalidated when document count changes.
    """
    global bm25_cache

    collection = chroma_client.get_collection(collection_name)
    current_count = collection.count()

    # Build cache key including folder_tag for filtered searches
    cache_key = f"{collection_name}:{folder_tag or 'all'}"

    # Check cache validity
    if cache_key in bm25_cache:
        cached_index, cached_ids, cached_count = bm25_cache[cache_key]
        if cached_count == current_count:
            return cached_index, cached_ids

    logger.info(f"Building BM25 index for {collection_name} (folder_tag={folder_tag}, docs={current_count})")

    # Fetch all documents from collection
    # ChromaDB get() with no IDs returns all documents
    where_clause = None
    if folder_tag:
        where_clause = {"folder_tag": {"$eq": folder_tag.lower()}}

    # Get documents in batches (ChromaDB has limits)
    all_docs = []
    all_ids  = []
    batch_size = 5000
    offset = 0

    while True:
        results = collection.get(
            where=where_clause,
            include=["documents"],
            limit=batch_size,
            offset=offset
        )

        if not results["ids"]:
            break

        all_ids.extend(results["ids"])
        all_docs.extend(results["documents"])
        offset += batch_size

        if len(results["ids"]) < batch_size:
            break

    if not all_docs:
        # Return empty index
        empty_index = BM25Okapi([[]])
        return empty_index, []

    # Tokenize documents for BM25
    tokenized_corpus = [tokenize_text(doc) for doc in all_docs]

    # Build BM25 index
    bm25_index = BM25Okapi(tokenized_corpus)

    # Cache it
    bm25_cache[cache_key] = (bm25_index, all_ids, current_count)

    logger.info(f"BM25 index built: {len(all_docs)} documents indexed")

    return bm25_index, all_ids


def reciprocal_rank_fusion(
    semantic_results: List[Tuple[str, float]],
    bm25_results: List[Tuple[str, float]],
    k: int = 60
) -> List[Tuple[str, float]]:
    """
    Combine semantic and BM25 results using Reciprocal Rank Fusion.

    Args:
        semantic_results: List of (doc_id, distance) from semantic search
        bm25_results: List of (doc_id, score) from BM25 search
        k: RRF constant (default 60 is standard)

    Returns:
        List of (doc_id, rrf_score) sorted by score descending
    """
    rrf_scores: Dict[str, float] = {}

    # Process semantic results (rank by distance ascending - lower is better)
    for rank, (doc_id, _) in enumerate(semantic_results, start=1):
        rrf_scores[doc_id] = rrf_scores.get(doc_id, 0) + 1.0 / (k + rank)

    # Process BM25 results (already sorted by score descending - higher is better)
    for rank, (doc_id, _) in enumerate(bm25_results, start=1):
        rrf_scores[doc_id] = rrf_scores.get(doc_id, 0) + 1.0 / (k + rank)

    # Sort by RRF score descending
    sorted_results = sorted(rrf_scores.items(), key=lambda x: x[1], reverse=True)

    return sorted_results


# ───────────────────────────────────────────────────────────────────────────────
# Request/Response Models
# ───────────────────────────────────────────────────────────────────────────────

class SyncMarkdownRequest(BaseModel):
    collection:       str
    file_path:        str
    content:          str
    chunk_by_headers: bool = True
    max_chunk_size:   int  = 2000
    folder_tag:       str  = ""     # Legacy single tag (deprecated)
    folder_tags:      str  = ""     # Pipe-delimited: "|tag1|tag2|"


class SyncFileResponse(BaseModel):
    success:     bool
    chunks:      int
    collection:  str
    file_path:   str
    skipped:     bool = False  # True if content unchanged, no sync needed


class QueryRequest(BaseModel):
    collection: str
    query:      str
    top_k:      int = 5
    folder_tag: Optional[str] = None   # Filter by folder tag
    hybrid:     bool = False           # Use hybrid search (semantic + BM25)


class QueryResult(BaseModel):
    id:         str
    document:   str
    distance:   float
    metadata:   dict


class QueryResponse(BaseModel):
    results: list[QueryResult]


class DeleteRequest(BaseModel):
    collection: str
    file_path:  str


class DeleteFolderRequest(BaseModel):
    collection:  str
    folder_path: str


class CollectionInfo(BaseModel):
    name:  str
    count: int


class FolderTagsRequest(BaseModel):
    collection: str


# ───────────────────────────────────────────────────────────────────────────────
# Health Check
# ───────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    try:
        chroma_client.heartbeat()
        return {"status": "healthy", "chromadb": "connected"}
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return {"status": "unhealthy", "error": str(e)}


# ───────────────────────────────────────────────────────────────────────────────
# OpenRouter / Ollama Compatibility
# ───────────────────────────────────────────────────────────────────────────────

class OllamaModel(BaseModel):
    name:        str
    size:        Optional[int] = None
    modified_at: Optional[str] = None


class OllamaModelsResponse(BaseModel):
    models:        list[OllamaModel]
    default_model: str


@app.get("/ollama/models", response_model=OllamaModelsResponse)
async def list_models():
    """List available models (Mocking Ollama for plugin compatibility)."""
    # Return OpenRouter model as default
    return OllamaModelsResponse(
        models=[OllamaModel(name=OPENROUTER_MODEL)],
        default_model=OPENROUTER_MODEL,
    )


# ───────────────────────────────────────────────────────────────────────────────
# Collection Management
# ───────────────────────────────────────────────────────────────────────────────

@app.get("/collections", response_model=list[CollectionInfo])
async def list_collections():
    """List all collections with document counts."""
    collections = chroma_client.list_collections()
    result = []
    for col in collections:
        result.append(CollectionInfo(
            name=col.name,
            count=col.count()
        ))
    return result


@app.post("/collections/folder-tags")
async def get_folder_tags(request: FolderTagsRequest):
    """Get unique folder tags from a collection."""
    try:
        try:
            collection = chroma_client.get_collection(request.collection)
        except Exception as e:
            if "does not exist" in str(e):
                return {"tags": []}
            raise

        # Get all documents with their metadata
        all_docs = collection.get(include=["metadatas"], limit=100000)

        if not all_docs["metadatas"]:
            return {"tags": []}

        # Extract unique folder tags from both folder_tags and legacy folder_tag
        tags = set()
        for meta in all_docs["metadatas"]:
            # New format: pipe-delimited "|tag1|tag2|"
            folder_tags = meta.get("folder_tags", "")
            if folder_tags:
                # Extract individual tags from pipe-delimited format
                for tag in folder_tags.split("|"):
                    tag = tag.strip()
                    if tag:
                        tags.add(tag)
            # Legacy format: single tag string
            folder_tag = meta.get("folder_tag", "")
            if folder_tag:
                tags.add(folder_tag)

        return {"tags": sorted(list(tags))}
    except Exception as e:
        logger.error(f"Get folder tags failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/collections/{name}")
async def create_collection(name: str):
    """Create a new collection."""
    try:
        collection = chroma_client.get_or_create_collection(
            name=name,
            metadata={
                "hnsw:space":       HNSW_SPACE,
                "schema_version":   SCHEMA_VERSION,
                "embedding_model":  EMBEDDING_MODEL,
            }
        )
        return {"name": collection.name, "created": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/collections/{name}")
async def delete_collection(name: str):
    """Delete a collection."""
    try:
        chroma_client.delete_collection(name)
        return {"deleted": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ───────────────────────────────────────────────────────────────────────────────
# Content Hash Helpers
# ───────────────────────────────────────────────────────────────────────────────

def compute_content_hash(content: bytes | str) -> str:
    """Compute SHA256 hash of content."""
    if isinstance(content, str):
        content = content.encode('utf-8')
    return hashlib.sha256(content).hexdigest()


def extract_first_tag(tags_value: str) -> str:
    """Extract first tag from pipe-delimited format for legacy folder_tag field.

    Input:  "|tag1|tag2|tag3|" or "tag1"
    Output: "tag1"
    """
    if not tags_value:
        return ""
    # Handle pipe-delimited format
    for tag in tags_value.split("|"):
        tag = tag.strip()
        if tag:
            return tag.lower()
    return ""


def get_existing_hash(collection, file_path: str) -> Optional[str]:
    """Get the content hash of an existing file in the collection."""
    try:
        results = collection.get(
            where={"source": file_path},
            limit=1,
            include=["metadatas"]
        )
        if results["metadatas"] and len(results["metadatas"]) > 0:
            return results["metadatas"][0].get("content_hash")
    except Exception:
        pass
    return None


# ───────────────────────────────────────────────────────────────────────────────
# Markdown Sync
# ───────────────────────────────────────────────────────────────────────────────

@app.post("/sync/markdown", response_model=SyncFileResponse)
async def sync_markdown(request: SyncMarkdownRequest):
    """Sync a markdown file to ChromaDB."""
    logger.info(f"Syncing markdown: {request.file_path} to {request.collection}")

    try:
        # ─────────────────────────────────────────────────────────────────
        # Compute content hash
        # ─────────────────────────────────────────────────────────────────
        content_hash = compute_content_hash(request.content)

        # ─────────────────────────────────────────────────────────────────
        # Get or create collection
        # ─────────────────────────────────────────────────────────────────
        collection = chroma_client.get_or_create_collection(
            name=request.collection,
            metadata={
                "hnsw:space":       HNSW_SPACE,
                "schema_version":   SCHEMA_VERSION,
                "embedding_model":  EMBEDDING_MODEL,
            }
        )

        # ─────────────────────────────────────────────────────────────────
        # Check if content has changed
        # ─────────────────────────────────────────────────────────────────
        existing_hash = get_existing_hash(collection, request.file_path)
        if existing_hash == content_hash:
            logger.info(f"Skipping {request.file_path} - content unchanged")
            # Get existing chunk count for response
            existing = collection.get(where={"source": request.file_path}, include=[])
            return SyncFileResponse(
                success=True,
                chunks=len(existing["ids"]) if existing["ids"] else 0,
                collection=request.collection,
                file_path=request.file_path,
                skipped=True
            )

        # ─────────────────────────────────────────────────────────────────
        # Parse markdown
        # ─────────────────────────────────────────────────────────────────
        options = ParserOptions(
            chunk_by_headers=request.chunk_by_headers,
            max_chunk_size=request.max_chunk_size
        )
        parsed = parse_markdown(request.content, options)

        if not parsed.chunks:
            return SyncFileResponse(
                success=True,
                chunks=0,
                collection=request.collection,
                file_path=request.file_path
            )

        # ─────────────────────────────────────────────────────────────────
        # Delete existing chunks for this file
        # ─────────────────────────────────────────────────────────────────
        try:
            collection.delete(where={"source": request.file_path})
        except Exception:
            pass  # File might not exist yet

        # ─────────────────────────────────────────────────────────────────
        # Generate embeddings and add chunks
        # ─────────────────────────────────────────────────────────────────
        documents = [c.content for c in parsed.chunks]
        embeddings = embedding_model.encode(documents).tolist()

        ids = [f"{request.file_path}_chunk_{i}" for i in range(len(documents))]
        metadatas = []

        for i, chunk in enumerate(parsed.chunks):
            # Extract the heading anchor for navigation
            # header_path is like "Header 1 > Subheader 2" - get the last one
            heading = ""
            if chunk.header_path:
                parts = chunk.header_path.split(" > ")
                heading = parts[-1] if parts else ""

            # Use folder_tags if provided, otherwise fall back to folder_tag for backward compat
            tags_value = request.folder_tags if request.folder_tags else request.folder_tag

            meta = {
                "source":          request.file_path,
                "filename":        request.file_path.split("/")[-1],
                "chunk_index":     i,
                "total_chunks":    len(parsed.chunks),
                "header_path":     chunk.header_path,
                "heading":         heading,  # For direct navigation
                "folder_tag":      extract_first_tag(tags_value),  # Legacy: first tag for filtering
                "folder_tags":     tags_value,  # Pipe-delimited: "|tag1|tag2|"
                "outgoing_links":  ",".join(parsed.wikilinks),
                "tags":            ",".join(parsed.tags),
                "file_type":       "markdown",
                "content_hash":    content_hash,
                "embedding_model": EMBEDDING_MODEL,
                "schema_version":  SCHEMA_VERSION,
            }
            # Add frontmatter fields
            for key, value in parsed.frontmatter.items():
                if isinstance(value, (str, int, float, bool)):
                    meta[f"fm_{key}"] = value
            metadatas.append(meta)

        collection.add(
            ids=ids,
            documents=documents,
            embeddings=embeddings,
            metadatas=metadatas
        )

        logger.info(f"Added {len(documents)} chunks for {request.file_path}")

        return SyncFileResponse(
            success=True,
            chunks=len(documents),
            collection=request.collection,
            file_path=request.file_path
        )

    except Exception as e:
        logger.error(f"Sync failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ───────────────────────────────────────────────────────────────────────────────
# PDF Sync
# ───────────────────────────────────────────────────────────────────────────────

@app.post("/sync/pdf", response_model=SyncFileResponse)
async def sync_pdf(
    collection:     str = Form(...),
    file_path:      str = Form(...),
    file:           UploadFile = File(...),
    chunk_size:     int = Form(1000),
    chunk_overlap:  int = Form(200),
    folder_tag:     str = Form(""),    # Legacy single tag (deprecated)
    folder_tags:    str = Form(""),    # Pipe-delimited: "|tag1|tag2|"
):
    """Sync a PDF file to ChromaDB."""
    logger.info(f"Syncing PDF: {file_path} to {collection}")

    try:
        # ─────────────────────────────────────────────────────────────────
        # Read PDF and compute hash
        # ─────────────────────────────────────────────────────────────────
        pdf_bytes = await file.read()
        content_hash = compute_content_hash(pdf_bytes)

        # ─────────────────────────────────────────────────────────────────
        # Get or create collection
        # ─────────────────────────────────────────────────────────────────
        coll = chroma_client.get_or_create_collection(
            name=collection,
            metadata={
                "hnsw:space":       HNSW_SPACE,
                "schema_version":   SCHEMA_VERSION,
                "embedding_model":  EMBEDDING_MODEL,
            }
        )

        # ─────────────────────────────────────────────────────────────────
        # Check if content has changed
        # ─────────────────────────────────────────────────────────────────
        existing_hash = get_existing_hash(coll, file_path)
        if existing_hash == content_hash:
            logger.info(f"Skipping {file_path} - content unchanged")
            existing = coll.get(where={"source": file_path}, include=[])
            return SyncFileResponse(
                success=True,
                chunks=len(existing["ids"]) if existing["ids"] else 0,
                collection=collection,
                file_path=file_path,
                skipped=True
            )

        # ─────────────────────────────────────────────────────────────────
        # Extract text from PDF with page numbers
        # ─────────────────────────────────────────────────────────────────
        pages = extract_pdf_pages(pdf_bytes)

        if not pages:
            return SyncFileResponse(
                success=True,
                chunks=0,
                collection=collection,
                file_path=file_path
            )

        # ─────────────────────────────────────────────────────────────────
        # Chunk with page tracking
        # ─────────────────────────────────────────────────────────────────
        pdf_chunks = chunk_pdf_with_pages(pages, chunk_size, chunk_overlap)

        if not pdf_chunks:
            return SyncFileResponse(
                success=True,
                chunks=0,
                collection=collection,
                file_path=file_path
            )

        # ─────────────────────────────────────────────────────────────────
        # Delete existing chunks for this file
        # ─────────────────────────────────────────────────────────────────
        try:
            coll.delete(where={"source": file_path})
        except Exception:
            pass

        # ─────────────────────────────────────────────────────────────────
        # Generate embeddings and add chunks
        # ─────────────────────────────────────────────────────────────────
        documents = [c.text for c in pdf_chunks]
        embeddings = embedding_model.encode(documents).tolist()

        ids = [f"{file_path}_chunk_{i}" for i in range(len(pdf_chunks))]
        metadatas = []

        # Use folder_tags if provided, otherwise fall back to folder_tag for backward compat
        tags_value = folder_tags if folder_tags else folder_tag

        for i, chunk in enumerate(pdf_chunks):
            metadatas.append({
                "source":          file_path,
                "filename":        file_path.split("/")[-1],
                "chunk_index":     i,
                "total_chunks":    len(pdf_chunks),
                "page_start":      chunk.page_start,
                "page_end":        chunk.page_end,
                "folder_tag":      extract_first_tag(tags_value),  # Legacy: first tag for filtering
                "folder_tags":     tags_value,  # Pipe-delimited: "|tag1|tag2|"
                "file_type":       "pdf",
                "content_hash":    content_hash,
                "embedding_model": EMBEDDING_MODEL,
                "schema_version":  SCHEMA_VERSION,
            })

        coll.add(
            ids=ids,
            documents=documents,
            embeddings=embeddings,
            metadatas=metadatas
        )

        logger.info(f"Added {len(pdf_chunks)} chunks for {file_path}")

        return SyncFileResponse(
            success=True,
            chunks=len(pdf_chunks),
            collection=collection,
            file_path=file_path
        )

    except Exception as e:
        logger.error(f"PDF sync failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ───────────────────────────────────────────────────────────────────────────────
# XLSX Sync
# ───────────────────────────────────────────────────────────────────────────────

@app.post("/sync/xlsx", response_model=SyncFileResponse)
async def sync_xlsx(
    collection:     str = Form(...),
    file_path:      str = Form(...),
    file:           UploadFile = File(...),
    rows_per_chunk: int = Form(10),
    max_chunk_size: int = Form(2000),
    folder_tag:     str = Form(""),    # Legacy single tag (deprecated)
    folder_tags:    str = Form(""),    # Pipe-delimited: "|tag1|tag2|"
):
    """Sync an XLSX file to ChromaDB.

    Rows are chunked with header context for semantic search.
    Each row becomes: "Header1: Value1, Header2: Value2, ..."
    """
    logger.info(f"Syncing XLSX: {file_path} to {collection}")

    try:
        # ─────────────────────────────────────────────────────────────────
        # Read XLSX and compute hash
        # ─────────────────────────────────────────────────────────────────
        xlsx_bytes = await file.read()
        content_hash = compute_content_hash(xlsx_bytes)

        # ─────────────────────────────────────────────────────────────────
        # Get or create collection
        # ─────────────────────────────────────────────────────────────────
        coll = chroma_client.get_or_create_collection(
            name=collection,
            metadata={
                "hnsw:space":       HNSW_SPACE,
                "schema_version":   SCHEMA_VERSION,
                "embedding_model":  EMBEDDING_MODEL,
            }
        )

        # ─────────────────────────────────────────────────────────────────
        # Check if content has changed
        # ─────────────────────────────────────────────────────────────────
        existing_hash = get_existing_hash(coll, file_path)
        if existing_hash == content_hash:
            logger.info(f"Skipping {file_path} - content unchanged")
            existing = coll.get(where={"source": file_path}, include=[])
            return SyncFileResponse(
                success=True,
                chunks=len(existing["ids"]) if existing["ids"] else 0,
                collection=collection,
                file_path=file_path,
                skipped=True
            )

        # ─────────────────────────────────────────────────────────────────
        # Extract rows with header context
        # ─────────────────────────────────────────────────────────────────
        rows = extract_xlsx_rows(xlsx_bytes)

        if not rows:
            return SyncFileResponse(
                success=True,
                chunks=0,
                collection=collection,
                file_path=file_path
            )

        # ─────────────────────────────────────────────────────────────────
        # Chunk rows
        # ─────────────────────────────────────────────────────────────────
        xlsx_chunks = chunk_xlsx_rows(rows, rows_per_chunk, max_chunk_size)

        if not xlsx_chunks:
            return SyncFileResponse(
                success=True,
                chunks=0,
                collection=collection,
                file_path=file_path
            )

        # ─────────────────────────────────────────────────────────────────
        # Delete existing chunks for this file
        # ─────────────────────────────────────────────────────────────────
        try:
            coll.delete(where={"source": file_path})
        except Exception:
            pass

        # ─────────────────────────────────────────────────────────────────
        # Generate embeddings and add chunks
        # ─────────────────────────────────────────────────────────────────
        documents = [c.text for c in xlsx_chunks]
        embeddings = embedding_model.encode(documents).tolist()

        ids = [f"{file_path}_chunk_{i}" for i in range(len(xlsx_chunks))]
        metadatas = []

        # Use folder_tags if provided, otherwise fall back to folder_tag
        tags_value = folder_tags if folder_tags else folder_tag

        for i, chunk in enumerate(xlsx_chunks):
            metadatas.append({
                "source":          file_path,
                "filename":        file_path.split("/")[-1],
                "chunk_index":     i,
                "total_chunks":    len(xlsx_chunks),
                "sheet_name":      chunk.sheet_name,
                "row_start":       chunk.row_start,
                "row_end":         chunk.row_end,
                "folder_tag":      extract_first_tag(tags_value),  # Legacy: first tag for filtering
                "folder_tags":     tags_value,
                "file_type":       "xlsx",
                "content_hash":    content_hash,
                "embedding_model": EMBEDDING_MODEL,
                "schema_version":  SCHEMA_VERSION,
            })

        coll.add(
            ids=ids,
            documents=documents,
            embeddings=embeddings,
            metadatas=metadatas
        )

        logger.info(f"Added {len(xlsx_chunks)} chunks for {file_path}")

        return SyncFileResponse(
            success=True,
            chunks=len(xlsx_chunks),
            collection=collection,
            file_path=file_path
        )

    except Exception as e:
        logger.error(f"XLSX sync failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ───────────────────────────────────────────────────────────────────────────────
# CSV Sync
# ───────────────────────────────────────────────────────────────────────────────

@app.post("/sync/csv", response_model=SyncFileResponse)
async def sync_csv(
    collection:     str = Form(...),
    file_path:      str = Form(...),
    file:           UploadFile = File(...),
    rows_per_chunk: int = Form(10),
    max_chunk_size: int = Form(2000),
    folder_tag:     str = Form(""),    # Legacy single tag (deprecated)
    folder_tags:    str = Form(""),    # Pipe-delimited: "|tag1|tag2|"
):
    """Sync a CSV file to ChromaDB.

    Rows are chunked with header context for semantic search.
    Each row becomes: "Header1: Value1, Header2: Value2, ..."
    Auto-detects delimiter (comma, tab, semicolon, etc.)
    """
    logger.info(f"Syncing CSV: {file_path} to {collection}")

    try:
        # ─────────────────────────────────────────────────────────────────
        # Read CSV and compute hash
        # ─────────────────────────────────────────────────────────────────
        csv_bytes = await file.read()
        content_hash = compute_content_hash(csv_bytes)

        # ─────────────────────────────────────────────────────────────────
        # Get or create collection
        # ─────────────────────────────────────────────────────────────────
        coll = chroma_client.get_or_create_collection(
            name=collection,
            metadata={
                "hnsw:space":       HNSW_SPACE,
                "schema_version":   SCHEMA_VERSION,
                "embedding_model":  EMBEDDING_MODEL,
            }
        )

        # ─────────────────────────────────────────────────────────────────
        # Check if content has changed
        # ─────────────────────────────────────────────────────────────────
        existing_hash = get_existing_hash(coll, file_path)
        if existing_hash == content_hash:
            logger.info(f"Skipping {file_path} - content unchanged")
            existing = coll.get(where={"source": file_path}, include=[])
            return SyncFileResponse(
                success=True,
                chunks=len(existing["ids"]) if existing["ids"] else 0,
                collection=collection,
                file_path=file_path,
                skipped=True
            )

        # ─────────────────────────────────────────────────────────────────
        # Extract rows with header context
        # ─────────────────────────────────────────────────────────────────
        rows = extract_csv_rows(csv_bytes)

        if not rows:
            return SyncFileResponse(
                success=True,
                chunks=0,
                collection=collection,
                file_path=file_path
            )

        # ─────────────────────────────────────────────────────────────────
        # Chunk rows
        # ─────────────────────────────────────────────────────────────────
        csv_chunks = chunk_csv_rows(rows, rows_per_chunk, max_chunk_size)

        if not csv_chunks:
            return SyncFileResponse(
                success=True,
                chunks=0,
                collection=collection,
                file_path=file_path
            )

        # ─────────────────────────────────────────────────────────────────
        # Delete existing chunks for this file
        # ─────────────────────────────────────────────────────────────────
        try:
            coll.delete(where={"source": file_path})
        except Exception:
            pass

        # ─────────────────────────────────────────────────────────────────
        # Generate embeddings and add chunks
        # ─────────────────────────────────────────────────────────────────
        documents = [c.text for c in csv_chunks]
        embeddings = embedding_model.encode(documents).tolist()

        ids = [f"{file_path}_chunk_{i}" for i in range(len(csv_chunks))]
        metadatas = []

        # Use folder_tags if provided, otherwise fall back to folder_tag
        tags_value = folder_tags if folder_tags else folder_tag

        for i, chunk in enumerate(csv_chunks):
            metadatas.append({
                "source":          file_path,
                "filename":        file_path.split("/")[-1],
                "chunk_index":     i,
                "total_chunks":    len(csv_chunks),
                "row_start":       chunk.row_start,
                "row_end":         chunk.row_end,
                "folder_tag":      extract_first_tag(tags_value),  # Legacy: first tag for filtering
                "folder_tags":     tags_value,
                "file_type":       "csv",
                "content_hash":    content_hash,
                "embedding_model": EMBEDDING_MODEL,
                "schema_version":  SCHEMA_VERSION,
            })

        coll.add(
            ids=ids,
            documents=documents,
            embeddings=embeddings,
            metadatas=metadatas
        )

        logger.info(f"Added {len(csv_chunks)} chunks for {file_path}")

        return SyncFileResponse(
            success=True,
            chunks=len(csv_chunks),
            collection=collection,
            file_path=file_path
        )

    except Exception as e:
        logger.error(f"CSV sync failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ───────────────────────────────────────────────────────────────────────────────
# DOCX Sync
# ───────────────────────────────────────────────────────────────────────────────

@app.post("/sync/docx", response_model=SyncFileResponse)
async def sync_docx(
    collection:     str = Form(...),
    file_path:      str = Form(...),
    file:           UploadFile = File(...),
    chunk_size:     int = Form(1500),
    chunk_overlap:  int = Form(200),
    folder_tag:     str = Form(""),    # Legacy single tag (deprecated)
    folder_tags:    str = Form(""),    # Pipe-delimited: "|tag1|tag2|"
):
    """Sync a DOCX file to ChromaDB.

    Paragraphs are chunked with heading context preserved.
    """
    logger.info(f"Syncing DOCX: {file_path} to {collection}")

    try:
        # ─────────────────────────────────────────────────────────────────
        # Read DOCX and compute hash
        # ─────────────────────────────────────────────────────────────────
        docx_bytes = await file.read()
        content_hash = compute_content_hash(docx_bytes)

        # ─────────────────────────────────────────────────────────────────
        # Get or create collection
        # ─────────────────────────────────────────────────────────────────
        coll = chroma_client.get_or_create_collection(
            name=collection,
            metadata={
                "hnsw:space":       HNSW_SPACE,
                "schema_version":   SCHEMA_VERSION,
                "embedding_model":  EMBEDDING_MODEL,
            }
        )

        # ─────────────────────────────────────────────────────────────────
        # Check if content has changed
        # ─────────────────────────────────────────────────────────────────
        existing_hash = get_existing_hash(coll, file_path)
        if existing_hash == content_hash:
            logger.info(f"Skipping {file_path} - content unchanged")
            existing = coll.get(where={"source": file_path}, include=[])
            return SyncFileResponse(
                success=True,
                chunks=len(existing["ids"]) if existing["ids"] else 0,
                collection=collection,
                file_path=file_path,
                skipped=True
            )

        # ─────────────────────────────────────────────────────────────────
        # Extract paragraphs with heading context
        # ─────────────────────────────────────────────────────────────────
        paragraphs = extract_docx_paragraphs(docx_bytes)

        if not paragraphs:
            return SyncFileResponse(
                success=True,
                chunks=0,
                collection=collection,
                file_path=file_path
            )

        # ─────────────────────────────────────────────────────────────────
        # Chunk paragraphs
        # ─────────────────────────────────────────────────────────────────
        docx_chunks = chunk_docx_paragraphs(paragraphs, chunk_size, chunk_overlap)

        if not docx_chunks:
            return SyncFileResponse(
                success=True,
                chunks=0,
                collection=collection,
                file_path=file_path
            )

        # ─────────────────────────────────────────────────────────────────
        # Delete existing chunks for this file
        # ─────────────────────────────────────────────────────────────────
        try:
            coll.delete(where={"source": file_path})
        except Exception:
            pass

        # ─────────────────────────────────────────────────────────────────
        # Generate embeddings and add chunks
        # ─────────────────────────────────────────────────────────────────
        documents = [c.text for c in docx_chunks]
        embeddings = embedding_model.encode(documents).tolist()

        ids = [f"{file_path}_chunk_{i}" for i in range(len(docx_chunks))]
        metadatas = []

        # Use folder_tags if provided, otherwise fall back to folder_tag
        tags_value = folder_tags if folder_tags else folder_tag

        for i, chunk in enumerate(docx_chunks):
            metadatas.append({
                "source":          file_path,
                "filename":        file_path.split("/")[-1],
                "chunk_index":     i,
                "total_chunks":    len(docx_chunks),
                "heading_path":    chunk.heading_path,
                "folder_tag":      extract_first_tag(tags_value),  # Legacy: first tag for filtering
                "folder_tags":     tags_value,
                "file_type":       "docx",
                "content_hash":    content_hash,
                "embedding_model": EMBEDDING_MODEL,
                "schema_version":  SCHEMA_VERSION,
            })

        coll.add(
            ids=ids,
            documents=documents,
            embeddings=embeddings,
            metadatas=metadatas
        )

        logger.info(f"Added {len(docx_chunks)} chunks for {file_path}")

        return SyncFileResponse(
            success=True,
            chunks=len(docx_chunks),
            collection=collection,
            file_path=file_path
        )

    except Exception as e:
        logger.error(f"DOCX sync failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ───────────────────────────────────────────────────────────────────────────────
# Query
# ───────────────────────────────────────────────────────────────────────────────

@app.post("/query", response_model=QueryResponse)
async def query_collection(request: QueryRequest):
    """Query a collection with semantic search, optionally using hybrid (semantic + BM25)."""
    logger.info(f"Query: '{request.query}' in {request.collection}, folder_tag={request.folder_tag}, hybrid={request.hybrid}")

    try:
        collection = chroma_client.get_collection(request.collection)

        # Build where clause if folder_tag filter provided
        where_clause = None
        if request.folder_tag:
            tag = request.folder_tag.lower()
            where_clause = {"folder_tag": {"$eq": tag}}

        # ─────────────────────────────────────────────────────────────────────
        # Step 1: Semantic search
        # ─────────────────────────────────────────────────────────────────────
        query_embedding = embedding_model.encode([request.query]).tolist()

        # For hybrid, fetch more results to merge (2x top_k from each method)
        n_semantic = request.top_k * 2 if request.hybrid else request.top_k

        semantic_results = collection.query(
            query_embeddings=query_embedding,
            n_results=n_semantic,
            where=where_clause,
            include=["documents", "metadatas", "distances"]
        )

        # ─────────────────────────────────────────────────────────────────────
        # Step 2: BM25 search (if hybrid enabled)
        # ─────────────────────────────────────────────────────────────────────
        if request.hybrid:
            bm25_index, bm25_doc_ids = get_bm25_index(request.collection, request.folder_tag)

            if bm25_doc_ids:
                # Tokenize query and score
                query_tokens = tokenize_text(request.query)
                bm25_scores = bm25_index.get_scores(query_tokens)

                # Get top results from BM25
                scored_docs = list(zip(bm25_doc_ids, bm25_scores))
                scored_docs.sort(key=lambda x: x[1], reverse=True)
                bm25_top = scored_docs[:n_semantic]

                # Prepare semantic results for RRF
                semantic_for_rrf = [
                    (semantic_results["ids"][0][i], semantic_results["distances"][0][i])
                    for i in range(len(semantic_results["ids"][0]))
                ]

                # Combine with RRF
                fused_results = reciprocal_rank_fusion(semantic_for_rrf, bm25_top)

                # Fetch full documents for top_k fused results
                top_ids = [doc_id for doc_id, _ in fused_results[:request.top_k]]

                # Get documents by ID
                fetched = collection.get(
                    ids=top_ids,
                    include=["documents", "metadatas"]
                )

                # Build result map for ordering
                result_map = {}
                for i, doc_id in enumerate(fetched["ids"]):
                    result_map[doc_id] = {
                        "document": fetched["documents"][i],
                        "metadata": fetched["metadatas"][i]
                    }

                # Build response in RRF order
                query_results = []
                for doc_id, rrf_score in fused_results[:request.top_k]:
                    if doc_id in result_map:
                        query_results.append(QueryResult(
                            id=doc_id,
                            document=result_map[doc_id]["document"],
                            distance=1.0 - rrf_score,  # Convert RRF score to distance-like (lower = better)
                            metadata=result_map[doc_id]["metadata"]
                        ))

                return QueryResponse(results=query_results)

        # ─────────────────────────────────────────────────────────────────────
        # Non-hybrid: return semantic results directly
        # ─────────────────────────────────────────────────────────────────────
        query_results = []
        for i in range(len(semantic_results["ids"][0])):
            query_results.append(QueryResult(
                id=semantic_results["ids"][0][i],
                document=semantic_results["documents"][0][i],
                distance=semantic_results["distances"][0][i],
                metadata=semantic_results["metadatas"][0][i]
            ))

        return QueryResponse(results=query_results)

    except Exception as e:
        logger.error(f"Query failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ───────────────────────────────────────────────────────────────────────────────
# Synthesized Query (LLM-powered RAG)
# ───────────────────────────────────────────────────────────────────────────────

class SynthesizeRequest(BaseModel):
    collection:   str
    query:        str
    top_k:        int = 5
    model:        Optional[str] = None   # Override default model
    folder_tag:   Optional[str] = None   # Filter by folder tag
    hybrid:       bool = False           # Use hybrid search (semantic + BM25)


class SynthesizeResponse(BaseModel):
    query:        str
    answer:       str
    model:        str
    sources:      list[dict]
    token_count:  Optional[int] = None


@app.post("/query/synthesize", response_model=SynthesizeResponse)
async def query_synthesize(request: SynthesizeRequest):
    """Query with LLM synthesis - RAG-style answer generation via OpenRouter."""
    logger.info(f"Synthesize query: '{request.query}' in {request.collection}, folder_tag={request.folder_tag}, hybrid={request.hybrid}")

    model = request.model or OPENROUTER_MODEL

    try:
        # ─────────────────────────────────────────────────────────────────────
        # Step 1: Get relevant chunks (hybrid or semantic-only)
        # ─────────────────────────────────────────────────────────────────────
        collection = chroma_client.get_collection(request.collection)

        where_clause = None
        if request.folder_tag:
            tag = request.folder_tag.lower()
            where_clause = {"folder_tag": {"$eq": tag}}

        query_embedding = embedding_model.encode([request.query]).tolist()

        # For hybrid, fetch more results to merge
        n_fetch = request.top_k * 2 if request.hybrid else request.top_k

        semantic_results = collection.query(
            query_embeddings=query_embedding,
            n_results=n_fetch,
            where=where_clause,
            include=["documents", "metadatas", "distances"]
        )

        # Build final results list
        final_docs      = []
        final_metadatas = []
        final_distances = []

        if request.hybrid:
            # Run BM25 and combine with RRF
            bm25_index, bm25_doc_ids = get_bm25_index(request.collection, request.folder_tag)

            if bm25_doc_ids:
                query_tokens = tokenize_text(request.query)
                bm25_scores = bm25_index.get_scores(query_tokens)

                scored_docs = list(zip(bm25_doc_ids, bm25_scores))
                scored_docs.sort(key=lambda x: x[1], reverse=True)
                bm25_top = scored_docs[:n_fetch]

                semantic_for_rrf = [
                    (semantic_results["ids"][0][i], semantic_results["distances"][0][i])
                    for i in range(len(semantic_results["ids"][0]))
                ]

                fused_results = reciprocal_rank_fusion(semantic_for_rrf, bm25_top)
                top_ids = [doc_id for doc_id, _ in fused_results[:request.top_k]]

                fetched = collection.get(
                    ids=top_ids,
                    include=["documents", "metadatas"]
                )

                # Build ordered results
                result_map = {}
                for i, doc_id in enumerate(fetched["ids"]):
                    result_map[doc_id] = {
                        "document": fetched["documents"][i],
                        "metadata": fetched["metadatas"][i]
                    }

                for doc_id, rrf_score in fused_results[:request.top_k]:
                    if doc_id in result_map:
                        final_docs.append(result_map[doc_id]["document"])
                        final_metadatas.append(result_map[doc_id]["metadata"])
                        final_distances.append(1.0 - rrf_score)
            else:
                # Fallback to semantic-only if no BM25 docs
                for i in range(len(semantic_results["ids"][0][:request.top_k])):
                    final_docs.append(semantic_results["documents"][0][i])
                    final_metadatas.append(semantic_results["metadatas"][0][i])
                    final_distances.append(semantic_results["distances"][0][i])
        else:
            # Semantic-only
            for i in range(len(semantic_results["ids"][0])):
                final_docs.append(semantic_results["documents"][0][i])
                final_metadatas.append(semantic_results["metadatas"][0][i])
                final_distances.append(semantic_results["distances"][0][i])

        if not final_docs:
            return SynthesizeResponse(
                query=request.query,
                answer="No relevant documents found in the collection.",
                model=model,
                sources=[],
                token_count=None
            )

        # ─────────────────────────────────────────────────────────────────────
        # Step 2: Format context for the LLM
        # ─────────────────────────────────────────────────────────────────────
        context_parts = []
        sources = []

        for i in range(len(final_docs)):
            doc      = final_docs[i]
            meta     = final_metadatas[i]
            distance = final_distances[i]

            source_info = {
                "source":   meta.get("source", "unknown"),
                "filename": meta.get("filename", "unknown"),
                "distance": distance,
            }
            sources.append(source_info)

            context_parts.append(
                f"[Source: {meta.get('filename', 'unknown')}]\n{doc}"
            )

        context = "\n\n---\n\n".join(context_parts)

        # ─────────────────────────────────────────────────────────────────────
        # Step 3: Build prompt and call OpenRouter
        # ─────────────────────────────────────────────────────────────────────
        system_prompt = """You are a helpful assistant answering questions based on the provided context from a knowledge base.
Use the information in the context to answer the user's question accurately and concisely.
If the context doesn't contain enough information to fully answer the question, say so.
Always cite which sources you used when providing information."""

        user_prompt = f"""Context from knowledge base:

{context}

---

Question: {request.query}

Please provide a clear, concise answer based on the context above."""

        headers = {
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "HTTP-Referer": "https://github.com/MeatPopcicle/obsidian-chromadb-sync",
            "Content-Type": "application/json"
        }
        
        openrouter_payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "temperature": 0.3,
            "top_p": 0.9,
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                json=openrouter_payload
            )
            response.raise_for_status()
            openrouter_result = response.json()

        # Handle OpenRouter/OpenAI response format
        choices = openrouter_result.get("choices", [])
        if not choices:
            raise HTTPException(status_code=502, detail="Empty response from OpenRouter")
            
        answer = choices[0].get("message", {}).get("content", "").strip()
        usage = openrouter_result.get("usage", {})
        token_count = usage.get("total_tokens")

        logger.info(f"Synthesis complete, tokens: {token_count}")

        return SynthesizeResponse(
            query=request.query,
            answer=answer,
            model=model,
            sources=sources,
            token_count=usage.get("total_tokens")
        )

    except httpx.HTTPError as e:
        logger.error(f"OpenRouter API error: {e}")
        raise HTTPException(
            status_code=502,
            detail=f"Failed to reach OpenRouter: {str(e)}"
        )
    except Exception as e:
        logger.error(f"Synthesize failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ───────────────────────────────────────────────────────────────────────────────
# Graph Queries
# ───────────────────────────────────────────────────────────────────────────────

class GraphNode(BaseModel):
    source:     str
    filename:   str
    chunk_count: int = 1


class GraphResponse(BaseModel):
    source:   str
    nodes:    list[GraphNode]


@app.get("/graph/outgoing/{collection}/{file_path:path}", response_model=GraphResponse)
async def get_outgoing_links(collection: str, file_path: str):
    """Get documents that this file links to (outgoing wikilinks)."""
    logger.info(f"Graph outgoing: {file_path} in {collection}")

    try:
        coll = chroma_client.get_collection(collection)

        # Get the file's metadata to find its outgoing links
        results = coll.get(
            where={"source": file_path},
            limit=1,
            include=["metadatas"]
        )

        if not results["metadatas"]:
            return GraphResponse(source=file_path, nodes=[])

        # Parse outgoing links from metadata
        outgoing_links_str = results["metadatas"][0].get("outgoing_links", "")
        if not outgoing_links_str:
            return GraphResponse(source=file_path, nodes=[])

        link_targets = [l.strip() for l in outgoing_links_str.split(",") if l.strip()]

        # Find which of these targets exist in the collection
        nodes = []
        for target in link_targets:
            # Wikilinks might be just filename or path - search for matches
            target_results = coll.get(
                where={"$or": [
                    {"source": {"$eq": target}},
                    {"source": {"$eq": f"{target}.md"}},
                    {"filename": {"$eq": target}},
                    {"filename": {"$eq": f"{target}.md"}},
                ]},
                limit=100,
                include=["metadatas"]
            )

            if target_results["metadatas"]:
                # Group by source file
                sources = {}
                for meta in target_results["metadatas"]:
                    src = meta.get("source", "")
                    if src:
                        sources[src] = sources.get(src, 0) + 1

                for src, count in sources.items():
                    nodes.append(GraphNode(
                        source=src,
                        filename=src.split("/")[-1],
                        chunk_count=count
                    ))

        return GraphResponse(source=file_path, nodes=nodes)

    except Exception as e:
        logger.error(f"Graph outgoing failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/graph/incoming/{collection}/{file_path:path}", response_model=GraphResponse)
async def get_incoming_links(collection: str, file_path: str):
    """Get documents that link to this file (backlinks)."""
    logger.info(f"Graph incoming: {file_path} in {collection}")

    try:
        coll = chroma_client.get_collection(collection)

        # Extract filename without extension for matching wikilinks
        filename = file_path.split("/")[-1]
        filename_no_ext = filename.rsplit(".", 1)[0] if "." in filename else filename

        # Search for documents that have this file in their outgoing_links
        # ChromaDB doesn't support LIKE, so we get all and filter
        all_docs = coll.get(
            include=["metadatas"],
            limit=10000  # Reasonable limit
        )

        nodes = []
        sources_seen = set()

        for meta in all_docs["metadatas"]:
            outgoing = meta.get("outgoing_links", "")
            source = meta.get("source", "")

            if not outgoing or not source or source == file_path:
                continue

            # Check if any outgoing link matches our file
            links = [l.strip().lower() for l in outgoing.split(",")]
            if (filename_no_ext.lower() in links or
                filename.lower() in links or
                file_path.lower() in links):

                if source not in sources_seen:
                    sources_seen.add(source)
                    nodes.append(GraphNode(
                        source=source,
                        filename=source.split("/")[-1],
                        chunk_count=1
                    ))

        return GraphResponse(source=file_path, nodes=nodes)

    except Exception as e:
        logger.error(f"Graph incoming failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/graph/related/{collection}/{file_path:path}")
async def get_related_documents(collection: str, file_path: str, limit: int = 10):
    """Get related documents combining links and semantic similarity."""
    logger.info(f"Graph related: {file_path} in {collection}")

    try:
        coll = chroma_client.get_collection(collection)

        # Get linked sources directly (simpler approach)
        linked_sources = set()

        # Outgoing links
        logger.info("Getting outgoing links")
        try:
            out_results = coll.get(
                where={"source": file_path},
                limit=1,
                include=["metadatas"]
            )
            if out_results and "metadatas" in out_results:
                out_metas = out_results["metadatas"]
                if out_metas and len(out_metas) > 0:
                    out_links = out_metas[0].get("outgoing_links", "")
                    if out_links:
                        for link in out_links.split(","):
                            link = link.strip()
                            if link:
                                linked_sources.add(link)
        except Exception as out_err:
            logger.warning(f"Outgoing links error: {out_err}")

        logger.info(f"Found {len(linked_sources)} outgoing links")

        # For now, skip incoming links check (simplify)
        outgoing_count = len(linked_sources)
        incoming_count = 0

        # Get the file's content for semantic search
        logger.info("Fetching file embeddings")
        try:
            file_results = coll.get(
                where={"source": file_path},
                limit=1,
                include=["documents", "embeddings"]
            )
        except Exception as get_err:
            logger.error(f"coll.get failed: {get_err}")
            raise

        logger.info(f"Got file_results type: {type(file_results)}")

        semantic_results = []
        try:
            embeddings_list = file_results["embeddings"]
        except Exception as emb_err:
            logger.error(f"Getting embeddings failed: {emb_err}")
            embeddings_list = None
        logger.info(f"embeddings_list type: {type(embeddings_list)}")

        # Convert to regular list if numpy array
        if embeddings_list is not None and hasattr(embeddings_list, 'tolist'):
            embeddings_list = embeddings_list.tolist()
            logger.info("Converted embeddings to list")

        has_embeddings = embeddings_list is not None and len(embeddings_list) > 0
        logger.info(f"has_embeddings: {has_embeddings}")

        if has_embeddings:
            # Use first chunk's embedding for similarity search
            first_embedding = embeddings_list[0]
            if hasattr(first_embedding, 'tolist'):
                first_embedding = first_embedding.tolist()

            sem_results = coll.query(
                query_embeddings=[first_embedding],
                n_results=limit + len(linked_sources) + 1,
                include=["metadatas", "distances"]
            )

            metadatas = sem_results.get("metadatas", [[]])
            distances = sem_results.get("distances", [[]])

            # Convert numpy arrays if needed
            if hasattr(metadatas, 'tolist'):
                metadatas = metadatas.tolist()
            if hasattr(distances, 'tolist'):
                distances = distances.tolist()

            if metadatas is not None and len(metadatas) > 0 and len(metadatas[0]) > 0:
                for i in range(len(metadatas[0])):
                    meta = metadatas[0][i]
                    src = meta.get("source", "")
                    if src and src != file_path:
                        dist = float(distances[0][i]) if (distances is not None and len(distances) > 0 and len(distances[0]) > i) else 0.0
                        is_linked = bool(src in linked_sources)
                        semantic_results.append({
                            "source": src,
                            "filename": src.split("/")[-1],
                            "distance": dist,
                            "linked": is_linked
                        })

        # Deduplicate
        seen = set()
        unique_results = []
        for r in semantic_results:
            if r["source"] not in seen:
                seen.add(r["source"])
                unique_results.append(r)

        # Sort: linked documents first, then by distance
        def sort_key(x):
            linked_val = 0 if x["linked"] else 1
            return (linked_val, x["distance"])

        unique_results.sort(key=sort_key)

        return {
            "source": file_path,
            "outgoing_count": outgoing_count,
            "incoming_count": incoming_count,
            "related": unique_results[:limit]
        }

    except Exception as e:
        import traceback
        logger.error(f"Graph related failed: {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


# ───────────────────────────────────────────────────────────────────────────────
# Delete
# ───────────────────────────────────────────────────────────────────────────────

@app.post("/delete")
async def delete_file(request: DeleteRequest):
    """Delete all chunks for a file from a collection."""
    logger.info(f"Deleting {request.file_path} from {request.collection}")

    try:
        collection = chroma_client.get_collection(request.collection)
        collection.delete(where={"source": request.file_path})
        return {"deleted": True, "file_path": request.file_path}
    except Exception as e:
        logger.error(f"Delete failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/delete/folder")
async def delete_folder(request: DeleteFolderRequest):
    """Delete all chunks for files in a folder from a collection."""
    logger.info(f"Deleting folder {request.folder_path} from {request.collection}")

    try:
        # Try to get the collection - if it doesn't exist, nothing to delete
        try:
            collection = chroma_client.get_collection(request.collection)
        except Exception as e:
            if "does not exist" in str(e):
                logger.info(f"Collection {request.collection} does not exist, nothing to delete")
                return {"deleted": True, "folder_path": request.folder_path, "files_deleted": 0}
            raise

        # ChromaDB doesn't support prefix matching, so we need to get all and filter
        # Get all unique sources in the collection
        all_docs = collection.get(include=["metadatas"], limit=100000)

        if not all_docs["metadatas"]:
            return {"deleted": True, "folder_path": request.folder_path, "files_deleted": 0}

        # Find all sources that start with this folder path
        folder_prefix = request.folder_path if request.folder_path.endswith("/") else request.folder_path + "/"
        sources_to_delete = set()

        for meta in all_docs["metadatas"]:
            source = meta.get("source", "")
            if source.startswith(folder_prefix):
                sources_to_delete.add(source)

        # Delete each source's chunks
        for source in sources_to_delete:
            try:
                collection.delete(where={"source": source})
            except Exception:
                pass  # Continue with other files

        logger.info(f"Deleted {len(sources_to_delete)} files from folder {request.folder_path}")

        return {
            "deleted":       True,
            "folder_path":   request.folder_path,
            "files_deleted": len(sources_to_delete),
        }
    except Exception as e:
        logger.error(f"Delete folder failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ───────────────────────────────────────────────────────────────────────────────
# Main
# ───────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)
