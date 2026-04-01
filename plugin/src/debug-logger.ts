// ════════════════════════════════════════════════════════════════════════════
// Debug Logger
// ════════════════════════════════════════════════════════════════════════════

import { Plugin } from "obsidian";

export class DebugLogger {
    private plugin:    Plugin;
    private enabled:   boolean = false;
    private logBuffer: string[] = [];
    private logFile:   string = "chromadb-sync-debug.log";

    constructor(plugin: Plugin) {
        this.plugin = plugin;
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (enabled) {
            this.log("DEBUG", "Debug logging enabled");
        }
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Logging Methods
    // ─────────────────────────────────────────────────────────────────────────

    log(category: string, message: string, data?: unknown): void {
        if (!this.enabled) return;

        const timestamp = new Date().toISOString();
        let logLine = `[${timestamp}] [${category}] ${message}`;

        if (data !== undefined) {
            try {
                logLine += ` | ${JSON.stringify(data, null, 2)}`;
            } catch {
                logLine += ` | [unserializable data]`;
            }
        }

        this.logBuffer.push(logLine);
        console.log(`[ChromaDB] ${logLine}`);

        // Flush to file periodically
        if (this.logBuffer.length >= 10) {
            this.flush();
        }
    }

    info(message: string, data?: unknown): void {
        this.log("INFO", message, data);
    }

    warn(message: string, data?: unknown): void {
        this.log("WARN", message, data);
        console.warn(`[ChromaDB] ${message}`, data);
    }

    error(message: string, error?: unknown): void {
        const errorData = error instanceof Error
            ? { message: error.message, stack: error.stack }
            : error;
        this.log("ERROR", message, errorData);
        console.error(`[ChromaDB] ${message}`, error);
        // Always flush on error
        this.flush();
    }

    debug(message: string, data?: unknown): void {
        this.log("DEBUG", message, data);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // File Operations
    // ─────────────────────────────────────────────────────────────────────────

    async flush(): Promise<void> {
        if (this.logBuffer.length === 0) return;

        try {
            const pluginDir = this.getPluginDir();
            const logPath   = `${pluginDir}/${this.logFile}`;

            // Read existing log content
            let existingContent = "";
            try {
                const adapter = this.plugin.app.vault.adapter;
                existingContent = await adapter.read(logPath);
            } catch {
                // File doesn't exist yet, that's fine
            }

            // Append new logs
            const newContent = existingContent + this.logBuffer.join("\n") + "\n";

            // Write back
            const adapter = this.plugin.app.vault.adapter;
            await adapter.write(logPath, newContent);

            this.logBuffer = [];
        } catch (e) {
            console.error("[ChromaDB] Failed to write debug log:", e);
        }
    }

    async clear(): Promise<void> {
        try {
            const pluginDir = this.getPluginDir();
            const logPath   = `${pluginDir}/${this.logFile}`;
            const adapter   = this.plugin.app.vault.adapter;

            await adapter.write(logPath, `[${new Date().toISOString()}] Log cleared\n`);
            this.logBuffer = [];
        } catch (e) {
            console.error("[ChromaDB] Failed to clear debug log:", e);
        }
    }

    private getPluginDir(): string {
        // Obsidian adapter uses paths relative to vault root
        return `.obsidian/plugins/chromadb-sync`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    async onunload(): Promise<void> {
        if (this.enabled) {
            this.log("DEBUG", "Plugin unloading, flushing logs");
            await this.flush();
        }
    }
}
