#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════════
# Obsidian ChromaDB MCP Server (SSE Transport)
# Network-accessible MCP server for Docker deployment
# ═══════════════════════════════════════════════════════════════════════════════

import os
import json
import asyncio
import uuid
import logging
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# ───────────────────────────────────────────────────────────────────────────────
# Configuration
# ───────────────────────────────────────────────────────────────────────────────

BACKEND_URL = os.getenv("OBSIDIAN_SYNC_URL", "http://localhost:8002")
LOG_LEVEL   = os.getenv("LOG_LEVEL", "INFO")
MCP_PORT    = int(os.getenv("MCP_PORT", "8003"))

logging.basicConfig(level=LOG_LEVEL)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Obsidian ChromaDB MCP Server",
    description="MCP server with SSE transport for remote access",
    version="0.2.0",
)

# ───────────────────────────────────────────────────────────────────────────────
# Session Management
# ───────────────────────────────────────────────────────────────────────────────

# Store for active sessions and their message queues
sessions: dict[str, asyncio.Queue] = {}


# ───────────────────────────────────────────────────────────────────────────────
# Tool Definitions
# ───────────────────────────────────────────────────────────────────────────────

def get_tools() -> list[dict]:
    """Return available tools."""
    return [
        {
            "name": "search_vault",
            "description": "Search the Obsidian vault using semantic similarity. Returns relevant document chunks with their source files and metadata.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query - can be a question or topic"
                    },
                    "collection": {
                        "type": "string",
                        "description": "Collection name (usually the vault name)",
                        "default": "obsidian-vault"
                    },
                    "top_k": {
                        "type": "integer",
                        "description": "Number of results to return",
                        "default": 5
                    },
                    "folder_tag": {
                        "type": "string",
                        "description": "Optional folder tag to filter results (e.g., 'projects', 'notes')"
                    }
                },
                "required": ["query"]
            }
        },
        {
            "name": "synthesize_answer",
            "description": "Search the vault and generate an AI-synthesized answer using RAG. Returns a natural language answer with source citations.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The question to answer based on vault contents"
                    },
                    "collection": {
                        "type": "string",
                        "description": "Collection name (usually the vault name)",
                        "default": "obsidian-vault"
                    },
                    "top_k": {
                        "type": "integer",
                        "description": "Number of context chunks to use for synthesis",
                        "default": 5
                    },
                    "folder_tag": {
                        "type": "string",
                        "description": "Optional folder tag to filter context (e.g., 'projects', 'notes')"
                    },
                    "model": {
                        "type": "string",
                        "description": "Optional Ollama model override (defaults to server setting)"
                    }
                },
                "required": ["query"]
            }
        },
        {
            "name": "list_collections",
            "description": "List all available collections in the ChromaDB database with document counts.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "list_folder_tags",
            "description": "List all unique folder tags in a collection. Useful for understanding what content categories are available for filtering.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "collection": {
                        "type": "string",
                        "description": "Collection name",
                        "default": "obsidian-vault"
                    }
                },
                "required": []
            }
        },
        {
            "name": "get_file_chunks",
            "description": "Get all chunks for a specific file from the vault.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "collection": {
                        "type": "string",
                        "description": "Collection name"
                    },
                    "file_path": {
                        "type": "string",
                        "description": "Path to the file in the vault"
                    }
                },
                "required": ["collection", "file_path"]
            }
        }
    ]


# ───────────────────────────────────────────────────────────────────────────────
# Tool Implementations
# ───────────────────────────────────────────────────────────────────────────────

