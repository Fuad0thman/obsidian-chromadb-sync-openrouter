// ════════════════════════════════════════════════════════════════════════════
// Settings
// ════════════════════════════════════════════════════════════════════════════

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ChromaDBSyncPlugin from "./main";
import { FolderListSetting, FileListSetting } from "./folder-suggest";

// ─────────────────────────────────────────────────────────────────────────────
// Settings Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface ChromaDBSyncSettings {
    syncEnabled:           boolean;
    debugEnabled:          boolean;
    chromaDbUrl:           string;
    collectionName:        string;
    ollamaModel:           string;
    enablePeriodicSync:    boolean;
    syncIntervalMinutes:   number;
    chunkByHeaders:        boolean;
    maxChunkSize:          number;
    includeFolders:        string[];
    excludeFolders:        string[];
    excludePatterns:       string[];
    includeFiles:          string[];
    excludeFiles:          string[];
    folderTags:            Record<string, string[]>;  // Tags applied to all files in folder
    fileTags:              Record<string, string[]>;
    fileTagOverrides:      Record<string, string[]>;
    includeFrontmatter:    boolean;
    includeWikilinks:      boolean;
    includeTags:           boolean;
    batchSyncSize:         number;
    batchSyncDelayMs:      number;
    pdfChunkSize:          number;
    pdfChunkOverlap:       number;
    xlsxRowsPerChunk:      number;
    xlsxMaxChunkSize:      number;
    csvRowsPerChunk:       number;
    csvMaxChunkSize:       number;
    docxChunkSize:         number;
    docxChunkOverlap:      number;
    statusBarClickOpensPanel: boolean;
}

