#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# Obsidian ChromaDB MCP Server
# Model Context Protocol server for Claude Code integration
# ═══════════════════════════════════════════════════════════════════════════

import json
import sys
import os
from typing import Any

import httpx

# ───────────────────────────────────────────────────────────────────────────────
# Configuration
# ───────────────────────────────────────────────────────────────────────────────

BACKEND_URL = os.getenv("OBSIDIAN_SYNC_URL", "http://localhost:8002")


# ───────────────────────────────────────────────────────────────────────────────
# MCP Protocol Implementation
# ───────────────────────────────────────────────────────────────────────────────

class MCPServer:
    """Simple MCP server for Obsidian ChromaDB queries."""

    def __init__(self):
        self.client = httpx.Client(timeout=30.0)

    # ─────────────────────────────────────────────────────────────────
    # Tool Definitions
    # ─────────────────────────────────────────────────────────────────

    def get_tools(self) -> list[dict]:
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

    # ─────────────────────────────────────────────────────────────────
    # Tool Execution
    # ─────────────────────────────────────────────────────────────────

    def execute_tool(self, name: str, arguments: dict) -> Any:
        """Execute a tool and return results."""

        if name == "search_vault":
            return self._search_vault(
                query=arguments["query"],
                collection=arguments.get("collection", "obsidian-vault"),
                top_k=arguments.get("top_k", 5),
                folder_tag=arguments.get("folder_tag")
            )

        elif name == "synthesize_answer":
            return self._synthesize_answer(
                query=arguments["query"],
                collection=arguments.get("collection", "obsidian-vault"),
                top_k=arguments.get("top_k", 5),
                folder_tag=arguments.get("folder_tag"),
                model=arguments.get("model")
            )

        elif name == "list_collections":
            return self._list_collections()

        elif name == "list_folder_tags":
            return self._list_folder_tags(
                collection=arguments.get("collection", "obsidian-vault")
            )

        elif name == "get_file_chunks":
            return self._get_file_chunks(
                collection=arguments["collection"],
                file_path=arguments["file_path"]
            )

        else:
            return {"error": f"Unknown tool: {name}"}

    def _search_vault(self, query: str, collection: str, top_k: int, folder_tag: str = None) -> dict:
        """Search the vault using semantic similarity."""
        try:
            payload = {
                "collection": collection,
                "query":      query,
                "top_k":      top_k
            }
            if folder_tag:
                payload["folder_tag"] = folder_tag

            response = self.client.post(
                f"{BACKEND_URL}/query",
                json=payload
            )
            response.raise_for_status()
            data = response.json()

            # Format results for better readability
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

    def _list_collections(self) -> dict:
        """List all collections."""
        try:
            response = self.client.get(f"{BACKEND_URL}/collections")
            response.raise_for_status()
            return {"collections": response.json()}

        except httpx.HTTPError as e:
            return {"error": f"HTTP error: {str(e)}"}
        except Exception as e:
            return {"error": str(e)}

    def _synthesize_answer(
        self,
        query:      str,
        collection: str,
        top_k:      int,
        folder_tag: str = None,
        model:      str = None
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

            response = self.client.post(
                f"{BACKEND_URL}/query/synthesize",
                json=payload,
                timeout=120.0  # Synthesis can take longer
            )
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

    def _list_folder_tags(self, collection: str) -> dict:
        """List all unique folder tags in a collection."""
        try:
            response = self.client.post(
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

    def _get_file_chunks(self, collection: str, file_path: str) -> dict:
        """Get all chunks for a file by searching with high top_k and filtering."""
        try:
            # Use the file name as query to find relevant chunks
            filename = file_path.split("/")[-1]
            response = self.client.post(
                f"{BACKEND_URL}/query",
                json={
                    "collection": collection,
                    "query": filename,
                    "top_k": 100  # Get many results
                }
            )
            response.raise_for_status()
            data = response.json()

            # Filter to only chunks from this file
            chunks = []
            for r in data.get("results", []):
                if r["metadata"].get("source") == file_path:
                    chunks.append({
                        "chunk_index":  r["metadata"].get("chunk_index", 0),
                        "header_path":  r["metadata"].get("header_path", ""),
                        "content":      r["document"]
                    })

            # Sort by chunk index
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

    # ─────────────────────────────────────────────────────────────────
    # MCP Message Handling
    # ─────────────────────────────────────────────────────────────────

    def handle_message(self, message: dict) -> dict:
        """Handle an MCP message and return response."""
        method = message.get("method", "")
        msg_id = message.get("id")

        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": {
                        "name": "obsidian-chromadb",
                        "version": "0.2.0"
                    }
                }
            }

        elif method == "tools/list":
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "tools": self.get_tools()
                }
            }

        elif method == "tools/call":
            params    = message.get("params", {})
            tool_name = params.get("name", "")
            arguments = params.get("arguments", {})

            result = self.execute_tool(tool_name, arguments)

            return {
                "jsonrpc": "2.0",
                "id": msg_id,
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
            # No response needed for notifications
            return None

        else:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {
                    "code": -32601,
                    "message": f"Method not found: {method}"
                }
            }

    def run(self):
        """Run the MCP server, reading from stdin and writing to stdout."""
        while True:
            try:
                line = sys.stdin.readline()
                if not line:
                    break

                message = json.loads(line)
                response = self.handle_message(message)

                if response:
                    sys.stdout.write(json.dumps(response) + "\n")
                    sys.stdout.flush()

            except json.JSONDecodeError:
                continue
            except Exception as e:
                error_response = {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {
                        "code": -32603,
                        "message": str(e)
                    }
                }
                sys.stdout.write(json.dumps(error_response) + "\n")
                sys.stdout.flush()


# ───────────────────────────────────────────────────────────────────────────────
# Main Entry Point
# ───────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    server = MCPServer()
    server.run()
