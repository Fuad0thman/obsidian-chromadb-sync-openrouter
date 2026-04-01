// ════════════════════════════════════════════════════════════════════════════
// Backend API Client
// Communicates with obsidian-sync backend (which handles ChromaDB, embeddings)
// ════════════════════════════════════════════════════════════════════════════

import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { ChromaDBSyncSettings } from "./settings";
import type { DebugLogger } from "./debug-logger";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SyncResponse {
    success:    boolean;
    chunks:     number;
    collection: string;
    file_path:  string;
    skipped:    boolean;
}

export interface QueryResult {
    id:       string;
    document: string;
    distance: number;
    metadata: Record<string, unknown>;
}

export interface CollectionInfo {
    name:  string;
    count: number;
}

export interface SynthesizeSource {
    source:   string;
    filename: string;
    distance: number;
}

export interface SynthesizeResponse {
    query:       string;
    answer:      string;
    model:       string;
    sources:     SynthesizeSource[];
    token_count: number | null;
}

export interface OllamaModel {
    name:        string;
    size?:       number;
    modified_at?: string;
}

export interface OllamaModelsResponse {
    models:        OllamaModel[];
    default_model: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend Client
// ─────────────────────────────────────────────────────────────────────────────

export class ChromaDBClient {
    private backendUrl:     string;
    private collectionName: string;
    private logger:         DebugLogger | null;

    constructor(settings: ChromaDBSyncSettings, logger?: DebugLogger) {
        this.backendUrl     = settings.chromaDbUrl.replace(/\/$/, "");
        this.collectionName = settings.collectionName;
        this.logger         = logger || null;
        this.log("BackendClient initialized", { backendUrl: this.backendUrl, collection: this.collectionName });
    }

