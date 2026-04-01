# Multi-Vault UX Improvement

## Problem

When using MCP with multiple vaults sharing a ChromaDB instance, the tools don't know which collection to query. Users must explicitly specify the collection in prompts, which is awkward.

**Current behavior:** MCP defaults to a hardcoded or arbitrary collection.

**Desired behavior:** Context-aware collection selection without verbose prompts.

## Proposed Solutions

### Option 1: Per-project MCP config
Add `default_collection` to `.mcp.json` metadata:
```json
{
  "mcpServers": {
    "obsidian-chromadb": {
      "url": "http://nautilus:8004/sse",
      "metadata": { "default_collection": "vault-ahead" }
    }
  }
}
```

### Option 2: Search all collections
Query all collections by default, return results tagged with source collection. User sees everything, filters mentally or via follow-up.

### Option 3: Working directory mapping
MCP server maps `cwd` paths to collections:
- `/home/user/Vault-Ahead/` → `vault-ahead`
- `/home/user/Vault-Test/` → `vault-test`

### Option 4: Environment variable
```bash
export OBSIDIAN_DEFAULT_COLLECTION=vault-ahead
```

## Recommendation

Option 2 (search all) as default behavior - least friction, most discoverable.
Option 1 as override for focused searches.

## Status

Not critical. Note for future enhancement.
