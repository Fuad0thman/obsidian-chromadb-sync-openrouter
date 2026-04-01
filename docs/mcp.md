# MCP Server

## Overview

Model Context Protocol (MCP) server enabling Claude Code to query your Obsidian vault.

## Transport Options

### SSE Transport (Recommended for Remote/Docker)

`obsidian_mcp_sse.py` - HTTP/SSE server for network access

**Deployment**:
```bash
docker compose up -d obsidian-mcp
```

**Configuration** (`.mcp.json`):
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

### stdio Transport (Local Use)

`obsidian_mcp.py` - stdin/stdout for local processes

**Configuration** (`.mcp.json`):
```json
{
  "mcpServers": {
    "obsidian-chromadb": {
      "command": "/path/to/venv/bin/python",
      "args": ["/path/to/mcp-server/obsidian_mcp.py"],
      "env": {
        "OBSIDIAN_SYNC_URL": "http://localhost:8002"
      }
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OBSIDIAN_SYNC_URL` | `http://localhost:8002` | Backend API URL |
| `MCP_PORT` | `8003` | SSE server port |
| `LOG_LEVEL` | `INFO` | Logging level |

## Available Tools

### search_vault

Semantic search over the vault.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `query` | string | yes | - | Search query |
| `collection` | string | no | "obsidian-vault" | Collection name |
| `top_k` | integer | no | 5 | Number of results |
| `folder_tag` | string | no | - | Filter by folder tag |

**Example**:
```
Search for "slurm configuration" in the bcm 11 manuals
```

Claude will call:
```json
{
  "query": "slurm configuration",
  "collection": "vault-test",
  "folder_tag": "bcm 11",
  "top_k": 5
}
```

### synthesize_answer

RAG-powered Q&A with source citations.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `query` | string | yes | - | Question to answer |
| `collection` | string | no | "obsidian-vault" | Collection name |
| `top_k` | integer | no | 5 | Context chunks |
| `folder_tag` | string | no | - | Filter context |
| `model` | string | no | - | Ollama model override |

**Note**: When using Claude Code, `synthesize_answer` is usually unnecessary since Claude can synthesize from `search_vault` results directly.

### list_collections

List available collections with document counts.

**Parameters**: None

**Response**:
```json
{
  "collections": [
    {"name": "vault-test", "count": 15549}
  ]
}
```

### list_folder_tags

List folder tags for filtering.

**Parameters**:
| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `collection` | string | no | "obsidian-vault" | Collection name |

**Response**:
```json
{
  "collection": "vault-test",
  "tags": ["bcm 09", "bcm 10", "bcm 11", "notes"]
}
```

### get_file_chunks

Get all chunks for a specific file.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `collection` | string | yes | Collection name |
| `file_path` | string | yes | Path to file |

## Usage with Claude Code

### Natural Language Queries

Just ask naturally:

> "How do I add a configuration overlay in BCM 11?"

Claude will:
1. Recognize the need to search the vault
2. Call `search_vault` with appropriate parameters
3. Synthesize an answer from the results

### Specifying Filters

Mention the filter context:

> "Search the BCM 11 manuals for PAM configuration"

Claude will infer `folder_tag="bcm 11"`.

### Discovering Available Tags

> "What folder tags are available in my vault?"

Claude will call `list_folder_tags` and show you the options.

## File Structure

```
mcp-server/
├── Dockerfile              # SSE server container
├── requirements.txt        # Python dependencies
├── obsidian_mcp.py         # stdio transport version
└── obsidian_mcp_sse.py     # SSE transport version
```

## SSE Protocol Details

The SSE server implements MCP over HTTP:

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sse` | SSE event stream |
| POST | `/message?session_id=X` | Send messages |
| GET | `/health` | Health check |

### Connection Flow

1. Client connects to `/sse`
2. Server sends `endpoint` event with message URL
3. Client sends JSON-RPC messages via POST
4. Server responds via SSE `message` events

### Example Session

```
Client → GET /sse
Server → event: endpoint
         data: /message?session_id=abc123

Client → POST /message?session_id=abc123
         {"jsonrpc":"2.0","id":1,"method":"initialize"}

Server → event: message
         data: {"jsonrpc":"2.0","id":1,"result":{...}}

Client → POST /message?session_id=abc123
         {"jsonrpc":"2.0","id":2,"method":"tools/list"}

Server → event: message
         data: {"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}
```

## Troubleshooting

### MCP Not Loading

Check Claude Code diagnostics:
```
/doctor
```

Verify config syntax in `.mcp.json`.

### Connection Failed

Test the SSE endpoint:
```bash
curl http://your-server:8004/health
```

Should return:
```json
{"status":"healthy","sessions":0}
```

### Tools Not Working

Check backend connectivity:
```bash
curl http://your-server:8002/health
```

Review MCP server logs:
```bash
docker logs obsidian-mcp-server
```

### Schema Errors

Ensure `.mcp.json` uses correct format:
- SSE: `{"type": "sse", "url": "..."}`
- stdio: `{"command": "...", "args": [...]}`