async def execute_tool(name: str, arguments: dict) -> Any:
    """Execute a tool and return results."""
    async with httpx.AsyncClient(timeout=120.0) as client:

        if name == "search_vault":
            return await _search_vault(
                client,
                query=arguments["query"],
                collection=arguments.get("collection", "obsidian-vault"),
                top_k=arguments.get("top_k", 5),
                folder_tag=arguments.get("folder_tag")
            )

        elif name == "synthesize_answer":
            return await _synthesize_answer(
                client,
                query=arguments["query"],
                collection=arguments.get("collection", "obsidian-vault"),
                top_k=arguments.get("top_k", 5),
                folder_tag=arguments.get("folder_tag"),
                model=arguments.get("model")
            )

        elif name == "list_collections":
            return await _list_collections(client)

        elif name == "list_folder_tags":
            return await _list_folder_tags(
                client,
                collection=arguments.get("collection", "obsidian-vault")
            )

        elif name == "get_file_chunks":
            return await _get_file_chunks(
                client,
                collection=arguments["collection"],
                file_path=arguments["file_path"]
            )

        else:
            return {"error": f"Unknown tool: {name}"}


async def _search_vault(
    client:     httpx.AsyncClient,
    query:      str,
    collection: str,
    top_k:      int,
    folder_tag: Optional[str] = None
) -> dict:
    """Search the vault using semantic similarity."""
    try:
        payload = {
            "collection": collection,
            "query":      query,
            "top_k":      top_k
        }
        if folder_tag:
            payload["folder_tag"] = folder_tag

        response = await client.post(f"{BACKEND_URL}/query", json=payload)
        response.raise_for_status()
        data = response.json()

        results = []
        for r in data.get("results", []):
            # Get folder_tags (new format) or fall back to folder_tag (legacy)
            folder_tags = r["metadata"].get("folder_tags", "") or r["metadata"].get("folder_tag", "")
            results.append({
                "source":      r["metadata"].get("source", "unknown"),
                "header_path": r["metadata"].get("header_path", ""),
                "folder_tags": folder_tags,
                "content":     r["document"],
                "distance":    r["distance"],
                "tags":        r["metadata"].get("tags", ""),
                "file_type":   r["metadata"].get("file_type", "unknown")
            })

        return {
            "query":       query,
            "folder_tag":  folder_tag,  # Query filter used
            "results":     results
        }

    except httpx.HTTPError as e:
        return {"error": f"HTTP error: {str(e)}"}
    except Exception as e:
        return {"error": str(e)}


async def _list_collections(client: httpx.AsyncClient) -> dict:
    """List all collections."""
    try:
        response = await client.get(f"{BACKEND_URL}/collections")
        response.raise_for_status()
        return {"collections": response.json()}

    except httpx.HTTPError as e:
        return {"error": f"HTTP error: {str(e)}"}
    except Exception as e:
        return {"error": str(e)}


async def _synthesize_answer(
    client:     httpx.AsyncClient,
    query:      str,
    collection: str,
    top_k:      int,
    folder_tag: Optional[str] = None,
    model:      Optional[str] = None
) -> dict:
    """Generate an AI-synthesized answer using RAG."""
    try:
        payload = {
            "collection": collection,
            "query":      query,
            "top_k":      top_k
        }
        if folder_tag:
            payload["folder_tag"] = folder_tag
        if model:
            payload["model"] = model

        response = await client.post(f"{BACKEND_URL}/query/synthesize", json=payload)
        response.raise_for_status()
        data = response.json()

        return {
            "query":       data.get("query", query),
            "answer":      data.get("answer", ""),
            "model":       data.get("model", "unknown"),
            "sources":     data.get("sources", []),
            "token_count": data.get("token_count")
        }

    except httpx.HTTPError as e:
        return {"error": f"HTTP error: {str(e)}"}
    except Exception as e:
        return {"error": str(e)}


async def _list_folder_tags(client: httpx.AsyncClient, collection: str) -> dict:
    """List all unique folder tags in a collection."""
    try:
        response = await client.post(
            f"{BACKEND_URL}/collections/folder-tags",
            json={"collection": collection}
        )
        response.raise_for_status()
        data = response.json()

        return {
            "collection": collection,
            "tags":       data.get("tags", [])
        }

    except httpx.HTTPError as e:
        return {"error": f"HTTP error: {str(e)}"}
    except Exception as e:
        return {"error": str(e)}


