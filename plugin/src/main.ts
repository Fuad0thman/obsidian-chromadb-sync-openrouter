// ════════════════════════════════════════════════════════════════════════════
// ChromaDB Sync - Obsidian Plugin
// ════════════════════════════════════════════════════════════════════════════

import { App, Modal, Plugin, Notice, Setting, TFile, TFolder, Menu } from "obsidian";
import { ChromaDBSyncSettings, DEFAULT_SETTINGS, ChromaDBSyncSettingTab } from "./settings";
import { ChromaDBClient } from "./chromadb-client";
import { SyncManager } from "./sync-manager";
import { DebugLogger } from "./debug-logger";
import { ChromaDBView, VIEW_TYPE_CHROMADB, logActivity } from "./chat-view";

// ─────────────────────────────────────────────────────────────────────────────
// Tag Editor Modal
// ─────────────────────────────────────────────────────────────────────────────

class TagEditorModal extends Modal {
    private filePath:     string;
    private settings:     ChromaDBSyncSettings;
    private onSave:       (fileTags: Record<string, string[]>, fileTagOverrides: Record<string, string[]>) => Promise<void>;
    private currentTags:  string[];
    private isOverride:   boolean;

    constructor(
        app:      App,
        filePath: string,
        settings: ChromaDBSyncSettings,
        onSave:   (fileTags: Record<string, string[]>, fileTagOverrides: Record<string, string[]>) => Promise<void>
    ) {
        super(app);
        this.filePath = filePath;
        this.settings = settings;
        this.onSave   = onSave;

        // Check if file has override tags or additional tags
        const overrideTags = settings.fileTagOverrides?.[filePath] || [];
        const additionalTags = settings.fileTags?.[filePath] || [];

        if (overrideTags.length > 0) {
            this.currentTags = [...overrideTags];
            this.isOverride = true;
        } else {
            this.currentTags = [...additionalTags];
            this.isOverride = false;
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("chromadb-tag-modal");

        contentEl.createEl("h2", { text: "Manage ChromaDB Tags" });
        contentEl.createEl("p", {
            text: this.filePath,
            cls:  "chromadb-tag-modal-path",
        });

        // ─────────────────────────────────────────────────────────────────────
        // Mode toggle
        // ─────────────────────────────────────────────────────────────────────
        new Setting(contentEl)
            .setName("Override auto-derived tags")
            .setDesc("When enabled, these tags replace the auto-derived folder tag entirely")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.isOverride)
                    .onChange((value) => {
                        this.isOverride = value;
                    })
            );

        // ─────────────────────────────────────────────────────────────────────
        // Tag input
        // ─────────────────────────────────────────────────────────────────────
        const tagInputSetting = new Setting(contentEl)
            .setName("Tags")
            .setDesc("Enter tags separated by commas");

        const tagInput = tagInputSetting.controlEl.createEl("input", {
            type:  "text",
            value: this.currentTags.join(", "),
            cls:   "chromadb-tag-input",
        });
        tagInput.style.width = "100%";

        // ─────────────────────────────────────────────────────────────────────
        // Buttons
        // ─────────────────────────────────────────────────────────────────────
        const buttonRow = contentEl.createEl("div", { cls: "chromadb-tag-modal-buttons" });

