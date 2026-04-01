# Obsidian Plugin

## Installation

1. Build the plugin:
   ```bash
   cd plugin
   npm install
   npm run build
   ```

2. Copy to your vault:
   ```bash
   cp -r plugin/* /path/to/vault/.obsidian/plugins/chromadb-sync/
   ```

3. Enable in Obsidian: Settings → Community Plugins → ChromaDB Sync

## Configuration

Access via Settings → ChromaDB Sync

### Connection Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Backend URL | URL of the obsidian-sync backend | `http://10.10.10.136:8002` |
| Collection Name | ChromaDB collection to use | `obsidian-vault` |

### Sync Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Auto-sync | Enable periodic sync | false |
| Sync Interval | Minutes between syncs | 5 |
| Chunk by Headers | Split markdown by headers | true |
| Max Chunk Size | Maximum characters per chunk | 2000 |
| Batch Size | Files per sync batch | 20 |
| Batch Delay | Milliseconds between batches | 2000 |

### Folder Settings

| Setting | Description |
|---------|-------------|
| Sync Mode | "Whole Vault" or "Whitelist" |
| Include Folders | Folders to include (whitelist mode) |
| Exclude Folders | Folders to exclude from sync |

### PDF Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Enable PDF Sync | Sync PDF files | true |
| PDF Chunk Size | Characters per PDF chunk | 1000 |
| PDF Chunk Overlap | Overlap between chunks | 200 |

### Folder Tagging

| Setting | Description |
|---------|-------------|
| Folder Tags | Map folder paths to tags for filtered queries |

## Commands

Available via Command Palette (Ctrl/Cmd + P):

- **Sync entire vault to ChromaDB** - Full re-sync of all files
- **Sync current file to ChromaDB** - Sync active file only
- **Sync modified files to ChromaDB** - Incremental sync
- **Delete ChromaDB collection** - Delete all data

## Sidebar View

The plugin adds a sidebar panel with three tabs:

### Search Tab

- Semantic search across your vault
- Filter by folder tag
- Click results to open files
- Navigate to specific sections via heading anchors

### Chat Tab

- RAG-powered Q&A over your vault
- Uses Ollama for synthesis
- Shows source citations
- Configure model in backend settings

### Sync Tab

- View sync status and statistics
- Database info (collection, chunk count, folder tags)
- Recent activity log
- Manual sync controls
- Cancel ongoing syncs

## Context Menu

Right-click folders in the file explorer:

- **Include in ChromaDB sync** - Add to whitelist (whitelist mode)
- **Remove from sync** - Remove from whitelist
- **Exclude from ChromaDB sync** - Add to exclusion list
- **Remove from exclusions** - Remove from exclusion list

## File Structure

```
plugin/
├── manifest.json           # Plugin metadata
├── package.json            # Dependencies
├── esbuild.config.mjs      # Build configuration
├── src/
│   ├── main.ts             # Plugin entry point
│   ├── settings.ts         # Settings UI and storage
│   ├── parser.ts           # Markdown parsing
│   ├── chromadb-client.ts  # Backend HTTP client
│   ├── sync-manager.ts     # Sync orchestration
│   └── chat-view.ts        # Sidebar UI
└── styles.css              # Plugin styles
```

## Sync Behavior

### Incremental Sync

Files are tracked via content hashing:
1. SHA256 hash computed on sync
2. Backend compares with stored hash
3. If unchanged, sync skipped
4. Only modified content re-embedded

### File Events

The plugin listens for vault events:
- **Create**: Mark file dirty for next sync
- **Modify**: Mark file dirty
- **Delete**: Delete chunks from ChromaDB
- **Rename**: Delete old path, sync new path

### Batch Processing

Large syncs are batched to avoid overwhelming the backend:
- Default: 20 files per batch
- 2 second delay between batches
- Progress shown in sync tab
- Can be cancelled mid-sync

## Folder Tags

Folder tags enable filtered queries:

1. Configure in Settings → Folder Tags
2. Map folder paths to tag names:
   ```
   manuals/bcm-11 → bcm 11
   projects/active → active
   ```
3. Files inherit tag from their folder
4. Query with folder_tag filter in search

## Troubleshooting

### Plugin Not Loading
- Check console for errors (Ctrl+Shift+I)
- Verify manifest.json is valid
- Ensure all files are in correct location

### Sync Failing
- Verify backend URL is correct
- Check backend health: `curl http://backend:8002/health`
- Review backend logs: `docker logs obsidian-sync-backend`

### Files Not Appearing in Search
- Check if file is in excluded folder
- Verify sync completed (check sync tab)
- Try manual sync of specific file

### Performance Issues
- Reduce sync interval
- Increase batch delay
- Exclude large folders (attachments, etc.)