async def _get_file_chunks(
    client:     httpx.AsyncClient,
    collection: str,
    file_path:  str
) -> dict:
    """Get all chunks for a file."""
    try:
        filename = file_path.split("/")[-1]
        response = await client.post(
            f"{BACKEND_URL}/query",
            json={
                "collection": collection,
                "query":      filename,
                "top_k":      100
            }
        )
        response.raise_for_status()
        data = response.json()

        chunks = []
        for r in data.get("results", []):
            if r["metadata"].get("source") == file_path:
                chunks.append({
                    "chunk_index": r["metadata"].get("chunk_index", 0),
                    "header_path": r["metadata"].get("header_path", ""),
                    "content":     r["document"]
                })

        chunks.sort(key=lambda x: x["chunk_index"])

        return {
            "file_path":    file_path,
            "total_chunks": len(chunks),
            "chunks":       chunks
        }

    except httpx.HTTPError as e:
        return {"error": f"HTTP error: {str(e)}"}
    except Exception as e:
        return {"error": str(e)}


# ───────────────────────────────────────────────────────────────────────────────
# MCP Message Handling
# ───────────────────────────────────────────────────────────────────────────────

async def handle_message(message: dict) -> Optional[dict]:
    """Handle an MCP message and return response."""
    method = message.get("method", "")
    msg_id = message.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id":      msg_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name":    "obsidian-chromadb",
                    "version": "0.2.0"
                }
            }
        }

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id":      msg_id,
            "result": {
                "tools": get_tools()
            }
        }

    elif method == "tools/call":
        params    = message.get("params", {})
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})

        result = await execute_tool(tool_name, arguments)

        return {
            "jsonrpc": "2.0",
            "id":      msg_id,
            "result": {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(result, indent=2)
                    }
                ]
            }
        }

    elif method == "notifications/initialized":
        return None

    else:
        return {
            "jsonrpc": "2.0",
            "id":      msg_id,
            "error": {
                "code":    -32601,
                "message": f"Method not found: {method}"
            }
        }


# ───────────────────────────────────────────────────────────────────────────────
# SSE Endpoints
# ───────────────────────────────────────────────────────────────────────────────

class MCPMessage(BaseModel):
    """Incoming MCP message."""
    jsonrpc: str = "2.0"
    id:      Optional[int | str] = None
    method:  Optional[str] = None
    params:  Optional[dict] = None


@app.get("/sse")
async def sse_endpoint(request: Request):
    """SSE endpoint for MCP communication."""
    session_id = str(uuid.uuid4())
    sessions[session_id] = asyncio.Queue()

    logger.info(f"New SSE session: {session_id}")

    async def event_generator():
        try:
            # Send the session endpoint info
            yield f"event: endpoint\ndata: /message?session_id={session_id}\n\n"

            while True:
                if await request.is_disconnected():
                    break

                try:
                    # Wait for messages with timeout to allow disconnect check
                    message = await asyncio.wait_for(
                        sessions[session_id].get(),
                        timeout=30.0
                    )
                    yield f"event: message\ndata: {json.dumps(message)}\n\n"
                except asyncio.TimeoutError:
                    # Send keepalive
                    yield ": keepalive\n\n"

        finally:
            logger.info(f"SSE session ended: {session_id}")
            sessions.pop(session_id, None)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection":    "keep-alive",
        }
    )


@app.post("/message")
async def message_endpoint(request: Request, session_id: str):
    """Receive MCP messages and queue responses."""
    if session_id not in sessions:
        return {"error": "Invalid session"}

    body = await request.json()
    logger.info(f"Received message: {body.get('method', 'unknown')}")

    response = await handle_message(body)

    if response:
        await sessions[session_id].put(response)

    return {"status": "ok"}


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "healthy", "sessions": len(sessions)}


# ───────────────────────────────────────────────────────────────────────────────
# Main Entry Point
# ───────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=MCP_PORT)
