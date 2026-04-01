# 🚀 Obsidian ChromaDB Sync (OpenRouter Edition)

This is a specialized version of the Obsidian ChromaDB Sync project, optimized for users who want to skip Docker and leverage high-quality cloud LLMs via **OpenRouter.ai** while keeping their vector database local.

## 🌟 Key Features
- **Docker-Free Architecture**: Runs natively on your system using Python 3.11+ and Node.js.
- **OpenRouter Integration**: Connects to any model via OpenRouter API.
- **Free Model Optimized**: Designed to work perfectly with high-performance free models like **Qwen 2.5** and **Llama 3**.
- **Local Vector Storage**: Uses **ChromaDB** in persistent mode, stored directly in your project folder.
- **Local Embeddings**: Generates vectors locally using `sentence-transformers` (all-MiniLM-L6-v2) — **100% Free and Private**.
- **Hybrid Search**: Combines semantic vector search with BM25 keyword matching for superior retrieval accuracy.
- **@Mentions**: Directly reference specific files in your AI chat within Obsidian.

---

## 🆓 Free & Open Source Focus

This project is optimized for a "Zero Cost" AI workflow. By combining local embeddings with OpenRouter's free-tier models, you can have a powerful RAG system without a subscription.

### Recommended Free Models (OpenRouter)
Set these in your `.env` for the best free experience:
- **`qwen/qwen-2.5-72b-instruct:free`**: Excellent reasoning and large context.
- **`meta-llama/llama-3.1-8b-instruct:free`**: Fast and reliable for general note queries.
- **`google/gemma-2-9b-it:free`**: Great for summarization and creative tasks.

### Local Free Embeddings
The system uses the **`all-MiniLM-L6-v2`** model by default. It runs entirely on your CPU, meaning:
- **No Cost**: You never pay for "tokens" to index your notes.
- **Privacy**: Your notes stay on your machine during the vectorization process.
- **Speed**: Indexing is near-instant for most personal vaults.

---

## 🏗️ Architecture
1. **Obsidian Plugin**: The user interface for syncing notes and chatting.
2. **FastAPI Backend**: Orchestrates parsing, embedding, and LLM communication.
3. **ChromaDB**: A local persistent database for your note vectors.
4. **OpenRouter**: The cloud-based brain that synthesizes answers based on retrieved notes.

---

## 🛠️ Installation & Setup

### 1. Prerequisites
- **Python 3.11+**
- **Node.js & npm**
- **OpenRouter API Key** (Get one at [openrouter.ai](https://openrouter.ai/))

### 2. Backend Setup
1. Navigate to the `backend` folder.
2. Create a virtual environment:
   ```powershell
   python -m venv venv
   .\venv\Scripts\activate
   ```
3. Install dependencies:
   ```powershell
   pip install -r requirements.txt
   ```
4. Create a `.env` file in the `backend` folder (see [Configuration & Tuning](#-configuration--tuning) below).
5. Start the server:
   ```powershell
   python server.py
   ```

---

## ⚙️ Configuration & Tuning

You can fine-tune how the AI retrieves your notes by adjusting variables in your `backend/.env` file.

### Environment Variables
| Variable | Description | Default |
| :--- | :--- | :--- |
| `OPENROUTER_API_KEY` | Your OpenRouter API Key. | **Required** |
| `OPENROUTER_MODEL` | The LLM used to generate answers. | `openai/gpt-4o-mini` |
| `EMBEDDING_MODEL` | The local model that turns text into vectors. | `all-MiniLM-L6-v2` |
| `HNSW_SPACE` | The distance metric used for similarity. | `cosine` |
| `CHROMA_PERSIST_DIRECTORY` | Where the database is saved. | `./chromadb_data` |

### Tuning Search Proximity & Accuracy

1. **Embedding Model (`EMBEDDING_MODEL`)**:
   - `all-MiniLM-L6-v2`: (Current Default) Very fast and low memory usage. Great for most users.
   - `all-mpnet-base-v2`: Significantly more accurate but slower and uses more RAM. Use this if the AI is "missing" obvious connections.
   - *Note: Changing this requires deleting your `chromadb_data` and re-syncing.*

2. **Distance Metric (`HNSW_SPACE`)**:
   - `cosine`: Best for text similarity. It measures the angle between vectors (ignores document length).
   - `l2`: Squared L2 distance. Better for some specific datasets but generally less effective for RAG than cosine.
   - `ip`: Inner Product. Fast, but requires normalized vectors.

3. **Top-K (Search Breadth)**:
   - This is currently controlled by the plugin UI or the API request. Increasing `top_k` (e.g., from 5 to 10) allows the AI to see more context, but can lead to "noise" or hit context window limits.

4. **Hybrid Search**:
   - This version automatically uses **RRF (Reciprocal Rank Fusion)** to combine BM25 (keyword) and Semantic (vector) search. This ensures that if you search for a specific unique word (like a project code), it will find it even if the vector similarity is low.

### 3. Obsidian Plugin Setup
1. Navigate to the `plugin` folder.
2. Install and build:
   ```powershell
   npm install
   npm run build
   ```
3. Copy the following files to your vault at `.obsidian/plugins/obsidian-chromadb-sync/`:
   - `main.js`
   - `manifest.json`
4. Open Obsidian and enable the plugin under **Community Plugins**.

---

## 🚀 Usage
1. **Sync**: Click the database icon in the Obsidian ribbon and run "Full Sync" to index your vault.
2. **Chat**: Use the Command Palette (`Ctrl+P`) and search for `Open Chat View`.
3. **Ask**: Query your notes (e.g., *"What are my goals for Project Alpha?"*).

---

## 📂 Project Structure
- `backend/`: FastAPI server and database logic.
- `plugin/`: Obsidian TypeScript plugin source.
- `backend/chromadb_data/`: Local folder where your vector DB is saved (Backup this!).
- `backend/db_cli.py`: A handy terminal tool to manage your database.

---

## 🔒 Privacy
Your notes are processed locally for embeddings. Only the specific chunks relevant to your current question are sent to OpenRouter via an encrypted connection to generate an answer.