export const DEFAULT_SETTINGS: ChromaDBSyncSettings = {
    syncEnabled:           false,
    debugEnabled:          true,
    chromaDbUrl:           "http://localhost:8002",
    collectionName:        "",
    ollamaModel:           "",
    enablePeriodicSync:    false,
    syncIntervalMinutes:   15,
    chunkByHeaders:        true,
    maxChunkSize:          2000,
    includeFolders:        [],
    excludeFolders:        [".obsidian", ".trash"],
    excludePatterns:       [],
    includeFiles:          [],
    excludeFiles:          [],
    folderTags:            {},
    fileTags:              {},
    fileTagOverrides:      {},
    includeFrontmatter:    true,
    includeWikilinks:      true,
    includeTags:           true,
    batchSyncSize:         20,
    batchSyncDelayMs:      2000,
    pdfChunkSize:          1000,
    pdfChunkOverlap:       200,
    xlsxRowsPerChunk:      10,
    xlsxMaxChunkSize:      2000,
    csvRowsPerChunk:       10,
    csvMaxChunkSize:       2000,
    docxChunkSize:         1500,
    docxChunkOverlap:      200,
    statusBarClickOpensPanel: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Collapsible Section Helper
// ─────────────────────────────────────────────────────────────────────────────

interface CollapsibleSection {
    headerEl:  HTMLElement;
    contentEl: HTMLElement;
    toggle:    (collapsed?: boolean) => void;
    isCollapsed: () => boolean;
}

function createCollapsibleSection(
    containerEl: HTMLElement,
    title:       string,
    startCollapsed: boolean = false
): CollapsibleSection {
    const sectionEl = containerEl.createEl("div", { cls: "chromadb-section" });

    // Header with toggle
    const headerEl = sectionEl.createEl("div", { cls: "chromadb-section-header" });
    const chevron = headerEl.createEl("span", { cls: "chromadb-section-chevron", text: "▼" });
    headerEl.createEl("span", { cls: "chromadb-section-title", text: title });

    // Content container
    const contentEl = sectionEl.createEl("div", { cls: "chromadb-section-content" });

    let collapsed = startCollapsed;

    const toggle = (forceState?: boolean) => {
        collapsed = forceState !== undefined ? forceState : !collapsed;
        if (collapsed) {
            contentEl.addClass("collapsed");
            chevron.textContent = "▶";
        } else {
            contentEl.removeClass("collapsed");
            chevron.textContent = "▼";
        }
    };

    // Initial state
    if (startCollapsed) {
        toggle(true);
    }

    // Click to toggle
    headerEl.addEventListener("click", () => toggle());

    return {
        headerEl,
        contentEl,
        toggle,
        isCollapsed: () => collapsed,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings Tab
// ─────────────────────────────────────────────────────────────────────────────

export class ChromaDBSyncSettingTab extends PluginSettingTab {
    plugin:   ChromaDBSyncPlugin;
    sections: CollapsibleSection[] = [];

    constructor(app: App, plugin: ChromaDBSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        this.sections = [];

        this.addStyles();

        // ═════════════════════════════════════════════════════════════════════
        // Header with expand/collapse all
        // ═════════════════════════════════════════════════════════════════════

        const headerRow = containerEl.createEl("div", { cls: "chromadb-settings-header" });
        headerRow.createEl("h2", { text: "ChromaDB Sync Settings" });

        const toggleAllRow = headerRow.createEl("div", { cls: "chromadb-toggle-all" });
        const expandAllBtn = toggleAllRow.createEl("button", { text: "Expand All", cls: "chromadb-toggle-btn" });
        const collapseAllBtn = toggleAllRow.createEl("button", { text: "Collapse All", cls: "chromadb-toggle-btn" });

        expandAllBtn.addEventListener("click", () => {
            this.sections.forEach(s => s.toggle(false));
        });

        collapseAllBtn.addEventListener("click", () => {
            this.sections.forEach(s => s.toggle(true));
        });

        // ═════════════════════════════════════════════════════════════════════
        // Master Control (always visible)
        // ═════════════════════════════════════════════════════════════════════

        const masterSection = containerEl.createEl("div", { cls: "chromadb-master-control" });

        const syncEnabledSetting = new Setting(masterSection)
            .setName("Enable sync")
            .setDesc("Master switch - sync is completely disabled when off")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.syncEnabled)
                    .onChange(async (value) => {
                        this.plugin.settings.syncEnabled = value;
                        await this.plugin.saveSettings();
                        this.plugin.updateStatusBar();
                        this.display(); // Refresh to update warning
                    })
            );

        if (!this.plugin.settings.syncEnabled) {
            syncEnabledSetting.descEl.createEl("strong", {
                text: " (Currently disabled - no syncing will occur)",
                cls:  "mod-warning",
            });
        }

        // ═════════════════════════════════════════════════════════════════════
        // Connection & Sync (right after enable - first thing to configure)
        // ═════════════════════════════════════════════════════════════════════

        const connectionSection = createCollapsibleSection(containerEl, "Connection & Sync");
        this.sections.push(connectionSection);

        new Setting(connectionSection.contentEl)
            .setName("Backend URL")
            .setDesc("URL of the obsidian-sync backend API")
            .addText((text) =>
                text
                    .setPlaceholder("http://localhost:8002")
                    .setValue(this.plugin.settings.chromaDbUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.chromaDbUrl = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(connectionSection.contentEl)
            .setName("Collection name")
            .setDesc("ChromaDB collection name. Leave empty to use vault name.")
            .addText((text) =>
                text
                    .setPlaceholder(this.plugin.getVaultName())
                    .setValue(this.plugin.settings.collectionName)
                    .onChange(async (value) => {
                        this.plugin.settings.collectionName = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(connectionSection.contentEl)
            .setName("Ollama model")
            .setDesc("Model for AI synthesis. Leave empty for backend default.")
            .addDropdown((dropdown) => {
                dropdown.addOption("", "(Backend default)");
                dropdown.setValue(this.plugin.settings.ollamaModel);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.ollamaModel = value;
                    await this.plugin.saveSettings();
                });

                this.plugin.chromaClient.getOllamaModels().then((result) => {
                    for (const model of result.models) {
                        dropdown.addOption(model.name, model.name);
                    }
                    dropdown.setValue(this.plugin.settings.ollamaModel);
                }).catch(() => {});
            });

        // Sync timing header
        connectionSection.contentEl.createEl("h4", { text: "Automatic Sync" });

        new Setting(connectionSection.contentEl)
            .setName("Enable periodic sync")
            .setDesc("Automatically sync modified files at regular intervals")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enablePeriodicSync)
                    .onChange(async (value) => {
                        this.plugin.settings.enablePeriodicSync = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(connectionSection.contentEl)
            .setName("Sync interval (minutes)")
            .setDesc("How often to sync modified files")
            .addSlider((slider) =>
                slider
                    .setLimits(1, 60, 1)
                    .setValue(this.plugin.settings.syncIntervalMinutes)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.syncIntervalMinutes = value;
                        await this.plugin.saveSettings();
                    })
            );

        // Batch settings header
        connectionSection.contentEl.createEl("h4", { text: "Performance" });

        new Setting(connectionSection.contentEl)
            .setName("Batch size")
            .setDesc("Files per batch (lower = gentler on system)")
            .addSlider((slider) =>
                slider
                    .setLimits(5, 50, 5)
                    .setValue(this.plugin.settings.batchSyncSize)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.batchSyncSize = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(connectionSection.contentEl)
            .setName("Batch delay (seconds)")
            .setDesc("Pause between batches during full sync")
            .addSlider((slider) =>
                slider
                    .setLimits(0, 10, 1)
                    .setValue(Math.round(this.plugin.settings.batchSyncDelayMs / 1000))
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.batchSyncDelayMs = value * 1000;
                        await this.plugin.saveSettings();
                    })
            );

        // Status bar header
        connectionSection.contentEl.createEl("h4", { text: "Status Bar" });

        new Setting(connectionSection.contentEl)
            .setName("Click to open panel")
            .setDesc("Left-click the status bar to open ChromaDB panel. Right-click always shows menu.")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.statusBarClickOpensPanel)
                    .onChange(async (value) => {
                        this.plugin.settings.statusBarClickOpensPanel = value;
                        await this.plugin.saveSettings();
                    })
            );

        // ═════════════════════════════════════════════════════════════════════
        // Content Selection (folders + files)
        // ═════════════════════════════════════════════════════════════════════

        const contentSection = createCollapsibleSection(containerEl, "Content Selection");
        this.sections.push(contentSection);

        contentSection.contentEl.createEl("p", {
            text: "Control which files are synced to ChromaDB.",
            cls:  "setting-item-description",
        });

        // Folder include
        const includeFoldersSetting = new Setting(contentSection.contentEl)
            .setName("Include folders")
            .setDesc("Only sync files in these folders. Leave empty to sync entire vault.");

        const includeFoldersContainer = includeFoldersSetting.settingEl.createEl("div", {
            cls: "setting-item-control-full",
        });

        new FolderListSetting({
            app:         this.app,
            containerEl: includeFoldersContainer,
            folders:     this.plugin.settings.includeFolders,
            placeholder: "Type folder path...",
            onChange:    async (folders) => {
                this.plugin.settings.includeFolders = folders;
                await this.plugin.saveSettings();
            },
        });

        // Folder exclude
        const excludeFoldersSetting = new Setting(contentSection.contentEl)
            .setName("Exclude folders")
            .setDesc("Folders to exclude from sync.");

        const excludeFoldersContainer = excludeFoldersSetting.settingEl.createEl("div", {
            cls: "setting-item-control-full",
        });

        new FolderListSetting({
            app:         this.app,
            containerEl: excludeFoldersContainer,
            folders:     this.plugin.settings.excludeFolders,
            placeholder: "Type folder path...",
            onChange:    async (folders) => {
                this.plugin.settings.excludeFolders = folders;
                await this.plugin.saveSettings();
            },
        });

        // Pattern exclude
        new Setting(contentSection.contentEl)
            .setName("Exclude patterns")
            .setDesc("File patterns to exclude (comma-separated, e.g., **/daily/*.md)")
            .addText((text) =>
                text
                    .setPlaceholder("**/templates/*.md")
                    .setValue(this.plugin.settings.excludePatterns.join(", "))
                    .onChange(async (value) => {
                        this.plugin.settings.excludePatterns = value
                            .split(",")
                            .map((s) => s.trim())
                            .filter((s) => s.length > 0);
                        await this.plugin.saveSettings();
                    })
            );

        // File-level filtering header
        contentSection.contentEl.createEl("h4", { text: "File-Level Overrides" });
        contentSection.contentEl.createEl("p", {
            text: "Explicit file lists take precedence over folder rules.",
            cls:  "setting-item-description",
        });

        // File include
        const includeFilesSetting = new Setting(contentSection.contentEl)
            .setName("Always include files")
            .setDesc("Files to always sync, regardless of folder rules.");

        const includeFilesContainer = includeFilesSetting.settingEl.createEl("div", {
            cls: "setting-item-control-full",
        });

        new FileListSetting({
            app:         this.app,
            containerEl: includeFilesContainer,
            files:       this.plugin.settings.includeFiles || [],
            placeholder: "Type file path...",
            onChange:    async (files) => {
                this.plugin.settings.includeFiles = files;
                await this.plugin.saveSettings();
            },
        });

        // File exclude
        const excludeFilesSetting = new Setting(contentSection.contentEl)
            .setName("Always exclude files")
            .setDesc("Files to never sync, regardless of folder rules.");

        const excludeFilesContainer = excludeFilesSetting.settingEl.createEl("div", {
            cls: "setting-item-control-full",
        });

        new FileListSetting({
            app:         this.app,
            containerEl: excludeFilesContainer,
            files:       this.plugin.settings.excludeFiles || [],
            placeholder: "Type file path...",
            onChange:    async (files) => {
                this.plugin.settings.excludeFiles = files;
                await this.plugin.saveSettings();
            },
        });

        // ═════════════════════════════════════════════════════════════════════
        // Tagging
        // ═════════════════════════════════════════════════════════════════════

        const taggingSection = createCollapsibleSection(containerEl, "Tagging", true);
        this.sections.push(taggingSection);

        taggingSection.contentEl.createEl("p", {
            text: "Customize tags for filtering queries. Tags are auto-derived from parent folder names.",
            cls:  "setting-item-description",
        });

        new Setting(taggingSection.contentEl)
            .setName("Folder tags")
            .setDesc("Tags applied to all files in a folder (and subfolders). Format: folder: tag1, tag2")
            .addTextArea((text) =>
                text
                    .setPlaceholder("Projects: work, active\nArchive: archived")
                    .setValue(this.formatFileTags(this.plugin.settings.folderTags))
                    .onChange(async (value) => {
                        this.plugin.settings.folderTags = this.parseFileTags(value);
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(taggingSection.contentEl)
            .setName("Additional file tags")
            .setDesc("Add extra tags to specific files. Format: path: tag1, tag2 (one per line)")
            .addTextArea((text) =>
                text
                    .setPlaceholder("docs/important.md: priority, reference\nmanuals/bcm.pdf: bcm, hardware")
                    .setValue(this.formatFileTags(this.plugin.settings.fileTags))
                    .onChange(async (value) => {
                        this.plugin.settings.fileTags = this.parseFileTags(value);
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(taggingSection.contentEl)
            .setName("Tag overrides")
            .setDesc("Replace auto-derived tags entirely. Format: path: tag1, tag2 (one per line)")
            .addTextArea((text) =>
                text
                    .setPlaceholder("special/doc.md: custom-only")
                    .setValue(this.formatFileTags(this.plugin.settings.fileTagOverrides))
                    .onChange(async (value) => {
                        this.plugin.settings.fileTagOverrides = this.parseFileTags(value);
                        await this.plugin.saveSettings();
                    })
            );

        // ═════════════════════════════════════════════════════════════════════
        // Document Processing
        // ═════════════════════════════════════════════════════════════════════

        const processingSection = createCollapsibleSection(containerEl, "Document Processing", true);
        this.sections.push(processingSection);

        // Markdown chunking
        processingSection.contentEl.createEl("h4", { text: "Markdown" });

        new Setting(processingSection.contentEl)
            .setName("Chunk by headers")
            .setDesc("Split documents at markdown headers (recommended)")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.chunkByHeaders)
                    .onChange(async (value) => {
                        this.plugin.settings.chunkByHeaders = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(processingSection.contentEl)
            .setName("Max chunk size")
            .setDesc("Maximum characters per chunk")
            .addText((text) =>
                text
                    .setPlaceholder("2000")
                    .setValue(String(this.plugin.settings.maxChunkSize))
                    .onChange(async (value) => {
                        const num = parseInt(value);
                        if (!isNaN(num) && num > 0) {
                            this.plugin.settings.maxChunkSize = num;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        // PDF chunking
        processingSection.contentEl.createEl("h4", { text: "PDF" });

        new Setting(processingSection.contentEl)
            .setName("PDF chunk size")
            .setDesc("Characters per chunk for PDF files")
            .addText((text) =>
                text
                    .setPlaceholder("1000")
                    .setValue(String(this.plugin.settings.pdfChunkSize))
                    .onChange(async (value) => {
                        const num = parseInt(value);
                        if (!isNaN(num) && num > 0) {
                            this.plugin.settings.pdfChunkSize = num;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        new Setting(processingSection.contentEl)
            .setName("PDF chunk overlap")
            .setDesc("Character overlap between chunks")
            .addText((text) =>
                text
                    .setPlaceholder("200")
                    .setValue(String(this.plugin.settings.pdfChunkOverlap))
                    .onChange(async (value) => {
                        const num = parseInt(value);
                        if (!isNaN(num) && num >= 0) {
                            this.plugin.settings.pdfChunkOverlap = num;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        // XLSX chunking
        processingSection.contentEl.createEl("h4", { text: "XLSX (Excel)" });

        new Setting(processingSection.contentEl)
            .setName("Rows per chunk")
            .setDesc("Number of spreadsheet rows per chunk (default: 10)")
            .addText((text) =>
                text
                    .setPlaceholder("10")
                    .setValue(String(this.plugin.settings.xlsxRowsPerChunk))
                    .onChange(async (value) => {
                        const num = parseInt(value);
                        if (!isNaN(num) && num > 0) {
                            this.plugin.settings.xlsxRowsPerChunk = num;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        new Setting(processingSection.contentEl)
            .setName("Max chunk size")
            .setDesc("Maximum characters per XLSX chunk")
            .addText((text) =>
                text
                    .setPlaceholder("2000")
                    .setValue(String(this.plugin.settings.xlsxMaxChunkSize))
                    .onChange(async (value) => {
                        const num = parseInt(value);
                        if (!isNaN(num) && num > 0) {
                            this.plugin.settings.xlsxMaxChunkSize = num;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        // CSV chunking
        processingSection.contentEl.createEl("h4", { text: "CSV" });

        new Setting(processingSection.contentEl)
            .setName("Rows per chunk")
            .setDesc("Number of CSV rows per chunk (default: 10)")
            .addText((text) =>
                text
                    .setPlaceholder("10")
                    .setValue(String(this.plugin.settings.csvRowsPerChunk))
                    .onChange(async (value) => {
                        const num = parseInt(value);
                        if (!isNaN(num) && num > 0) {
                            this.plugin.settings.csvRowsPerChunk = num;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        new Setting(processingSection.contentEl)
            .setName("Max chunk size")
            .setDesc("Maximum characters per CSV chunk")
            .addText((text) =>
                text
                    .setPlaceholder("2000")
                    .setValue(String(this.plugin.settings.csvMaxChunkSize))
                    .onChange(async (value) => {
                        const num = parseInt(value);
                        if (!isNaN(num) && num > 0) {
                            this.plugin.settings.csvMaxChunkSize = num;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        // DOCX chunking
        processingSection.contentEl.createEl("h4", { text: "DOCX (Word)" });

        new Setting(processingSection.contentEl)
            .setName("Chunk size")
            .setDesc("Characters per chunk for DOCX files (default: 1500)")
            .addText((text) =>
                text
                    .setPlaceholder("1500")
                    .setValue(String(this.plugin.settings.docxChunkSize))
                    .onChange(async (value) => {
                        const num = parseInt(value);
                        if (!isNaN(num) && num > 0) {
                            this.plugin.settings.docxChunkSize = num;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        new Setting(processingSection.contentEl)
            .setName("Chunk overlap")
            .setDesc("Character overlap between DOCX chunks")
            .addText((text) =>
                text
                    .setPlaceholder("200")
                    .setValue(String(this.plugin.settings.docxChunkOverlap))
                    .onChange(async (value) => {
                        const num = parseInt(value);
                        if (!isNaN(num) && num >= 0) {
                            this.plugin.settings.docxChunkOverlap = num;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        // Metadata extraction
        processingSection.contentEl.createEl("h4", { text: "Metadata Extraction" });

        new Setting(processingSection.contentEl)
            .setName("Include frontmatter")
            .setDesc("Extract YAML frontmatter as searchable metadata")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.includeFrontmatter)
                    .onChange(async (value) => {
                        this.plugin.settings.includeFrontmatter = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(processingSection.contentEl)
            .setName("Include wikilinks")
            .setDesc("Extract [[wikilinks]] for graph queries")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.includeWikilinks)
                    .onChange(async (value) => {
                        this.plugin.settings.includeWikilinks = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(processingSection.contentEl)
            .setName("Include tags")
            .setDesc("Extract #tags as searchable metadata")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.includeTags)
                    .onChange(async (value) => {
                        this.plugin.settings.includeTags = value;
                        await this.plugin.saveSettings();
                    })
            );

        // ═════════════════════════════════════════════════════════════════════
        // Maintenance
        // ═════════════════════════════════════════════════════════════════════

        const maintenanceSection = createCollapsibleSection(containerEl, "Maintenance");
        this.sections.push(maintenanceSection);

        new Setting(maintenanceSection.contentEl)
            .setName("Test connection")
            .setDesc("Verify backend server is reachable")
            .addButton((btn) =>
                btn.setButtonText("Test").onClick(async () => {
                    try {
                        const ok = await this.plugin.chromaClient.testConnection();
                        if (ok) {
                            btn.setButtonText("Connected!");
                            setTimeout(() => btn.setButtonText("Test"), 2000);
                        }
                    } catch (e) {
                        btn.setButtonText("Failed");
                        setTimeout(() => btn.setButtonText("Test"), 2000);
                    }
                })
            );

        new Setting(maintenanceSection.contentEl)
            .setName("Preview sync")
            .setDesc("Show what would be synced (dry run)")
            .addButton((btn) =>
                btn.setButtonText("Preview").onClick(async () => {
                    await this.plugin.runDryRun();
                })
            );

        new Setting(maintenanceSection.contentEl)
            .setName("Sync all files")
            .setDesc("Full sync of all included files")
            .addButton((btn) =>
                btn.setButtonText("Sync All").onClick(async () => {
                    if (!this.plugin.settings.syncEnabled) {
                        new Notice("Sync is disabled. Enable it first.");
                        return;
                    }
                    await this.plugin.runFullSync();
                })
            );

        // Purge (dangerous)
        const collectionName = this.plugin.getCollectionName();
        const purgeSetting = new Setting(maintenanceSection.contentEl)
            .setName("Purge collection")
            .setDesc(`Permanently delete all data in "${collectionName}".`);

        purgeSetting.descEl.addClass("mod-warning");

        let purgeConfirmStep = 0;
        let purgeBtn: HTMLButtonElement;

        purgeSetting.addButton((btn) => {
            purgeBtn = btn.buttonEl;
            btn.setButtonText("Purge")
                .setWarning()
                .onClick(async () => {
                    if (purgeConfirmStep === 0) {
                        purgeConfirmStep = 1;
                        btn.setButtonText("Are you sure?");
                        setTimeout(() => {
                            if (purgeConfirmStep === 1) {
                                purgeConfirmStep = 0;
                                btn.setButtonText("Purge");
                            }
                        }, 3000);
                    } else if (purgeConfirmStep === 1) {
                        purgeConfirmStep = 2;
                        btn.setButtonText("CONFIRM");

                        const confirmInput = purgeSetting.controlEl.createEl("input", {
                            type:        "text",
                            placeholder: `Type "${collectionName}"`,
                            cls:         "purge-confirm-input",
                        });
                        confirmInput.style.marginRight = "8px";
                        confirmInput.style.width = "200px";
                        purgeSetting.controlEl.insertBefore(confirmInput, purgeBtn);
                        confirmInput.focus();

                        const originalOnClick = btn.buttonEl.onclick;
                        btn.buttonEl.onclick = async () => {
                            if (confirmInput.value === collectionName) {
                                try {
                                    await this.plugin.chromaClient.deleteCollection();
                                    new Notice(`Purged: ${collectionName}`);
                                    confirmInput.remove();
                                    purgeConfirmStep = 0;
                                    btn.setButtonText("Purge");
                                    btn.buttonEl.onclick = originalOnClick;
                                } catch (e) {
                                    new Notice(`Failed: ${e.message}`);
                                }
                            } else {
                                new Notice("Name doesn't match. Cancelled.");
                                confirmInput.remove();
                                purgeConfirmStep = 0;
                                btn.setButtonText("Purge");
                                btn.buttonEl.onclick = originalOnClick;
                            }
                        };

                        confirmInput.addEventListener("keydown", (e) => {
                            if (e.key === "Escape") {
                                confirmInput.remove();
                                purgeConfirmStep = 0;
                                btn.setButtonText("Purge");
                                btn.buttonEl.onclick = originalOnClick;
                            }
                        });
                    }
                });
        });

        // Debug section
        maintenanceSection.contentEl.createEl("h4", { text: "Debug" });

        new Setting(maintenanceSection.contentEl)
            .setName("Enable debug logging")
            .setDesc("Write logs to chromadb-sync-debug.log")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.debugEnabled)
                    .onChange(async (value) => {
                        this.plugin.settings.debugEnabled = value;
                        await this.plugin.saveSettings();
                        this.plugin.logger.setEnabled(value);
                    })
            );

        new Setting(maintenanceSection.contentEl)
            .setName("Clear debug log")
            .setDesc("Delete log file contents")
            .addButton((btn) =>
                btn.setButtonText("Clear").onClick(async () => {
                    await this.plugin.logger.clear();
                    new Notice("Debug log cleared");
                })
            );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // File Tags Helpers
    // ─────────────────────────────────────────────────────────────────────────

    private formatFileTags(tags: Record<string, string[]> | undefined): string {
        if (!tags) return "";
        return Object.entries(tags)
            .map(([path, tagList]) => `${path}: ${tagList.join(", ")}`)
            .join("\n");
    }

    private parseFileTags(text: string): Record<string, string[]> {
        const result: Record<string, string[]> = {};
        const lines = text.split("\n");

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const colonIndex = trimmed.indexOf(":");
            if (colonIndex === -1) continue;

            const path = trimmed.substring(0, colonIndex).trim();
            const tagsStr = trimmed.substring(colonIndex + 1).trim();

            if (!path) continue;

            const tags = tagsStr
                .split(",")
                .map((t) => t.trim())
                .filter((t) => t.length > 0);

            if (tags.length > 0) {
                result[path] = tags;
            }
        }

        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Styles
    // ─────────────────────────────────────────────────────────────────────────

    private addStyles(): void {
        if (document.getElementById("chromadb-settings-styles")) {
            return;
        }

        const style = document.createElement("style");
        style.id = "chromadb-settings-styles";
        style.textContent = `
            /* Header row */
            .chromadb-settings-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 16px;
                padding-bottom: 12px;
                border-bottom: 1px solid var(--background-modifier-border);
            }

            .chromadb-settings-header h2 {
                margin: 0;
            }

            .chromadb-toggle-all {
                display: flex;
                gap: 8px;
            }

            .chromadb-toggle-btn {
                padding: 4px 10px;
                font-size: 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-secondary);
                cursor: pointer;
            }

            .chromadb-toggle-btn:hover {
                background: var(--background-modifier-hover);
            }

            /* Master control */
            .chromadb-master-control {
                padding: 12px;
                margin-bottom: 16px;
                background: var(--background-secondary);
                border-radius: 8px;
                border-left: 4px solid var(--interactive-accent);
            }

            .chromadb-master-control .setting-item {
                border: none;
                padding: 0;
            }

            /* Collapsible sections */
            .chromadb-section {
                margin-bottom: 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 8px;
                overflow: hidden;
            }

            .chromadb-section-header {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 12px 16px;
                background: var(--background-secondary);
                cursor: pointer;
                user-select: none;
            }

            .chromadb-section-header:hover {
                background: var(--background-modifier-hover);
            }

            .chromadb-section-chevron {
                font-size: 10px;
                color: var(--text-muted);
                transition: transform 0.15s ease;
            }

            .chromadb-section-title {
                font-weight: 600;
                font-size: 14px;
            }

            .chromadb-section-content {
                padding: 12px 16px;
                border-top: 1px solid var(--background-modifier-border);
            }

            .chromadb-section-content.collapsed {
                display: none;
            }

            .chromadb-section-content h4 {
                margin: 16px 0 8px 0;
                padding-top: 12px;
                border-top: 1px solid var(--background-modifier-border);
                font-size: 13px;
                color: var(--text-muted);
            }

            .chromadb-section-content h4:first-child {
                margin-top: 4px;
                padding-top: 0;
                border-top: none;
            }

            /* Text areas in settings */
            .chromadb-section-content textarea {
                width: 100%;
                min-height: 80px;
                font-family: var(--font-monospace);
                font-size: 12px;
            }
        `;
        document.head.appendChild(style);
    }
}