    private log(message: string, data?: unknown): void {
        if (this.logger) {
            this.logger.debug(`[Backend] ${message}`, data);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HTTP Helper
    // ─────────────────────────────────────────────────────────────────────────

    private async request(
        endpoint: string,
        method:   string = "GET",
        body?:    unknown
    ): Promise<RequestUrlResponse> {
        const url = `${this.backendUrl}${endpoint}`;
        const params: RequestUrlParam = {
            url,
            method,
            headers: { "Content-Type": "application/json" },
            throw:   false,
        };

        if (body) {
            params.body = JSON.stringify(body);
        }

        this.log(`HTTP ${method}`, { url, hasBody: !!body });

        try {
            const response = await requestUrl(params);
            this.log(`HTTP Response`, { url, status: response.status });
            return response;
        } catch (error) {
            this.logger?.error(`HTTP Request failed`, { url, method, error });
            throw error;
        }
    }

    updateSettings(settings: ChromaDBSyncSettings): void {
        this.backendUrl     = settings.chromaDbUrl.replace(/\/$/, "");
        this.collectionName = settings.collectionName;
        this.log("Settings updated", { backendUrl: this.backendUrl, collection: this.collectionName });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Connection Test
    // ─────────────────────────────────────────────────────────────────────────

    async testConnection(): Promise<boolean> {
        this.log("Testing connection");

        try {
            const response = await this.request("/health");
            if (response.status !== 200) {
                this.logger?.error("Connection test failed", { status: response.status, body: response.text });
                throw new Error(`Backend not reachable: ${response.status}`);
            }

            const data = response.json as { status: string; chromadb: string };
            if (data.status !== "healthy") {
                throw new Error(`Backend unhealthy: ${data.status}`);
            }

            this.log("Connection test successful", { response: data });
            return true;
        } catch (error) {
            this.logger?.error("Connection test exception", { error: String(error) });
            throw error;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Collection Management
    // ─────────────────────────────────────────────────────────────────────────

    async ensureCollection(): Promise<string> {
        this.log("Ensuring collection exists", { name: this.collectionName });

        const response = await this.request(`/collections/${this.collectionName}`, "POST");

        if (response.status !== 200 && response.status !== 201) {
            const err = response.text;
            this.logger?.error("Failed to create collection", { status: response.status, error: err });
            throw new Error(`Failed to create collection: ${err}`);
        }

        this.log("Collection ensured", { name: this.collectionName });
        return this.collectionName;
    }

    async deleteCollection(): Promise<void> {
        this.log("Deleting collection", { name: this.collectionName });

        const response = await this.request(`/collections/${this.collectionName}`, "DELETE");

        if (response.status !== 200 && response.status !== 404) {
            throw new Error(`Failed to delete collection: ${response.status}`);
        }

        this.log("Collection deleted");
    }

    async getCollectionCount(): Promise<number> {
        const response = await this.request("/collections");

        if (response.status !== 200) {
            return 0;
        }

        const collections = response.json as CollectionInfo[];
        const collection = collections.find(c => c.name === this.collectionName);
        return collection?.count || 0;
    }

    async getFolderTags(): Promise<string[]> {
        const response = await this.request("/collections/folder-tags", "POST", {
            collection: this.collectionName,
        });

        if (response.status !== 200) {
            return [];
        }

        const result = response.json as { tags: string[] };
        return result.tags || [];
    }

    async listCollections(): Promise<CollectionInfo[]> {
        const response = await this.request("/collections");

        if (response.status !== 200) {
            return [];
        }

        return response.json as CollectionInfo[];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Markdown Sync
    // ─────────────────────────────────────────────────────────────────────────

    async syncMarkdown(
        filePath:       string,
        content:        string,
        chunkByHeaders: boolean = true,
        maxChunkSize:   number  = 2000,
        folderTags?:    string,  // Pipe-delimited: "|tag1|tag2|"
        modifiedTime?:  number   // Unix timestamp in milliseconds
    ): Promise<SyncResponse> {
        this.log("Syncing markdown", { filePath, folderTags });

        const response = await this.request("/sync/markdown", "POST", {
            collection:       this.collectionName,
            file_path:        filePath,
            content:          content,
            chunk_by_headers: chunkByHeaders,
            max_chunk_size:   maxChunkSize,
            folder_tags:      folderTags || "",
            modified_time:    modifiedTime || Date.now(),
        });

        if (response.status !== 200) {
            const err = response.text;
            this.logger?.error("Markdown sync failed", { status: response.status, error: err });
            throw new Error(`Markdown sync failed: ${err}`);
        }

        const result = response.json as SyncResponse;
        this.log("Markdown synced", { chunks: result.chunks });
        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PDF Sync (via FormData - requires special handling)
    // ─────────────────────────────────────────────────────────────────────────

    async syncPdf(
        filePath:     string,
        fileData:     ArrayBuffer,
        chunkSize:    number = 1000,
        chunkOverlap: number = 200,
        folderTags?:  string,  // Pipe-delimited: "|tag1|tag2|"
        modifiedTime?: number  // Unix timestamp in milliseconds
    ): Promise<SyncResponse> {
        this.log("Syncing PDF", { filePath, folderTags });

        // Build form data
        const boundary = "----ObsidianSync" + Date.now();
        const parts: string[] = [];

        // Collection field
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="collection"`);
        parts.push("");
        parts.push(this.collectionName);

        // File path field
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="file_path"`);
        parts.push("");
        parts.push(filePath);

        // Chunk size
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="chunk_size"`);
        parts.push("");
        parts.push(String(chunkSize));

        // Chunk overlap
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="chunk_overlap"`);
        parts.push("");
        parts.push(String(chunkOverlap));

        // Folder tags (pipe-delimited)
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="folder_tags"`);
        parts.push("");
        parts.push(folderTags || "");

        // Modified time
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="modified_time"`);
        parts.push("");
        parts.push(String(modifiedTime || Date.now()));

        // Build the text portion
        const textPart = parts.join("\r\n") + "\r\n";

        // File field header
        const fileHeader = [
            `--${boundary}`,
            `Content-Disposition: form-data; name="file"; filename="${filePath.split("/").pop()}"`,
            `Content-Type: application/pdf`,
            "",
            ""
        ].join("\r\n");

        // Closing boundary
        const closingBoundary = `\r\n--${boundary}--\r\n`;

        // Combine all parts as ArrayBuffer
        const textEncoder = new TextEncoder();
        const textPartBytes    = textEncoder.encode(textPart);
        const fileHeaderBytes  = textEncoder.encode(fileHeader);
        const closingBytes     = textEncoder.encode(closingBoundary);
        const fileBytes        = new Uint8Array(fileData);

        const totalLength = textPartBytes.length + fileHeaderBytes.length + fileBytes.length + closingBytes.length;
        const combined    = new Uint8Array(totalLength);

        let offset = 0;
        combined.set(textPartBytes, offset);
        offset += textPartBytes.length;
        combined.set(fileHeaderBytes, offset);
        offset += fileHeaderBytes.length;
        combined.set(fileBytes, offset);
        offset += fileBytes.length;
        combined.set(closingBytes, offset);

        const url = `${this.backendUrl}/sync/pdf`;
        const params: RequestUrlParam = {
            url,
            method:      "POST",
            headers:     { "Content-Type": `multipart/form-data; boundary=${boundary}` },
            body:        combined.buffer,
            throw:       false,
        };

        try {
            const response = await requestUrl(params);

            if (response.status !== 200) {
                const err = response.text;
                this.logger?.error("PDF sync failed", { status: response.status, error: err });
                throw new Error(`PDF sync failed: ${err}`);
            }

            const result = response.json as SyncResponse;
            this.log("PDF synced", { chunks: result.chunks });
            return result;
        } catch (error) {
            this.logger?.error("PDF sync exception", { error: String(error) });
            throw error;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // XLSX Sync (via FormData)
    // ─────────────────────────────────────────────────────────────────────────

    async syncXlsx(
        filePath:      string,
        fileData:      ArrayBuffer,
        rowsPerChunk:  number = 10,
        maxChunkSize:  number = 2000,
        folderTags?:   string,   // Pipe-delimited: "|tag1|tag2|"
        modifiedTime?: number    // Unix timestamp in milliseconds
    ): Promise<SyncResponse> {
        this.log("Syncing XLSX", { filePath, folderTags });

        // Build form data
        const boundary = "----ObsidianSync" + Date.now();
        const parts: string[] = [];

        // Collection field
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="collection"`);
        parts.push("");
        parts.push(this.collectionName);

        // File path field
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="file_path"`);
        parts.push("");
        parts.push(filePath);

        // Rows per chunk
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="rows_per_chunk"`);
        parts.push("");
        parts.push(String(rowsPerChunk));

        // Max chunk size
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="max_chunk_size"`);
        parts.push("");
        parts.push(String(maxChunkSize));

        // Folder tags (pipe-delimited)
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="folder_tags"`);
        parts.push("");
        parts.push(folderTags || "");

        // Modified time
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="modified_time"`);
        parts.push("");
        parts.push(String(modifiedTime || Date.now()));

        // Build the text portion
        const textPart = parts.join("\r\n") + "\r\n";

        // File field header
        const fileHeader = [
            `--${boundary}`,
            `Content-Disposition: form-data; name="file"; filename="${filePath.split("/").pop()}"`,
            `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
            "",
            ""
        ].join("\r\n");

        // Closing boundary
        const closingBoundary = `\r\n--${boundary}--\r\n`;

        // Combine all parts as ArrayBuffer
        const textEncoder      = new TextEncoder();
        const textPartBytes    = textEncoder.encode(textPart);
        const fileHeaderBytes  = textEncoder.encode(fileHeader);
        const closingBytes     = textEncoder.encode(closingBoundary);
        const fileBytes        = new Uint8Array(fileData);

        const totalLength = textPartBytes.length + fileHeaderBytes.length + fileBytes.length + closingBytes.length;
        const combined    = new Uint8Array(totalLength);

        let offset = 0;
        combined.set(textPartBytes, offset);
        offset += textPartBytes.length;
        combined.set(fileHeaderBytes, offset);
        offset += fileHeaderBytes.length;
        combined.set(fileBytes, offset);
        offset += fileBytes.length;
        combined.set(closingBytes, offset);

        const url = `${this.backendUrl}/sync/xlsx`;
        const params: RequestUrlParam = {
            url,
            method:  "POST",
            headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
            body:    combined.buffer,
            throw:   false,
        };

        try {
            const response = await requestUrl(params);

            if (response.status !== 200) {
                const err = response.text;
                this.logger?.error("XLSX sync failed", { status: response.status, error: err });
                throw new Error(`XLSX sync failed: ${err}`);
            }

            const result = response.json as SyncResponse;
            this.log("XLSX synced", { chunks: result.chunks });
            return result;
        } catch (error) {
            this.logger?.error("XLSX sync exception", { error: String(error) });
            throw error;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CSV Sync (via FormData)
    // ─────────────────────────────────────────────────────────────────────────

    async syncCsv(
        filePath:      string,
        fileData:      ArrayBuffer,
        rowsPerChunk:  number = 10,
        maxChunkSize:  number = 2000,
        folderTags?:   string,   // Pipe-delimited: "|tag1|tag2|"
        modifiedTime?: number    // Unix timestamp in milliseconds
    ): Promise<SyncResponse> {
        this.log("Syncing CSV", { filePath, folderTags });

        // Build form data
        const boundary = "----ObsidianSync" + Date.now();
        const parts: string[] = [];

        // Collection field
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="collection"`);
        parts.push("");
        parts.push(this.collectionName);

        // File path field
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="file_path"`);
        parts.push("");
        parts.push(filePath);

        // Rows per chunk
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="rows_per_chunk"`);
        parts.push("");
        parts.push(String(rowsPerChunk));

        // Max chunk size
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="max_chunk_size"`);
        parts.push("");
        parts.push(String(maxChunkSize));

        // Folder tags (pipe-delimited)
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="folder_tags"`);
        parts.push("");
        parts.push(folderTags || "");

        // Modified time
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="modified_time"`);
        parts.push("");
        parts.push(String(modifiedTime || Date.now()));

        // Build the text portion
        const textPart = parts.join("\r\n") + "\r\n";

        // File field header
        const fileHeader = [
            `--${boundary}`,
            `Content-Disposition: form-data; name="file"; filename="${filePath.split("/").pop()}"`,
            `Content-Type: text/csv`,
            "",
            ""
        ].join("\r\n");

        // Closing boundary
        const closingBoundary = `\r\n--${boundary}--\r\n`;

        // Combine all parts as ArrayBuffer
        const textEncoder      = new TextEncoder();
        const textPartBytes    = textEncoder.encode(textPart);
        const fileHeaderBytes  = textEncoder.encode(fileHeader);
        const closingBytes     = textEncoder.encode(closingBoundary);
        const fileBytes        = new Uint8Array(fileData);

        const totalLength = textPartBytes.length + fileHeaderBytes.length + fileBytes.length + closingBytes.length;
        const combined    = new Uint8Array(totalLength);

        let offset = 0;
        combined.set(textPartBytes, offset);
        offset += textPartBytes.length;
        combined.set(fileHeaderBytes, offset);
        offset += fileHeaderBytes.length;
        combined.set(fileBytes, offset);
        offset += fileBytes.length;
        combined.set(closingBytes, offset);

        const url = `${this.backendUrl}/sync/csv`;
        const params: RequestUrlParam = {
            url,
            method:  "POST",
            headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
            body:    combined.buffer,
            throw:   false,
        };

        try {
            const response = await requestUrl(params);

            if (response.status !== 200) {
                const err = response.text;
                this.logger?.error("CSV sync failed", { status: response.status, error: err });
                throw new Error(`CSV sync failed: ${err}`);
            }

            const result = response.json as SyncResponse;
            this.log("CSV synced", { chunks: result.chunks });
            return result;
        } catch (error) {
            this.logger?.error("CSV sync exception", { error: String(error) });
            throw error;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DOCX Sync (via FormData)
    // ─────────────────────────────────────────────────────────────────────────

    async syncDocx(
        filePath:      string,
        fileData:      ArrayBuffer,
        chunkSize:     number = 1500,
        chunkOverlap:  number = 200,
        folderTags?:   string,   // Pipe-delimited: "|tag1|tag2|"
        modifiedTime?: number    // Unix timestamp in milliseconds
    ): Promise<SyncResponse> {
        this.log("Syncing DOCX", { filePath, folderTags });

        // Build form data
        const boundary = "----ObsidianSync" + Date.now();
        const parts: string[] = [];

        // Collection field
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="collection"`);
        parts.push("");
        parts.push(this.collectionName);

        // File path field
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="file_path"`);
        parts.push("");
        parts.push(filePath);

        // Chunk size
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="chunk_size"`);
        parts.push("");
        parts.push(String(chunkSize));