        const saveBtn = buttonRow.createEl("button", { text: "Save", cls: "mod-cta" });
        const clearBtn = buttonRow.createEl("button", { text: "Clear Tags" });
        const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });

        saveBtn.addEventListener("click", async () => {
            const tags = tagInput.value
                .split(",")
                .map((t) => t.trim().toLowerCase())
                .filter((t) => t.length > 0);

            await this.saveTags(tags);
            this.close();
        });

        clearBtn.addEventListener("click", async () => {
            await this.saveTags([]);
            this.close();
        });

        cancelBtn.addEventListener("click", () => {
            this.close();
        });

        // Focus input
        tagInput.focus();

        // Add styles
        this.addStyles();
    }

    private async saveTags(tags: string[]): Promise<void> {
        const fileTags = { ...this.settings.fileTags };
        const fileTagOverrides = { ...this.settings.fileTagOverrides };

        // Clear both first
        delete fileTags[this.filePath];
        delete fileTagOverrides[this.filePath];

        // Set in appropriate place based on mode
        if (tags.length > 0) {
            if (this.isOverride) {
                fileTagOverrides[this.filePath] = tags;
            } else {
                fileTags[this.filePath] = tags;
            }
        }

        await this.onSave(fileTags, fileTagOverrides);
    }

    private addStyles(): void {
        if (document.getElementById("chromadb-tag-modal-styles")) {
            return;
        }

        const style = document.createElement("style");
        style.id = "chromadb-tag-modal-styles";
        style.textContent = `
            .chromadb-tag-modal {
                padding: 20px;
            }

            .chromadb-tag-modal-path {
                font-family: var(--font-monospace);
                font-size: 12px;
                color: var(--text-muted);
                margin-bottom: 16px;
                word-break: break-all;
            }

            .chromadb-tag-input {
                padding: 8px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                font-size: 14px;
            }

            .chromadb-tag-modal-buttons {
                display: flex;
                gap: 8px;
                justify-content: flex-end;
                margin-top: 20px;
            }

            .chromadb-tag-modal-buttons button {
                padding: 8px 16px;
            }
        `;
        document.head.appendChild(style);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Folder Tag Editor Modal
// ─────────────────────────────────────────────────────────────────────────────

class FolderTagEditorModal extends Modal {
    private folderPath:   string;
    private settings:     ChromaDBSyncSettings;
    private onSave:       (folderTags: Record<string, string[]>) => Promise<void>;
    private currentTags:  string[];

    constructor(
        app:        App,
        folderPath: string,
        settings:   ChromaDBSyncSettings,
        onSave:     (folderTags: Record<string, string[]>) => Promise<void>
    ) {
        super(app);
        this.folderPath   = folderPath;
        this.settings     = settings;
        this.onSave       = onSave;
        this.currentTags  = [...(settings.folderTags?.[folderPath] || [])];
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("chromadb-tag-modal");

        contentEl.createEl("h2", { text: "Manage Folder Tags" });
        contentEl.createEl("p", {
            text: this.folderPath,
            cls:  "chromadb-tag-modal-path",
        });
        contentEl.createEl("p", {
            text: "Tags added here will be applied to all files in this folder (and subfolders).",
            cls:  "setting-item-description",
        });

        // ─────────────────────────────────────────────────────────────────────
        // Tag input
        // ─────────────────────────────────────────────────────────────────────
        const tagInputSetting = new Setting(contentEl)
            .setName("Tags")
            .setDesc("Enter tags separated by commas");

        const tagInput = tagInputSetting.controlEl.createEl("input", {
            type:  "text",
            value: this.currentTags.join(", "),
            cls:   "chromadb-tag-input",
        });
        tagInput.style.width = "100%";

        // ─────────────────────────────────────────────────────────────────────
        // Buttons
        // ─────────────────────────────────────────────────────────────────────
        const buttonRow = contentEl.createEl("div", { cls: "chromadb-tag-modal-buttons" });

        const saveBtn   = buttonRow.createEl("button", { text: "Save", cls: "mod-cta" });
        const clearBtn  = buttonRow.createEl("button", { text: "Clear Tags" });
        const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });

        saveBtn.addEventListener("click", async () => {
            const tags = tagInput.value
                .split(",")
                .map((t) => t.trim().toLowerCase())
                .filter((t) => t.length > 0);

            await this.saveTags(tags);
            this.close();
        });

        clearBtn.addEventListener("click", async () => {
            await this.saveTags([]);
            this.close();
        });

        cancelBtn.addEventListener("click", () => {
            this.close();
        });

        // Focus input
        tagInput.focus();
    }

    private async saveTags(tags: string[]): Promise<void> {
        const folderTags = { ...this.settings.folderTags };

        if (tags.length > 0) {
            folderTags[this.folderPath] = tags;
        } else {
            delete folderTags[this.folderPath];
        }

        await this.onSave(folderTags);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Result Modal
// ─────────────────────────────────────────────────────────────────────────────

class AIResultModal extends Modal {
    private title:   string;
    private content: string;
    private sources: any[];

    constructor(app: App, title: string, content: string, sources: any[] = []) {
        super(app);
        this.title   = title;
        this.content = content;
        this.sources = sources;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("chromadb-ai-result-modal");

        contentEl.createEl("h2", { text: this.title });

        const contentDiv = contentEl.createEl("div", { cls: "chromadb-ai-content" });
        contentDiv.style.whiteSpace = "pre-wrap";
        contentDiv.style.lineHeight = "1.6";
        contentDiv.style.maxHeight = "400px";
        contentDiv.style.overflowY = "auto";
        contentDiv.style.padding = "12px";
        contentDiv.style.background = "var(--background-secondary)";
        contentDiv.style.borderRadius = "6px";
        contentDiv.style.marginBottom = "16px";
        contentDiv.textContent = this.content;

        if (this.sources && this.sources.length > 0) {
            const sourcesDiv = contentEl.createEl("div", { cls: "chromadb-ai-sources" });
            sourcesDiv.createEl("h4", { text: "Sources" });

            for (const src of this.sources) {
                const srcEl = sourcesDiv.createEl("div", { cls: "chromadb-source-item" });
                srcEl.style.padding = "6px 10px";
                srcEl.style.marginBottom = "4px";
                srcEl.style.background = "var(--background-secondary)";
                srcEl.style.borderRadius = "4px";
                srcEl.style.cursor = "pointer";
                srcEl.textContent = src.filename || src.source;

                srcEl.addEventListener("click", async () => {
                    const file = this.app.vault.getAbstractFileByPath(src.source);
                    if (file instanceof TFile) {
                        await this.app.workspace.getLeaf().openFile(file);
                        this.close();
                    }
                });
            }
        }

        const closeBtn = contentEl.createEl("button", { text: "Close", cls: "mod-cta" });
        closeBtn.style.marginTop = "12px";
        closeBtn.addEventListener("click", () => this.close());
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Related Notes Modal
// ─────────────────────────────────────────────────────────────────────────────

class RelatedNotesModal extends Modal {
    private sourceNote: string;
    private results:    any[];

    constructor(app: App, sourceNote: string, results: any[]) {
        super(app);
        this.sourceNote = sourceNote;
        this.results    = results;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("chromadb-related-modal");

        contentEl.createEl("h2", { text: `Related to: ${this.sourceNote}` });

        const listEl = contentEl.createEl("div", { cls: "chromadb-related-list" });
        listEl.style.maxHeight = "400px";
        listEl.style.overflowY = "auto";

        for (const result of this.results) {
            const source   = result.metadata?.source || "Unknown";
            const filename = source.split("/").pop()?.replace(/\.[^/.]+$/, "") || source;
            const preview  = result.document?.slice(0, 150) || "";
            const score    = (1 - result.distance).toFixed(3);

            const itemEl = listEl.createEl("div", { cls: "chromadb-related-item" });
            itemEl.style.padding = "10px 12px";
            itemEl.style.marginBottom = "6px";
            itemEl.style.background = "var(--background-secondary)";
            itemEl.style.borderRadius = "6px";
            itemEl.style.cursor = "pointer";

            const headerEl = itemEl.createEl("div", { cls: "chromadb-related-header" });
            headerEl.style.display = "flex";
            headerEl.style.justifyContent = "space-between";
            headerEl.style.marginBottom = "4px";

            headerEl.createEl("span", { text: filename, cls: "chromadb-related-name" });
            const scoreEl = headerEl.createEl("span", { text: score, cls: "chromadb-related-score" });
            scoreEl.style.color = "var(--text-muted)";
            scoreEl.style.fontSize = "0.85em";

            const previewEl = itemEl.createEl("div", { cls: "chromadb-related-preview" });
            previewEl.style.fontSize = "0.85em";
            previewEl.style.color = "var(--text-muted)";
            previewEl.style.overflow = "hidden";
            previewEl.style.textOverflow = "ellipsis";
            previewEl.style.whiteSpace = "nowrap";
            previewEl.textContent = preview + (preview.length >= 150 ? "..." : "");

            itemEl.addEventListener("click", async () => {
                const file = this.app.vault.getAbstractFileByPath(source);
                if (file instanceof TFile) {
                    await this.app.workspace.getLeaf().openFile(file);
                    this.close();
                } else {
                    new Notice(`File not found: ${source}`);
                }
            });

            itemEl.addEventListener("mouseenter", () => {
                itemEl.style.background = "var(--background-modifier-hover)";
            });
            itemEl.addEventListener("mouseleave", () => {
                itemEl.style.background = "var(--background-secondary)";
            });
        }

        const closeBtn = contentEl.createEl("button", { text: "Close", cls: "mod-cta" });
        closeBtn.style.marginTop = "12px";
        closeBtn.addEventListener("click", () => this.close());
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Plugin
// ─────────────────────────────────────────────────────────────────────────────

export default class ChromaDBSyncPlugin extends Plugin {
    settings:       ChromaDBSyncSettings;
    syncManager:    SyncManager;
    chromaClient:   ChromaDBClient;
    logger:         DebugLogger;
    syncInterval:   number | null = null;
    statusBarItem:  HTMLElement | null = null;

    async onload() {
        // Initialize logger first so we can log everything
        this.logger = new DebugLogger(this);

        await this.loadSettings();

        // Enable logger based on settings
        this.logger.setEnabled(this.settings.debugEnabled);
        this.logger.info("Plugin loading", {
            version:    this.manifest.version,
            vaultName:  this.app.vault.getName(),
        });

        // Initialize with resolved collection name
        const resolvedSettings = this.getResolvedSettings();
        this.logger.debug("Resolved settings", {
            collectionName: resolvedSettings.collectionName,
            chromaDbUrl:    resolvedSettings.chromaDbUrl,
            syncEnabled:    resolvedSettings.syncEnabled,
        });

        this.chromaClient = new ChromaDBClient(resolvedSettings, this.logger);
        this.syncManager  = new SyncManager(this.app, this.settings, this.chromaClient, this.logger);

        // ─────────────────────────────────────────────────────────────────────
        // Status bar
        // ─────────────────────────────────────────────────────────────────────
        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.addClass("chromadb-status-bar");
        this.setupStatusBarHandlers();
        this.updateStatusBar();

        // ─────────────────────────────────────────────────────────────────────
        // Register sidebar view
        // ─────────────────────────────────────────────────────────────────────
        this.registerView(
            VIEW_TYPE_CHROMADB,
            (leaf) => new ChromaDBView(leaf, this)
        );

        // ─────────────────────────────────────────────────────────────────────
        // Ribbon icons
        // ─────────────────────────────────────────────────────────────────────
        this.addRibbonIcon("brain", "ChromaDB Assistant", () => {
            this.toggleView();
        });

        this.addRibbonIcon("database", "Sync to ChromaDB", async () => {
            await this.runManualSync();
        });

        // ─────────────────────────────────────────────────────────────────────
        // Commands
        // ─────────────────────────────────────────────────────────────────────
        this.addCommand({
            id:   "sync-vault-to-chromadb",
            name: "Sync included folders to ChromaDB (full sync)",
            callback: async () => {
                await this.runFullSync();
            },
        });

        this.addCommand({
            id:   "sync-current-file-to-chromadb",
            name: "Sync current file to ChromaDB",
            callback: async () => {
                if (!this.settings.syncEnabled) {
                    new Notice("Sync is disabled. Enable it in settings first.");
                    return;
                }
                const file = this.app.workspace.getActiveFile();
                if (file && file.extension === "md") {
                    if (!this.syncManager.isFileIncluded(file.path)) {
                        new Notice(`File not in included folders: ${file.path}`);
                        return;
                    }
                    await this.syncManager.syncFile(file);
                    new Notice(`Synced: ${file.basename}`);
                } else {
                    new Notice("No markdown file active");
                }
            },
        });

        this.addCommand({
            id:   "sync-modified-to-chromadb",
            name: "Sync modified files to ChromaDB",
            callback: async () => {
                await this.runManualSync();
            },
        });

        this.addCommand({
            id:   "preview-sync",
            name: "Preview sync (dry run)",
            callback: async () => {
                await this.runDryRun();
            },
        });

        this.addCommand({
            id:   "chromadb-delete-collection",
            name: "Delete ChromaDB collection (destructive)",
            callback: async () => {
                const confirmed = await this.confirmDelete();
                if (confirmed) {
                    await this.chromaClient.deleteCollection();
                    new Notice(`Deleted collection: ${this.getCollectionName()}`);
                }
            },
        });

        this.addCommand({
            id:   "search-chromadb",
            name: "Search vault (semantic)",
            callback: async () => {
                new SearchModal(this.app, this).open();
            },
        });

        this.addCommand({
            id:   "stop-sync",
            name: "Stop current sync",
            callback: () => {
                if (this.syncManager.isCurrentlySyncing()) {
                    this.syncManager.requestCancel();
                    new Notice("Stopping sync...");
                } else {
                    new Notice("No sync in progress");
                }
            },
        });

        this.addCommand({
            id:   "toggle-chromadb-panel",
            name: "Toggle ChromaDB panel",
            callback: () => {
                this.toggleView();
            },
        });

        // ─────────────────────────────────────────────────────────────────────
        // Settings tab
        // ─────────────────────────────────────────────────────────────────────
        this.addSettingTab(new ChromaDBSyncSettingTab(this.app, this));

        // ─────────────────────────────────────────────────────────────────────
        // File event listeners - track dirty files (only if sync enabled)
        // ─────────────────────────────────────────────────────────────────────
        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (!this.settings.syncEnabled) return;
                if (file instanceof TFile && this.isSupportedFile(file)) {
                    this.syncManager.markDirty(file);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                if (!this.settings.syncEnabled) return;
                if (file instanceof TFile && this.isSupportedFile(file)) {
                    this.syncManager.markDeleted(file.path);
                    logActivity("delete", `Queued delete: ${file.name}`);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                if (!this.settings.syncEnabled) return;
                if (file instanceof TFile && this.isSupportedFile(file)) {
                    this.syncManager.markDeleted(oldPath);
                    this.syncManager.markDirty(file);
                    const oldName = oldPath.split("/").pop() || oldPath;
                    logActivity("info", `File moved: ${oldName} → ${file.name}`);
                }
            })
        );

        // ─────────────────────────────────────────────────────────────────────
        // File explorer context menu
        // ─────────────────────────────────────────────────────────────────────
        this.registerEvent(
            this.app.workspace.on("file-menu", (menu: Menu, file) => {
                if (file instanceof TFolder) {
                    const folderPath = file.path;
                    const isExplicitlyIncluded = this.settings.includeFolders.includes(folderPath);
                    const isExplicitlyExcluded = this.settings.excludeFolders.includes(folderPath);
                    const whitelistMode        = this.settings.includeFolders.length > 0;

                    // Check if folder is within sync scope (would be synced if not excluded)
                    const isInSyncScope = whitelistMode
                        ? this.settings.includeFolders.some((f) => folderPath.startsWith(f + "/") || folderPath === f)
                        : true;

                    // Check if we'll add any items
                    const hasItems = isExplicitlyIncluded ||
                        (whitelistMode && !isExplicitlyIncluded && !isExplicitlyExcluded) ||
                        isExplicitlyExcluded ||
                        (!isExplicitlyExcluded && !isExplicitlyIncluded);

                    if (hasItems) menu.addSeparator();

                    // ─────────────────────────────────────────────────────────
                    // "Remove from sync" - only if explicitly in includeFolders
                    // ─────────────────────────────────────────────────────────
                    if (isExplicitlyIncluded) {
                        menu.addItem((item) => {
                            item.setTitle("Remove from ChromaDB sync")
                                .setIcon("folder-minus")
                                .onClick(async () => {
                                    this.settings.includeFolders = this.settings.includeFolders.filter(
                                        (f) => f !== folderPath
                                    );
                                    await this.saveSettings();
                                    new Notice(`Removed from sync: ${folderPath}`);

                                    const shouldPurge = await this.confirmFolderPurge(folderPath);
                                    if (shouldPurge) {
                                        try {
                                            const deleted = await this.chromaClient.deleteByFolder(folderPath);
                                            new Notice(`Purged ${deleted} file(s) from database`);
                                        } catch (e) {
                                            new Notice(`Failed to purge: ${e.message}`);
                                        }
                                    }
                                });
                        });
                    }

                    // ─────────────────────────────────────────────────────────
                    // "Add to sync" - only in whitelist mode, not already included, not excluded
                    // ─────────────────────────────────────────────────────────
                    if (whitelistMode && !isExplicitlyIncluded && !isExplicitlyExcluded) {
                        menu.addItem((item) => {
                            item.setTitle("Add to ChromaDB sync")
                                .setIcon("folder-plus")
                                .onClick(async () => {
                                    this.settings.includeFolders.push(folderPath);
                                    await this.saveSettings();
                                    new Notice(`Added to sync: ${folderPath}`);
                                });
                        });
                    }

                    // ─────────────────────────────────────────────────────────
                    // "Remove from exclusions" - only if explicitly excluded
                    // ─────────────────────────────────────────────────────────
                    if (isExplicitlyExcluded) {
                        menu.addItem((item) => {
                            item.setTitle("Remove from ChromaDB exclusions")
                                .setIcon("folder-check")
                                .onClick(async () => {
                                    this.settings.excludeFolders = this.settings.excludeFolders.filter(
                                        (f) => f !== folderPath
                                    );
                                    await this.saveSettings();
                                    new Notice(`Removed from exclusions: ${folderPath}`);
                                });
                        });
                    }

                    // ─────────────────────────────────────────────────────────
                    // "Exclude from sync" - available for any folder not already excluded/included
                    // (allows preemptive blacklisting even if folder isn't currently in sync scope)
                    // ─────────────────────────────────────────────────────────
                    if (!isExplicitlyExcluded && !isExplicitlyIncluded) {
                        menu.addItem((item) => {
                            item.setTitle("Exclude from ChromaDB sync")
                                .setIcon("folder-x")
                                .onClick(async () => {
                                    this.settings.excludeFolders.push(folderPath);
                                    await this.saveSettings();
                                    new Notice(`Excluded from sync: ${folderPath}`);
                                });
                        });
                    }

                    // ─────────────────────────────────────────────────────────
                    // "Manage tags" - for any folder
                    // ─────────────────────────────────────────────────────────
                    const hasFolderTags = (this.settings.folderTags?.[folderPath]?.length || 0) > 0;

                    menu.addItem((item) => {
                        item.setTitle(hasFolderTags ? "Edit ChromaDB tags..." : "Add ChromaDB tags...")
                            .setIcon("tag")
                            .onClick(() => {
                                new FolderTagEditorModal(
                                    this.app,
                                    folderPath,
                                    this.settings,
                                    async (folderTags) => {
                                        this.settings.folderTags = folderTags;
                                        await this.saveSettings();
                                        new Notice("Folder tags updated");
                                    }
                                ).open();
                            });
                    });

                    if (hasItems) menu.addSeparator();
                } else if (file instanceof TFile) {
                    // Only show options for supported file types
                    if (!this.isSupportedFile(file)) return;

                    const filePath = file.path;
                    const fileName = file.name;

                    // Check if file is in sync scope
                    const fileInSyncScope = this.syncManager.isFileIncluded(filePath);

                    // Check if file is explicitly excluded by pattern
                    const isExcludedByPattern = this.settings.excludePatterns.some((p) =>
                        filePath.includes(p) || fileName === p
                    );

                    // Always show ChromaDB section for supported files
                    menu.addSeparator();

                    // ─────────────────────────────────────────────────────────
                    // "Remove from exclusions" - only if excluded by pattern
                    // ─────────────────────────────────────────────────────────
                    if (isExcludedByPattern) {
                        menu.addItem((item) => {
                            item.setTitle("Remove from ChromaDB exclusions")
                                .setIcon("file-check")
                                .onClick(async () => {
                                    this.settings.excludePatterns = this.settings.excludePatterns.filter(
                                        (p) => !filePath.includes(p) && fileName !== p
                                    );
                                    await this.saveSettings();
                                    new Notice(`Removed from exclusions: ${fileName}`);
                                });
                        });
                    }

                    // ─────────────────────────────────────────────────────────
                    // "Exclude from sync" - only if file would be synced and not already excluded
                    // ─────────────────────────────────────────────────────────
                    if (fileInSyncScope && !isExcludedByPattern) {
                        menu.addItem((item) => {
                            item.setTitle("Exclude from ChromaDB sync")
                                .setIcon("file-x")
                                .onClick(async () => {
                                    this.settings.excludePatterns.push(fileName);
                                    await this.saveSettings();
                                    new Notice(`Excluded from sync: ${fileName}`);
                                });
                        });
                    }

                    // ─────────────────────────────────────────────────────────
                    // "Manage tags" - for any supported file
                    // ─────────────────────────────────────────────────────────
                    const hasTags = (this.settings.fileTags?.[file.path]?.length > 0) ||
                                   (this.settings.fileTagOverrides?.[file.path]?.length > 0);

                    menu.addItem((item) => {
                        item.setTitle(hasTags ? "Edit ChromaDB tags..." : "Add ChromaDB tags...")
                            .setIcon("tag")
                            .onClick(() => {
                                new TagEditorModal(
                                    this.app,
                                    file.path,
                                    this.settings,
                                    async (fileTags, fileTagOverrides) => {
                                        this.settings.fileTags = fileTags;
                                        this.settings.fileTagOverrides = fileTagOverrides;
                                        await this.saveSettings();
                                        new Notice("Tags updated");
                                    }
                                ).open();
                            });
                    });

                    // ─────────────────────────────────────────────────────────
                    // AI Actions
                    // ─────────────────────────────────────────────────────────
                    menu.addItem((item) => {
                        item.setTitle("Summarize with AI")
                            .setIcon("file-text")
                            .onClick(async () => {
                                await this.aiSummarizeFile(file);
                            });
                    });

                    menu.addItem((item) => {
                        item.setTitle("Find related notes")
                            .setIcon("git-branch")
                            .onClick(async () => {
                                await this.aiFindRelated(file);
                            });
                    });

                    menu.addItem((item) => {
                        item.setTitle("Ask about this note...")
                            .setIcon("message-circle")
                            .onClick(async () => {
                                await this.aiAskAboutFile(file);
                            });
                    });

                    menu.addSeparator();
                }
            })
        );

        // ─────────────────────────────────────────────────────────────────────
        // Editor context menu (for selected text)
        // ─────────────────────────────────────────────────────────────────────
        this.registerEvent(
            this.app.workspace.on("editor-menu", (menu: Menu, editor, view) => {
                const selection = editor.getSelection();
                if (!selection || selection.trim().length === 0) return;

                menu.addSeparator();

                menu.addItem((item) => {
                    item.setTitle("Explain with AI")
                        .setIcon("help-circle")
                        .onClick(async () => {
                            await this.aiExplainText(selection);
                        });
                });

                menu.addItem((item) => {
                    item.setTitle("Summarize with AI")
                        .setIcon("file-text")
                        .onClick(async () => {
                            await this.aiSummarizeText(selection);
                        });
                });

                menu.addItem((item) => {
                    item.setTitle("Ask about selection...")
                        .setIcon("message-circle")
                        .onClick(async () => {
                            await this.aiAskAboutText(selection);
                        });
                });

                menu.addSeparator();
            })
        );

        // ─────────────────────────────────────────────────────────────────────
        // Start periodic sync if enabled
        // ─────────────────────────────────────────────────────────────────────
        this.startPeriodicSync();

        this.logger.info("Plugin loaded successfully");
    }

    async onunload() {
        this.stopPeriodicSync();
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHROMADB);
        this.logger.info("Plugin unloading");
        await this.logger.onunload();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View Toggle
    // ─────────────────────────────────────────────────────────────────────────

    async toggleView(): Promise<void> {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHROMADB);

        if (leaves.length > 0) {
            // View exists - close it
            this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHROMADB);
        } else {
            // View doesn't exist - create it in right sidebar
            const leaf = this.app.workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({
                    type:   VIEW_TYPE_CHROMADB,
                    active: true,
                });
                this.app.workspace.revealLeaf(leaf);
            }
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        // Update clients with resolved settings
        const resolvedSettings = this.getResolvedSettings();
        this.chromaClient.updateSettings(resolvedSettings);
        this.syncManager.updateSettings(this.settings);
        // Restart periodic sync with new interval
        this.startPeriodicSync();
        this.updateStatusBar();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Settings Resolution
    // ─────────────────────────────────────────────────────────────────────────

    getVaultName(): string {
        return this.app.vault.getName();
    }

    getCollectionName(): string {
        return this.settings.collectionName || this.sanitizeCollectionName(this.getVaultName());
    }

    private sanitizeCollectionName(name: string): string {
        // ChromaDB collection names: alphanumeric, underscores, hyphens
        return name.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    }

    private getResolvedSettings(): ChromaDBSyncSettings {
        return {
            ...this.settings,
            collectionName: this.getCollectionName(),
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Status Bar
    // ─────────────────────────────────────────────────────────────────────────

    private setupStatusBarHandlers(): void {
        if (!this.statusBarItem) return;

        // Left-click: open panel (if enabled)
        this.statusBarItem.addEventListener("click", (e) => {
            if (this.settings.statusBarClickOpensPanel) {
                this.toggleView();
            }
        });

        // Right-click: context menu
        this.statusBarItem.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            this.showStatusBarMenu(e);
        });

        // Cursor style
        this.statusBarItem.style.cursor = "pointer";
    }

    private showStatusBarMenu(e: MouseEvent): void {
        const menu = new Menu();

        if (this.syncManager.isCurrentlySyncing()) {
            menu.addItem((item) => {
                item.setTitle("Stop sync")
                    .setIcon("square")
                    .onClick(() => {
                        this.syncManager.requestCancel();
                        new Notice("Stopping sync...");
                    });
            });
        } else {
            menu.addItem((item) => {
                item.setTitle("Sync modified files")
                    .setIcon("refresh-cw")
                    .onClick(async () => {
                        await this.runManualSync();
                    });
            });

            menu.addItem((item) => {
                item.setTitle("Full sync")
                    .setIcon("hard-drive-upload")
                    .onClick(async () => {
                        await this.runFullSync();
                    });
            });
        }

        menu.addSeparator();

        menu.addItem((item) => {
            item.setTitle("Open ChromaDB panel")
                .setIcon("panel-right")
                .onClick(() => {
                    this.toggleView();
                });
        });

        menu.addItem((item) => {
            item.setTitle("Settings")
                .setIcon("settings")
                .onClick(() => {
                    // Open plugin settings
                    (this.app as any).setting.open();
                    (this.app as any).setting.openTabById("chromadb-sync");
                });
        });

        menu.showAtMouseEvent(e);
    }

    updateStatusBar(): void {
        if (!this.statusBarItem) return;

        if (!this.settings.syncEnabled) {
            this.statusBarItem.setText("⏸ ChromaDB");
            this.statusBarItem.setAttribute("aria-label", "ChromaDB sync is disabled. Right-click for options.");
        } else if (this.syncManager.isCurrentlySyncing()) {
            this.statusBarItem.setText("⟳ Syncing...");
            this.statusBarItem.setAttribute("aria-label", "Sync in progress. Right-click to stop.");
        } else {
            const dirtyCount = this.syncManager.getDirtyCount();
            if (dirtyCount > 0) {
                this.statusBarItem.setText(`● ${dirtyCount} pending`);
                this.statusBarItem.setAttribute("aria-label", `${dirtyCount} files waiting to sync. Right-click for options.`);
            } else {
                this.statusBarItem.setText("✓ ChromaDB");
                this.statusBarItem.setAttribute("aria-label", "ChromaDB sync idle. Right-click for options.");
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sync operations
    // ─────────────────────────────────────────────────────────────────────────

    async runManualSync(): Promise<void> {
        if (!this.settings.syncEnabled) {
            new Notice("Sync is disabled. Enable it in settings first.");
            return;
        }

        const count = this.syncManager.getDirtyCount();
        if (count === 0) {
            new Notice("No modified files to sync");
            return;
        }

        new Notice(`Syncing ${count} modified file(s)...`);
        logActivity("info", `Syncing ${count} modified file(s)...`);
        this.updateStatusBar();

        try {
            const synced = await this.syncManager.syncDirtyFiles();
            new Notice(`Synced ${synced} file(s) to ChromaDB`);
            logActivity("sync", `Synced ${synced} modified file(s)`);
            this.updateStatusBar();
        } catch (error) {
            new Notice(`Sync failed: ${error.message}`);
            logActivity("error", `Sync failed: ${error.message}`);
            console.error("ChromaDB sync error:", error);
        }
    }

    async runFullSync(): Promise<void> {
        if (!this.settings.syncEnabled) {
            new Notice("Sync is disabled. Enable it in settings first.");
            return;
        }

        const preview = this.syncManager.getFilesToSync();
        if (preview.length === 0) {
            new Notice("No files match your include/exclude settings");
            return;
        }

        new Notice(`Checking ${preview.length} files...`);
        logActivity("info", `Full sync started: ${preview.length} files`);
        try {
            const result = await this.syncManager.syncAllFiles((current, total, fileName, synced, skipped) => {
                if (this.statusBarItem) {
                    this.statusBarItem.setText(`Syncing ${current}/${total}: ${fileName} (${synced} new)`);
                }
            });

            // Build result message
            const parts: string[] = [];
            if (result.synced > 0) {
                parts.push(`${result.synced} synced`);
            }
            if (result.skipped > 0) {
                parts.push(`${result.skipped} unchanged`);
            }
            const message = parts.length > 0
                ? `Sync complete: ${parts.join(", ")}`
                : "Sync complete: no changes";
            new Notice(message);
            logActivity("sync", message);
            this.updateStatusBar();
        } catch (error) {
            new Notice(`Sync failed: ${error.message}`);
            logActivity("error", `Full sync failed: ${error.message}`);
            console.error("ChromaDB sync error:", error);
            this.updateStatusBar();
        }
    }

    async runDryRun(): Promise<void> {
        const preview = this.syncManager.getFilesToSync();

        if (preview.length === 0) {
            new Notice("No files would be synced with current settings");
            return;
        }

        // Show preview modal
        const modal = new DryRunModal(this.app, preview, this.settings, this.getCollectionName());
        modal.open();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AI Context Actions
    // ─────────────────────────────────────────────────────────────────────────

    async aiSummarizeFile(file: TFile): Promise<void> {
        new Notice(`Summarizing ${file.basename}...`);

        try {
            const content = await this.app.vault.cachedRead(file);
            const model = this.settings.ollamaModel || undefined;

            const result = await this.chromaClient.synthesize(
                `Please provide a concise summary of the following document:\n\n${content.slice(0, 6000)}`,
                3,
                model
            );

            // Show result in a modal
            new AIResultModal(
                this.app,
                `Summary: ${file.basename}`,
                result.answer,
                result.sources
            ).open();

        } catch (error) {
            new Notice(`Error: ${error.message}`);
        }
    }

    async aiFindRelated(file: TFile): Promise<void> {
        new Notice(`Finding notes related to ${file.basename}...`);

        try {
            // Use the file content to find similar documents
            const content = await this.app.vault.cachedRead(file);
            const searchQuery = content.slice(0, 1000); // Use first 1000 chars as query

            const results = await this.chromaClient.query(searchQuery, 10);

            // Filter out the source file itself
            const related = results.filter((r: any) => r.metadata?.source !== file.path);

            if (related.length === 0) {
                new Notice("No related notes found");
                return;
            }

            // Show results in a modal
            new RelatedNotesModal(this.app, file.basename, related).open();

        } catch (error) {
            new Notice(`Error: ${error.message}`);
        }
    }

    async aiAskAboutFile(file: TFile): Promise<void> {
        // Open the sidebar and switch to chat tab with this file as context
        await this.toggleView();

        // Give the view time to render
        setTimeout(() => {
            const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHROMADB);
            if (leaves.length > 0) {
                const view = leaves[0].view as any;
                if (view && typeof view.setContextFile === "function") {
                    view.setContextFile(file);
                }
            }
        }, 100);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AI Text Actions (for selected text)
    // ─────────────────────────────────────────────────────────────────────────

    async aiExplainText(text: string): Promise<void> {
        new Notice("Explaining...");

        try {
            const model = this.settings.ollamaModel || undefined;
            const result = await this.chromaClient.synthesize(
                `Please explain the following text in clear, simple terms:\n\n"${text.slice(0, 3000)}"`,
                3,
                model
            );

            new AIResultModal(this.app, "Explanation", result.answer, result.sources).open();
        } catch (error) {
            new Notice(`Error: ${error.message}`);
        }
    }

    async aiSummarizeText(text: string): Promise<void> {
        new Notice("Summarizing...");

        try {
            const model = this.settings.ollamaModel || undefined;
            const result = await this.chromaClient.synthesize(
                `Please provide a concise summary of the following text:\n\n"${text.slice(0, 4000)}"`,
                3,
                model
            );

            new AIResultModal(this.app, "Summary", result.answer, result.sources).open();
        } catch (error) {
            new Notice(`Error: ${error.message}`);
        }
    }

    async aiAskAboutText(text: string): Promise<void> {
        // Open sidebar and pre-fill with the selected text
        await this.toggleView();

        setTimeout(() => {
            const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHROMADB);
            if (leaves.length > 0) {
                const view = leaves[0].view as any;
                if (view && typeof view.setContextText === "function") {
                    view.setContextText(text);
                }
            }
        }, 100);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Periodic sync
    // ─────────────────────────────────────────────────────────────────────────

    startPeriodicSync(): void {
        this.stopPeriodicSync();

        // Don't start if sync disabled or periodic disabled
        if (!this.settings.syncEnabled || !this.settings.enablePeriodicSync) {
            return;
        }

        if (this.settings.syncIntervalMinutes <= 0) {
            return;
        }

        const intervalMs = this.settings.syncIntervalMinutes * 60 * 1000;
        this.syncInterval = window.setInterval(async () => {
            if (this.settings.syncEnabled && this.syncManager.getDirtyCount() > 0) {
                console.log("ChromaDB: Running periodic sync...");
                await this.syncManager.syncDirtyFiles();
                this.updateStatusBar();
            }
        }, intervalMs);

        this.registerInterval(this.syncInterval);
    }

    stopPeriodicSync(): void {
        if (this.syncInterval !== null) {
            window.clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────────────────────────────

    async confirmDelete(): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new ConfirmModal(this.app, resolve);
            modal.open();
        });
    }

    async confirmFolderPurge(folderPath: string): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new FolderPurgeModal(this.app, folderPath, resolve);
            modal.open();
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // File Type Helpers
    // ─────────────────────────────────────────────────────────────────────────

    private isSupportedFile(file: TFile): boolean {
        const ext = file.extension.toLowerCase();
        return ext === "md" || ext === "pdf";
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Confirmation Modal
// ════════════════════════════════════════════════════════════════════════════

class ConfirmModal extends Modal {
    result: (value: boolean) => void;

    constructor(app: App, onResult: (value: boolean) => void) {
        super(app);
        this.result = onResult;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Delete ChromaDB Collection?" });
        contentEl.createEl("p", {
            text: "This will permanently delete all synced data. You'll need to run a full sync to restore it.",
        });

        new Setting(contentEl)
            .addButton((btn) =>
                btn.setButtonText("Cancel").onClick(() => {
                    this.result(false);
                    this.close();
                })
            )
            .addButton((btn) =>
                btn
                    .setButtonText("Delete")
                    .setWarning()
                    .onClick(() => {
                        this.result(true);
                        this.close();
                    })
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Folder Purge Modal
// ════════════════════════════════════════════════════════════════════════════

class FolderPurgeModal extends Modal {
    folderPath: string;
    result:     (value: boolean) => void;

    constructor(app: App, folderPath: string, onResult: (value: boolean) => void) {
        super(app);
        this.folderPath = folderPath;
        this.result     = onResult;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Purge folder from database?" });
        contentEl.createEl("p", {
            text: `The folder "${this.folderPath}" was removed from sync. Would you like to also delete its data from the ChromaDB database?`,
        });
        contentEl.createEl("p", {
            text: "If you don't purge now, the data will remain searchable until you sync a different folder or purge the entire collection.",
            cls:  "mod-muted",
        });

        new Setting(contentEl)
            .addButton((btn) =>
                btn.setButtonText("Keep Data").onClick(() => {
                    this.result(false);
                    this.close();
                })
            )
            .addButton((btn) =>
                btn
                    .setButtonText("Purge Data")
                    .setWarning()
                    .onClick(() => {
                        this.result(true);
                        this.close();
                    })
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Dry Run Preview Modal
// ════════════════════════════════════════════════════════════════════════════

class DryRunModal extends Modal {
    files:          string[];
    settings:       ChromaDBSyncSettings;
    collectionName: string;

    constructor(app: App, files: string[], settings: ChromaDBSyncSettings, collectionName: string) {
        super(app);
        this.files          = files;
        this.settings       = settings;
        this.collectionName = collectionName;
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.createEl("h2", { text: "Sync Preview (Dry Run)" });

        // Summary
        const summary = contentEl.createEl("div", { cls: "chromadb-preview-summary" });
        summary.createEl("p", { text: `Collection: ${this.collectionName}` });
        summary.createEl("p", { text: `Files to sync: ${this.files.length}` });

        if (this.settings.includeFolders.length > 0) {
            summary.createEl("p", {
                text: `Include folders: ${this.settings.includeFolders.join(", ")}`,
            });
        } else {
            summary.createEl("p", { text: "Include folders: (entire vault)" });
        }

        if (this.settings.excludeFolders.length > 0) {
            summary.createEl("p", {
                text: `Exclude folders: ${this.settings.excludeFolders.join(", ")}`,
            });
        }

        // File list (scrollable)
        contentEl.createEl("h3", { text: "Files:" });
        const fileList = contentEl.createEl("div", {
            cls: "chromadb-file-list",
            attr: { style: "max-height: 300px; overflow-y: auto; font-size: 0.85em; font-family: monospace;" },
        });

        for (const file of this.files.slice(0, 100)) {
            fileList.createEl("div", { text: file });
        }

        if (this.files.length > 100) {
            fileList.createEl("div", {
                text: `... and ${this.files.length - 100} more`,
                attr: { style: "font-style: italic; color: var(--text-muted);" },
            });
        }

        // Close button
        new Setting(contentEl)
            .addButton((btn) =>
                btn.setButtonText("Close").onClick(() => {
                    this.close();
                })
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Search Modal
// ════════════════════════════════════════════════════════════════════════════

class SearchModal extends Modal {
    plugin:          ChromaDBSyncPlugin;
    resultsEl:       HTMLElement;
    searchInput:     HTMLInputElement;
    synthesizeMode:  boolean = false;

    constructor(app: App, plugin: ChromaDBSyncPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass("chromadb-search-modal");

        contentEl.createEl("h2", { text: "Search Vault (Semantic)" });

        // ─────────────────────────────────────────────────────────────────────
        // Search Input
        // ─────────────────────────────────────────────────────────────────────
        const searchContainer = contentEl.createEl("div", { cls: "chromadb-search-container" });

        this.searchInput = searchContainer.createEl("input", {
            type:        "text",
            placeholder: "Enter search query...",
            cls:         "chromadb-search-input",
        });
        this.searchInput.style.width = "100%";
        this.searchInput.style.padding = "8px";
        this.searchInput.style.marginBottom = "12px";

        this.searchInput.addEventListener("keydown", async (e) => {
            if (e.key === "Enter") {
                await this.performSearch();
            }
        });

        // ─────────────────────────────────────────────────────────────────────
        // Controls Row: Synthesize toggle + Search button
        // ─────────────────────────────────────────────────────────────────────
        new Setting(contentEl)
            .setName("Use AI synthesis")
            .setDesc("Generate an answer using Ollama LLM")
            .addToggle((toggle) =>
                toggle.setValue(this.synthesizeMode).onChange((value) => {
                    this.synthesizeMode = value;
                })
            )
            .addButton((btn) =>
                btn.setButtonText("Search").onClick(async () => {
                    await this.performSearch();
                })
            );

        // ─────────────────────────────────────────────────────────────────────
        // Results Container
        // ─────────────────────────────────────────────────────────────────────
        this.resultsEl = contentEl.createEl("div", { cls: "chromadb-results" });
        this.resultsEl.style.maxHeight = "400px";
        this.resultsEl.style.overflowY = "auto";

        // Focus on input
        this.searchInput.focus();
    }

    async performSearch() {
        const query = this.searchInput.value.trim();
        if (!query) {
            return;
        }

        this.resultsEl.empty();

        if (this.synthesizeMode) {
            await this.performSynthesizedSearch(query);
        } else {
            await this.performRawSearch(query);
        }
    }

    async performSynthesizedSearch(query: string) {
        this.resultsEl.createEl("div", {
            text: "Generating answer with AI...",
            cls:  "chromadb-loading",
        });

        try {
            const model = this.plugin.settings.ollamaModel || undefined;
            const result = await this.plugin.chromaClient.synthesize(query, 5, model);
            this.resultsEl.empty();

            // ─────────────────────────────────────────────────────────────────
            // Answer section
            // ─────────────────────────────────────────────────────────────────
            const answerContainer = this.resultsEl.createEl("div", { cls: "chromadb-answer-container" });
            answerContainer.style.padding = "12px";
            answerContainer.style.marginBottom = "12px";
            answerContainer.style.borderRadius = "6px";
            answerContainer.style.backgroundColor = "var(--background-secondary)";
            answerContainer.style.border = "1px solid var(--background-modifier-border)";

            const answerHeader = answerContainer.createEl("div", { cls: "chromadb-answer-header" });
            answerHeader.style.fontWeight = "bold";
            answerHeader.style.marginBottom = "8px";
            answerHeader.style.color = "var(--text-accent)";
            answerHeader.setText(`AI Answer (${result.model})`);

            const answerText = answerContainer.createEl("div", { cls: "chromadb-answer-text" });
            answerText.style.whiteSpace = "pre-wrap";
            answerText.style.lineHeight = "1.5";
            answerText.setText(result.answer);

            if (result.token_count) {
                const tokenInfo = answerContainer.createEl("div", { cls: "chromadb-token-info" });
                tokenInfo.style.marginTop = "8px";
                tokenInfo.style.fontSize = "0.8em";
                tokenInfo.style.color = "var(--text-muted)";
                tokenInfo.setText(`Tokens: ${result.token_count}`);
            }

            // ─────────────────────────────────────────────────────────────────
            // Sources section
            // ─────────────────────────────────────────────────────────────────
            if (result.sources.length > 0) {
                const sourcesHeader = this.resultsEl.createEl("div", { cls: "chromadb-sources-header" });
                sourcesHeader.style.fontWeight = "bold";
                sourcesHeader.style.marginBottom = "8px";
                sourcesHeader.setText("Sources:");

                for (const source of result.sources) {
                    const sourceEl = this.resultsEl.createEl("div", { cls: "chromadb-source-item" });
                    sourceEl.style.padding = "6px 8px";
                    sourceEl.style.marginBottom = "4px";
                    sourceEl.style.borderRadius = "4px";
                    sourceEl.style.backgroundColor = "var(--background-secondary)";
                    sourceEl.style.cursor = "pointer";
                    sourceEl.style.display = "flex";
                    sourceEl.style.justifyContent = "space-between";

                    const nameEl = sourceEl.createEl("span");
                    nameEl.setText(source.filename);

                    const scoreEl = sourceEl.createEl("span");
                    scoreEl.style.color = "var(--text-muted)";
                    scoreEl.style.fontSize = "0.85em";
                    scoreEl.setText(`${(1 - source.distance).toFixed(3)}`);

                    // Click to open file
                    sourceEl.addEventListener("click", async () => {
                        const file = this.app.vault.getAbstractFileByPath(source.source);
                        if (file instanceof TFile) {
                            await this.app.workspace.getLeaf().openFile(file);
                            this.close();
                        } else {
                            new Notice(`File not found: ${source.source}`);
                        }
                    });

                    sourceEl.addEventListener("mouseenter", () => {
                        sourceEl.style.backgroundColor = "var(--background-modifier-hover)";
                    });
                    sourceEl.addEventListener("mouseleave", () => {
                        sourceEl.style.backgroundColor = "var(--background-secondary)";
                    });
                }
            }
        } catch (error) {
            this.resultsEl.empty();
            this.resultsEl.createEl("div", {
                text: `Synthesis failed: ${error.message}`,
                cls:  "chromadb-error",
                attr: { style: "color: var(--text-error);" },
            });
        }
    }

    async performRawSearch(query: string) {
        this.resultsEl.createEl("div", { text: "Searching...", cls: "chromadb-loading" });

        try {
            const results = await this.plugin.chromaClient.query(query, 10);
            this.resultsEl.empty();

            if (results.length === 0) {
                this.resultsEl.createEl("div", {
                    text: "No results found",
                    cls:  "chromadb-no-results",
                });
                return;
            }

            for (const result of results) {
                const resultEl = this.resultsEl.createEl("div", { cls: "chromadb-result-item" });
                resultEl.style.padding = "8px";
                resultEl.style.marginBottom = "8px";
                resultEl.style.borderRadius = "4px";
                resultEl.style.backgroundColor = "var(--background-secondary)";
                resultEl.style.cursor = "pointer";

                // Source file path
                const source = (result.metadata?.source as string) || "Unknown source";
                const sourceEl = resultEl.createEl("div", {
                    text: source,
                    cls:  "chromadb-result-source",
                });
                sourceEl.style.fontWeight = "bold";
                sourceEl.style.marginBottom = "4px";

                // Distance score
                const scoreEl = resultEl.createEl("div", {
                    text: `Relevance: ${(1 - result.distance).toFixed(3)}`,
                    cls:  "chromadb-result-score",
                });
                scoreEl.style.fontSize = "0.8em";
                scoreEl.style.color = "var(--text-muted)";

                // Content preview
                const preview = result.document.substring(0, 200) + (result.document.length > 200 ? "..." : "");
                const previewEl = resultEl.createEl("div", {
                    text: preview,
                    cls:  "chromadb-result-preview",
                });
                previewEl.style.fontSize = "0.9em";
                previewEl.style.marginTop = "4px";

                // Click to open file
                resultEl.addEventListener("click", async () => {
                    const file = this.app.vault.getAbstractFileByPath(source);
                    if (file instanceof TFile) {
                        await this.app.workspace.getLeaf().openFile(file);
                        this.close();
                    } else {
                        new Notice(`File not found: ${source}`);
                    }
                });

                // Hover effect
                resultEl.addEventListener("mouseenter", () => {
                    resultEl.style.backgroundColor = "var(--background-modifier-hover)";
                });
                resultEl.addEventListener("mouseleave", () => {
                    resultEl.style.backgroundColor = "var(--background-secondary)";
                });
            }
        } catch (error) {
            this.resultsEl.empty();
            this.resultsEl.createEl("div", {
                text:  `Search failed: ${error.message}`,
                cls:   "chromadb-error",
                attr:  { style: "color: var(--text-error);" },
            });
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
