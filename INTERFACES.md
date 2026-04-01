# 🧠 Obsidian ChromaDB Sync: Interaction Guide

This project provides multiple ways to interact with your knowledge base, from a GUI in Obsidian to a terminal-based CLI.

---

## 1. Obsidian GUI (Primary Interface)
The most integrated way to use this system is directly inside Obsidian.

### Setup
1. Enable the **Obsidian ChromaDB Sync** plugin in Settings.
2. In the plugin settings, set **Server URL** to `http://localhost:8002`.
3. Set **LLM Model** to `openai/gpt-4o-mini` (or your preferred OpenRouter model).

### Features
*   **Sync**: Click the database icon in the ribbon to perform a "Full Sync".
*   **Chat**: Open the **Chat View** (via Command Palette `Ctrl+P`) to ask questions about your notes.
*   **@Mentions**: Type `@` in chat to reference specific files.

---

## 2. Python CLI (Query & Management Tool)
Use this tool to search your notes, peek into the database, and manage collections without needing the backend server or a web browser.

### How to Run
Open a terminal in the `backend` directory and run:
```powershell
.\venv\Scripts\python.exe db_cli.py
```

### Options
1. **List Collections**: See all "vaults" currently indexed.
2. **Search / Query (Semantic)**: Perform a local vector search directly from your terminal.
3. **Count items**: See how many chunks a specific vault contains.
4. **Peek at data**: See the actual text chunks and metadata stored in the DB.
5. **Delete**: Permanently remove a collection.

---

## 3. PowerShell REST API (Developer/Automation)
Since the backend uses FastAPI, you can use standard HTTP requests to query your data. This is great for scripting or custom automation.

### List Collections
```powershell
Invoke-RestMethod -Uri "http://localhost:8002/collections"
```

### Perform a Semantic Search (Raw Data)
```powershell
$body = @{ 
    collection = "mockvault"
    query = "Who is John Doe?"
    top_k = 3
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:8002/query" -Method Post -Body $body -ContentType "application/json"
```

### Perform a RAG Chat (AI Synthesis)
```powershell
$body = @{ 
    collection = "mockvault"
    query = "Summarize the latest project sync meeting"
    top_k = 5
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "http://localhost:8002/query/synthesize" -Method Post -Body $body -ContentType "application/json"
$response.answer
```

---

## 4. Backend Server Status
The system requires the Python backend to be running. 

**Start Command:**
```powershell
cd backend
.\venv\Scripts\python.exe server.py
```

**Health Check:**
```powershell
Invoke-RestMethod -Uri "http://localhost:8002/health"
```

---

## Summary of Data Flow
1. **Notes (.md)** $\to$ **Backend** (Parsing & Local Embeddings)
2. **Embeddings** $\to$ **ChromaDB** (Stored in `backend/chromadb_data`)
3. **Query** $\to$ **ChromaDB** (Retrieval) $\to$ **OpenRouter** (Generation) $\to$ **You** (Answer)