        // Chunk overlap
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="chunk_overlap"`);
        parts.push("");
        parts.push(String(chunkOverlap));

        // Folder tags (pipe-delimited)
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="folder_tags"`);
        parts.push("");
        parts.push(folderTags || "");

        // Modified time
        parts.push(`--${boundary}`);
        parts.push(`Content-Disposition: form-data; name="modified_time"`);
        parts.push("");
        parts.push(String(modifiedTime || Date.now()));

        // Build the text portion
        const textPart = parts.join("\r\n") + "\r\n";

        // File field header
        const fileHeader = [
            `--${boundary}`,
            `Content-Disposition: form-data; name="file"; filename="${filePath.split("/").pop()}"`,
            `Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
            "",
            ""
        ].join("\r\n");

        // Closing boundary
        const closingBoundary = `\r\n--${boundary}--\r\n`;

        // Combine all parts as ArrayBuffer
        const textEncoder      = new TextEncoder();
        const textPartBytes    = textEncoder.encode(textPart);
        const fileHeaderBytes  = textEncoder.encode(fileHeader);
        const closingBytes     = textEncoder.encode(closingBoundary);
        const fileBytes        = new Uint8Array(fileData);

        const totalLength = textPartBytes.length + fileHeaderBytes.length + fileBytes.length + closingBytes.length;
        const combined    = new Uint8Array(totalLength);

        let offset = 0;
        combined.set(textPartBytes, offset);
        offset += textPartBytes.length;
        combined.set(fileHeaderBytes, offset);
        offset += fileHeaderBytes.length;
        combined.set(fileBytes, offset);
        offset += fileBytes.length;
        combined.set(closingBytes, offset);

        const url = `${this.backendUrl}/sync/docx`;
        const params: RequestUrlParam = {
            url,
            method:  "POST",
            headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
            body:    combined.buffer,
            throw:   false,
        };

        try {
            const response = await requestUrl(params);

            if (response.status !== 200) {
                const err = response.text;
                this.logger?.error("DOCX sync failed", { status: response.status, error: err });
                throw new Error(`DOCX sync failed: ${err}`);
            }

            const result = response.json as SyncResponse;
            this.log("DOCX synced", { chunks: result.chunks });
            return result;
        } catch (error) {
            this.logger?.error("DOCX sync exception", { error: String(error) });
            throw error;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Delete
    // ─────────────────────────────────────────────────────────────────────────

    async deleteBySource(sourcePath: string): Promise<void> {
        this.log("Deleting by source", { sourcePath });

        const response = await this.request("/delete", "POST", {
            collection: this.collectionName,
            file_path:  sourcePath,
        });

        if (response.status !== 200) {
            const err = response.text;
            if (!err.includes("not found")) {
                this.logger?.error("Failed to delete by source", { status: response.status, error: err });
                throw new Error(`Failed to delete documents: ${err}`);
            }
        }

        this.log("Deleted by source", { sourcePath });
    }

    async deleteByFolder(folderPath: string): Promise<number> {
        this.log("Deleting by folder", { folderPath });

        const response = await this.request("/delete/folder", "POST", {
            collection:  this.collectionName,
            folder_path: folderPath,
        });

        if (response.status !== 200) {
            const err = response.text;
            this.logger?.error("Failed to delete folder", { status: response.status, error: err });
            throw new Error(`Failed to delete folder: ${err}`);
        }

        const result = response.json as { deleted: boolean; folder_path: string; files_deleted: number };
        this.log("Deleted by folder", { folderPath, filesDeleted: result.files_deleted });
        return result.files_deleted;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Query
    // ─────────────────────────────────────────────────────────────────────────

    async query(
        queryText:  string,
        nResults:   number = 5,
        folderTag?: string
    ): Promise<QueryResult[]> {
        const body: Record<string, unknown> = {
            collection: this.collectionName,
            query:      queryText,
            top_k:      nResults,
        };

        // Normalize folder tag to lowercase for case-insensitive matching
        if (folderTag) {
            body.folder_tag = folderTag.toLowerCase();
        }

        const response = await this.request("/query", "POST", body);

        if (response.status !== 200) {
            const err = response.text;
            throw new Error(`Query failed: ${err}`);
        }

        const data = response.json as { results: QueryResult[] };
        return data.results;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Synthesized Query (LLM RAG)
    // ─────────────────────────────────────────────────────────────────────────

    async synthesize(
        queryText:  string,
        nResults:   number = 5,
        model?:     string,
        folderTag?: string
    ): Promise<SynthesizeResponse> {
        this.log("Synthesize query", { query: queryText, nResults, model, folderTag });

        const body: Record<string, unknown> = {
            collection: this.collectionName,
            query:      queryText,
            top_k:      nResults,
        };

        if (model) {
            body.model = model;
        }

        // Normalize folder tag to lowercase for case-insensitive matching
        if (folderTag) {
            body.folder_tag = folderTag.toLowerCase();
        }

        const response = await this.request("/query/synthesize", "POST", body);

        if (response.status !== 200) {
            const err = response.text;
            this.logger?.error("Synthesize failed", { status: response.status, error: err });
            throw new Error(`Synthesize failed: ${err}`);
        }

        const result = response.json as SynthesizeResponse;
        this.log("Synthesize complete", { tokens: result.token_count });
        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Ollama Models
    // ─────────────────────────────────────────────────────────────────────────

    async getOllamaModels(): Promise<OllamaModelsResponse> {
        this.log("Fetching Ollama models");

        const response = await this.request("/ollama/models");

        if (response.status !== 200) {
            this.logger?.error("Failed to fetch Ollama models", { status: response.status });
            return { models: [], default_model: "llama3.2:latest" };
        }

        const result = response.json as OllamaModelsResponse;
        this.log("Ollama models fetched", { count: result.models.length });
        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Legacy compatibility methods (for sync-manager)
    // ─────────────────────────────────────────────────────────────────────────

    // These are no longer needed since backend handles parsing/embedding,
    // but kept for interface compatibility during migration

    async addDocuments(): Promise<void> {
        throw new Error("Use syncMarkdown() or syncPdf() instead");
    }

    async upsertDocuments(): Promise<void> {
        throw new Error("Use syncMarkdown() or syncPdf() instead");
    }

    async deleteByIds(): Promise<void> {
        throw new Error("Use deleteBySource() instead");
    }
}
