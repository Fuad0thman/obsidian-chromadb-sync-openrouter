// ════════════════════════════════════════════════════════════════════════════
// Sync Manager
// Now uses backend API which handles parsing, chunking, and embeddings
// ════════════════════════════════════════════════════════════════════════════

import { App, TFile } from "obsidian";
import type { ChromaDBSyncSettings } from "./settings";
import { ChromaDBClient } from "./chromadb-client";
import type { DebugLogger } from "./debug-logger";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SyncResult {
    synced:  number;
    skipped: number;
    chunks:  number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Supported file types
// ─────────────────────────────────────────────────────────────────────────────

const MARKDOWN_EXTENSIONS = ["md"];
const PDF_EXTENSIONS      = ["pdf"];
const XLSX_EXTENSIONS     = ["xlsx"];
const CSV_EXTENSIONS      = ["csv"];
const DOCX_EXTENSIONS     = ["docx"];

// ─────────────────────────────────────────────────────────────────────────────
// Folder Tag Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip common prefixes from folder names.
 * Handles patterns like:
 *   - "01_BCM11"    → "BCM11"
 *   - "1.2.3 Docs"  → "Docs"
 *   - "_Archive"    → "Archive"
 *   - "BCM11"       → "BCM11" (no prefix)
 */
function stripFolderPrefix(folderName: string): string {
    // Pattern: digits/dots followed by underscore or space, OR lone underscore
    // ^([\d.]+[_\s]|_) - one or more digits/dots then separator, or just underscore
    return folderName.replace(/^([\d.]+[_\s]|_)/, "").trim();
}

/**
 * Extract auto-derived folder tag from a file path.
 * Uses the immediate parent folder with prefix stripped.
 * Normalized to lowercase for case-insensitive matching.
 */
function getAutoFolderTag(filePath: string): string {
    const parts = filePath.split("/");

    // If file is at root level, no folder tag
    if (parts.length < 2) {
        return "";
    }

    // Get immediate parent folder, strip prefix, normalize to lowercase
    const parentFolder = parts[parts.length - 2];
    return stripFolderPrefix(parentFolder).toLowerCase();
}

/**
 * Format tags array as pipe-delimited string for storage.
 * Format: "|tag1|tag2|tag3|" - pipes on both ends enable exact matching via $contains
 */
function formatFolderTags(tags: string[]): string {
    if (tags.length === 0) {
        return "";
    }
    // Normalize, dedupe, and format with pipe delimiters
    const normalized = [...new Set(tags.map(t => t.toLowerCase().trim()).filter(t => t))];
    return "|" + normalized.join("|") + "|";
}

function isMarkdownFile(path: string): boolean {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    return MARKDOWN_EXTENSIONS.includes(ext);
}

function isPdfFile(path: string): boolean {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    return PDF_EXTENSIONS.includes(ext);
}

function isXlsxFile(path: string): boolean {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    return XLSX_EXTENSIONS.includes(ext);
}

function isCsvFile(path: string): boolean {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    return CSV_EXTENSIONS.includes(ext);
}

function isDocxFile(path: string): boolean {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    return DOCX_EXTENSIONS.includes(ext);
}

function isSupportedFile(path: string): boolean {
    return isMarkdownFile(path) || isPdfFile(path) || isXlsxFile(path) || isCsvFile(path) || isDocxFile(path);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync Manager
// ─────────────────────────────────────────────────────────────────────────────

export class SyncManager {
    private app:          App;
    private settings:     ChromaDBSyncSettings;
    private chromaClient: ChromaDBClient;
    private logger:       DebugLogger | null;
    private dirtyFiles:   Set<string> = new Set();
    private deletedFiles: Set<string> = new Set();
    private cancelRequested: boolean = false;
    private isSyncing:       boolean = false;

    constructor(app: App, settings: ChromaDBSyncSettings, chromaClient: ChromaDBClient, logger?: DebugLogger) {
        this.app          = app;
        this.settings     = settings;
        this.chromaClient = chromaClient;
        this.logger       = logger || null;
        this.log("SyncManager initialized");
    }

    private log(message: string, data?: unknown): void {
        if (this.logger) {
            this.logger.debug(`[SyncManager] ${message}`, data);
        }
    }

    updateSettings(settings: ChromaDBSyncSettings): void {
        this.settings = settings;
        this.log("Settings updated");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Dirty Tracking
    // ─────────────────────────────────────────────────────────────────────────

    markDirty(file: TFile): void {
        if (!isSupportedFile(file.path)) {
            return;
        }
        if (this.shouldExclude(file.path)) {
            this.log("File excluded from dirty tracking", { path: file.path });
            return;
        }
        this.dirtyFiles.add(file.path);
        this.log("File marked dirty", { path: file.path, dirtyCount: this.dirtyFiles.size });
    }

    markDeleted(path: string): void {
        this.dirtyFiles.delete(path);
        this.deletedFiles.add(path);
        this.log("File marked deleted", { path, deletedCount: this.deletedFiles.size });
    }

    getDirtyCount(): number {
        return this.dirtyFiles.size + this.deletedFiles.size;
    }

    clearDirty(): void {
        this.dirtyFiles.clear();
        this.deletedFiles.clear();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sync Control
    // ─────────────────────────────────────────────────────────────────────────

    requestCancel(): void {
        if (this.isSyncing) {
            this.cancelRequested = true;
            this.log("Cancel requested");
        }
    }

    isCurrentlySyncing(): boolean {
        return this.isSyncing;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Inclusion / Exclusion Logic
    // ─────────────────────────────────────────────────────────────────────────

    isFileIncluded(path: string): boolean {
        if (!isSupportedFile(path)) {
            return false;
        }
        return !this.shouldExclude(path);
    }

    getFilesToSync(): string[] {
        const allFiles = this.app.vault.getFiles();
        return allFiles
            .filter((file) => isSupportedFile(file.path) && !this.shouldExclude(file.path))
            .map((file) => file.path)
            .sort();
    }

    private shouldExclude(path: string): boolean {
        // ─────────────────────────────────────────────────────────────────────
        // Explicit file include check (highest priority whitelist)
        // ─────────────────────────────────────────────────────────────────────
        if (this.settings.includeFiles?.includes(path)) {
            return false;  // Explicitly included files are never excluded
        }

        // ─────────────────────────────────────────────────────────────────────
        // Explicit file exclude check (highest priority blacklist)
        // ─────────────────────────────────────────────────────────────────────
        if (this.settings.excludeFiles?.includes(path)) {
            return true;
        }

        // ─────────────────────────────────────────────────────────────────────
        // Include folders check (whitelist)
        // ─────────────────────────────────────────────────────────────────────
        if (this.settings.includeFolders.length > 0) {
            let inIncludedFolder = false;
            for (const folder of this.settings.includeFolders) {
                if (path.startsWith(folder + "/") || path === folder) {
                    inIncludedFolder = true;
                    break;
                }
            }
            if (!inIncludedFolder) {
                return true;
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // Exclude folders check (blacklist)
        // ─────────────────────────────────────────────────────────────────────
        for (const folder of this.settings.excludeFolders) {
            if (path.startsWith(folder + "/") || path === folder) {
                return true;
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // Pattern exclusions
        // ─────────────────────────────────────────────────────────────────────
        for (const pattern of this.settings.excludePatterns) {
            if (this.matchesPattern(path, pattern)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get folder tags for a file, combining auto-derived, folder-level, and file-level tags.
     * Returns pipe-delimited string for storage: "|tag1|tag2|"
     */
    getFolderTags(filePath: string): string {
        // Check for tag override first (highest priority - replaces all auto tags)
        const overrides = this.settings.fileTagOverrides?.[filePath];
        if (overrides && overrides.length > 0) {
            return formatFolderTags(overrides);
        }

        // Start with auto-derived tag from immediate parent folder
        const tags: string[] = [];
        const autoTag = getAutoFolderTag(filePath);
        if (autoTag) {
            tags.push(autoTag);
        }

        // Add tags from ancestor folders (settings.folderTags)
        // Check each ancestor folder from most specific to root
        if (this.settings.folderTags) {
            const parts = filePath.split("/");
            // Build ancestor paths: "a/b/c/file.md" -> ["a/b/c", "a/b", "a"]
            for (let i = parts.length - 2; i >= 0; i--) {
                const folderPath = parts.slice(0, i + 1).join("/");
                const folderTagList = this.settings.folderTags[folderPath];
                if (folderTagList && folderTagList.length > 0) {
                    tags.push(...folderTagList);
                }
            }
        }

        // Add custom file-specific tags
        const customTags = this.settings.fileTags?.[filePath];
        if (customTags) {
            tags.push(...customTags);
        }

        return formatFolderTags(tags);
    }

    private matchesPattern(path: string, pattern: string): boolean {
        const regexPattern = pattern
            .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
            .replace(/\*/g, "[^/]*")
            .replace(/<<<DOUBLESTAR>>>/g, ".*")
            .replace(/\?/g, ".");

        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(path);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sync Operations
    // ─────────────────────────────────────────────────────────────────────────

    async syncFile(file: TFile): Promise<{ chunks: number; skipped: boolean }> {
        this.log("Syncing file", { path: file.path });

        if (isMarkdownFile(file.path)) {
            return await this.syncMarkdownFile(file);
        } else if (isPdfFile(file.path)) {
            return await this.syncPdfFile(file);
        } else if (isXlsxFile(file.path)) {
            return await this.syncXlsxFile(file);
        } else if (isCsvFile(file.path)) {
            return await this.syncCsvFile(file);
        } else if (isDocxFile(file.path)) {
            return await this.syncDocxFile(file);
        }

        this.log("Unsupported file type", { path: file.path });
        return { chunks: 0, skipped: true };
    }

    private async syncMarkdownFile(file: TFile): Promise<{ chunks: number; skipped: boolean }> {
        const content      = await this.app.vault.read(file);
        const folderTags   = this.getFolderTags(file.path);
        const modifiedTime = file.stat.mtime;

        const result = await this.chromaClient.syncMarkdown(
            file.path,
            content,
            this.settings.chunkByHeaders,
            this.settings.maxChunkSize,
            folderTags,
            modifiedTime
        );

        this.log("Markdown synced", { path: file.path, chunks: result.chunks, skipped: result.skipped, folderTags });
        return { chunks: result.chunks, skipped: result.skipped };
    }

    private async syncPdfFile(file: TFile): Promise<{ chunks: number; skipped: boolean }> {
        const data         = await this.app.vault.readBinary(file);
        const folderTags   = this.getFolderTags(file.path);
        const modifiedTime = file.stat.mtime;

        const result = await this.chromaClient.syncPdf(
            file.path,
            data,
            this.settings.pdfChunkSize,
            this.settings.pdfChunkOverlap,
            folderTags,
            modifiedTime
        );

        this.log("PDF synced", { path: file.path, chunks: result.chunks, skipped: result.skipped, folderTags });
        return { chunks: result.chunks, skipped: result.skipped };
    }

    private async syncXlsxFile(file: TFile): Promise<{ chunks: number; skipped: boolean }> {
        const data         = await this.app.vault.readBinary(file);
        const folderTags   = this.getFolderTags(file.path);
        const modifiedTime = file.stat.mtime;

        const result = await this.chromaClient.syncXlsx(
            file.path,
            data,
            this.settings.xlsxRowsPerChunk || 10,
            this.settings.xlsxMaxChunkSize || 2000,
            folderTags,
            modifiedTime
        );

        this.log("XLSX synced", { path: file.path, chunks: result.chunks, skipped: result.skipped, folderTags });
        return { chunks: result.chunks, skipped: result.skipped };
    }

    private async syncCsvFile(file: TFile): Promise<{ chunks: number; skipped: boolean }> {
        const data         = await this.app.vault.readBinary(file);
        const folderTags   = this.getFolderTags(file.path);
        const modifiedTime = file.stat.mtime;

        const result = await this.chromaClient.syncCsv(
            file.path,
            data,
            this.settings.csvRowsPerChunk || 10,
            this.settings.csvMaxChunkSize || 2000,
            folderTags,
            modifiedTime
        );

        this.log("CSV synced", { path: file.path, chunks: result.chunks, skipped: result.skipped, folderTags });
        return { chunks: result.chunks, skipped: result.skipped };
    }

    private async syncDocxFile(file: TFile): Promise<{ chunks: number; skipped: boolean }> {
        const data         = await this.app.vault.readBinary(file);
        const folderTags   = this.getFolderTags(file.path);
        const modifiedTime = file.stat.mtime;

        const result = await this.chromaClient.syncDocx(
            file.path,
            data,
            this.settings.docxChunkSize || 1500,
            this.settings.docxChunkOverlap || 200,
            folderTags,
            modifiedTime
        );

        this.log("DOCX synced", { path: file.path, chunks: result.chunks, skipped: result.skipped, folderTags });
        return { chunks: result.chunks, skipped: result.skipped };
    }

    async syncDirtyFiles(): Promise<number> {
        this.log("Starting dirty file sync", {
            dirtyCount:   this.dirtyFiles.size,
            deletedCount: this.deletedFiles.size,
        });

        let syncedCount = 0;

        // Handle deletions
        for (const path of this.deletedFiles) {
            this.log("Deleting from backend", { path });
            await this.chromaClient.deleteBySource(path);
            syncedCount++;
        }

        // Handle modifications
        for (const path of this.dirtyFiles) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                await this.syncFile(file);
                syncedCount++;
            }
        }

        this.clearDirty();
        this.log("Dirty file sync complete", { syncedCount });
        return syncedCount;
    }

    async syncAllFiles(
        onProgress?: (current: number, total: number, fileName: string, synced: number, skipped: number) => void
    ): Promise<SyncResult> {
        if (this.isSyncing) {
            this.log("Sync already in progress");
            return { synced: 0, skipped: 0, chunks: 0 };
        }

        this.isSyncing = true;
        this.cancelRequested = false;

        const allFiles    = this.app.vault.getFiles();
        const filesToSync = allFiles.filter((file) => this.isFileIncluded(file.path));
        const totalFiles  = filesToSync.length;

        this.log("Starting full sync", {
            totalFiles:  allFiles.length,
            filesToSync: totalFiles,
            excluded:    allFiles.length - totalFiles,
        });

        let processedCount = 0;
        let syncedCount    = 0;
        let skippedCount   = 0;
        let chunksTotal    = 0;
        const batchSize    = this.settings.batchSyncSize || 20;
        const batchDelay   = this.settings.batchSyncDelayMs || 2000;

        try {
            for (let i = 0; i < filesToSync.length; i += batchSize) {
                // Check for cancellation
                if (this.cancelRequested) {
                    this.log("Sync cancelled by user", { syncedCount, skippedCount, totalFiles });
                    break;
                }

                const batch = filesToSync.slice(i, i + batchSize);
                this.log("Processing batch", { batchStart: i, batchSize: batch.length, delay: batchDelay });

                for (const file of batch) {
                    if (this.cancelRequested) break;

                    try {
                        processedCount++;
                        onProgress?.(processedCount, totalFiles, file.name, syncedCount, skippedCount);
                        const result = await this.syncFile(file);
                        chunksTotal += result.chunks;
                        if (result.skipped) {
                            skippedCount++;
                        } else {
                            syncedCount++;
                        }
                    } catch (error) {
                        this.logger?.error(`Failed to sync ${file.path}`, error);
                        // Count as skipped on error
                        skippedCount++;
                    }
                }

                // Throttle delay between batches
                if (i + batchSize < filesToSync.length && !this.cancelRequested) {
                    await this.delay(batchDelay);
                }
            }
        } finally {
            this.isSyncing = false;
            this.cancelRequested = false;
        }

        this.clearDirty();
        this.log("Full sync complete", { syncedCount, skippedCount, chunksTotal, cancelled: this.cancelRequested });
        return { synced: syncedCount, skipped: skippedCount, chunks: chunksTotal };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────────────────────────────

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
