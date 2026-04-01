// ════════════════════════════════════════════════════════════════════════════
// ChromaDB Assistant View
// Right sidebar panel with Search, Chat, and Sync tabs
// ════════════════════════════════════════════════════════════════════════════

import { ItemView, WorkspaceLeaf, Setting, TFile, TFolder, Notice, setIcon } from "obsidian";
import type ChromaDBSyncPlugin from "./main";

export const VIEW_TYPE_CHROMADB = "chromadb-assistant-view";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type TabType = "search" | "chat" | "sync";

interface SuggestionItem {
    type:        "note" | "folder" | "command";
    label:       string;
    value:       string;
    description?: string;
    icon?:       string;
}

interface SlashCommand {
    name:        string;
    description: string;
    icon:        string;
    action:      (query: string, context: string[]) => Promise<string> | string;
}

interface ChatMessage {
    id:        string;
    role:      "user" | "assistant";
    content:   string;
    timestamp: number;
    sources?:  Array<{ source: string; filename: string; distance: number }>;
}

interface ActivityEntry {
    timestamp: number;
    type:      "sync" | "delete" | "query" | "error" | "info";
    message:   string;
}

// Shared activity log (persists across view re-renders)
const activityLog: ActivityEntry[] = [];
const MAX_ACTIVITY_ENTRIES = 15;

export function logActivity(type: ActivityEntry["type"], message: string): void {
    activityLog.push({
        timestamp: Date.now(),
        type,
        message,
    });
    if (activityLog.length > MAX_ACTIVITY_ENTRIES) {
        activityLog.shift();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Handling Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface FormattedError {
    isCollectionMissing: boolean;
    message:             string;
    suggestion?:         string;
}

function formatChromaError(error: Error): FormattedError {
    const msg = error.message || String(error);

    // Check for "collection does not exist" error
    if (msg.includes("does not exist") || msg.includes("Collection") && msg.includes("not")) {
        return {
            isCollectionMissing: true,
            message:             "No data synced yet",
            suggestion:          "Run 'Sync entire vault' from the command palette or Sync tab to enable search.",
        };
    }

    // Check for connection errors
    if (msg.includes("ECONNREFUSED") || msg.includes("Failed to fetch") || msg.includes("network")) {
        return {
            isCollectionMissing: false,
            message:             "Cannot connect to backend",
            suggestion:          "Check that the backend server is running and the URL is correct in settings.",
        };
    }

    // Generic error
    return {
        isCollectionMissing: false,
        message:             msg,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// View Implementation
// ─────────────────────────────────────────────────────────────────────────────

export class ChromaDBView extends ItemView {
    plugin:           ChromaDBSyncPlugin;
    activeTab:        TabType = "search";
    contentEl:        HTMLElement;
    inputEl:          HTMLInputElement | null = null;
    filterInputEl:    HTMLInputElement | null = null;
    resultsEl:        HTMLElement | null = null;
    chatMessages:     ChatMessage[] = [];
    synthesizeMode:   boolean = false;
    filterTag:        string = "";
    syncRefreshTimer: number | null = null;

    // Autocomplete state
    private suggestionEl:       HTMLElement | null = null;
    private suggestions:        SuggestionItem[] = [];
    private selectedIndex:      number = 0;
    private triggerStart:       number = -1;
    private triggerType:        "@" | "/" | null = null;
    private mentionedNotes:     string[] = [];  // Notes referenced with @

    // Slash commands
    private slashCommands: SlashCommand[] = [
        { name: "summarize", description: "Summarize a note",              icon: "file-text",   action: (q) => `/summarize ${q}` },
        { name: "explain",   description: "Explain a concept",             icon: "help-circle", action: (q) => `/explain ${q}` },
        { name: "related",   description: "Find related notes",            icon: "git-branch",  action: (q) => `/related ${q}` },
        { name: "ask",       description: "Ask about your vault",          icon: "message-circle", action: (q) => q },
        { name: "search",    description: "Semantic search",               icon: "search",      action: (q) => `/search ${q}` },
        { name: "tags",      description: "List available folder tags",    icon: "tag",         action: () => "/tags" },
        { name: "clear",     description: "Clear chat history",            icon: "trash-2",     action: () => "/clear" },
    ];

    // Cached stats to avoid hammering the backend
    private cachedStats: { chunkCount: number; folderTagCount: number } | null = null;
    private statsLastFetched: number = 0;
    private static STATS_CACHE_MS = 30000; // Refresh stats every 30 seconds

    constructor(leaf: WorkspaceLeaf, plugin: ChromaDBSyncPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return VIEW_TYPE_CHROMADB;
    }

    getDisplayText(): string {
        return "ChromaDB Assistant";
    }

    getIcon(): string {
        return "brain";
    }

    async onOpen(): Promise<void> {
        // ─────────────────────────────────────────────────────────────────────
        // Header Actions
        // ─────────────────────────────────────────────────────────────────────
        this.addAction("settings", "Settings", () => {
            // Open plugin settings
            const setting = (this.app as any).setting;
            if (setting) {
                setting.open();
                setting.openTabById(this.plugin.manifest.id);
            }
        });

        this.addAction("refresh-cw", "Refresh", () => {
            this.renderContent();
        });

        // ─────────────────────────────────────────────────────────────────────
        // Main Container
        // ─────────────────────────────────────────────────────────────────────
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass("chromadb-view-container");

        // ─────────────────────────────────────────────────────────────────────
        // Tab Bar
        // ─────────────────────────────────────────────────────────────────────
        const tabBar = container.createEl("div", { cls: "chromadb-tab-bar" });
        this.renderTabBar(tabBar);

        // ─────────────────────────────────────────────────────────────────────
        // Content Area
        // ─────────────────────────────────────────────────────────────────────
        this.contentEl = container.createEl("div", { cls: "chromadb-content" });

        // ─────────────────────────────────────────────────────────────────────
        // Render active tab
        // ─────────────────────────────────────────────────────────────────────
        this.renderContent();

        // ─────────────────────────────────────────────────────────────────────
        // Styles
        // ─────────────────────────────────────────────────────────────────────
        this.addStyles(container);
    }

    async onClose(): Promise<void> {
        // Clear sync refresh timer
        if (this.syncRefreshTimer !== null) {
            window.clearInterval(this.syncRefreshTimer);
            this.syncRefreshTimer = null;
        }
    }

    /**
     * Set a file as context for the chat and switch to chat tab.
     * Called from "Ask about this note..." context menu action.
     */
    setContextFile(file: TFile): void {
        // Switch to chat tab
        this.activeTab = "chat";
        this.renderContent();

        // Add the file to mentioned notes
        if (!this.mentionedNotes.includes(file.path)) {
            this.mentionedNotes.push(file.path);
        }

        // Pre-fill the input with a reference
        if (this.inputEl) {
            this.inputEl.value = `@[[${file.basename}]] `;
            this.inputEl.focus();
        }
    }

    /**
     * Set selected text as context for the chat.
     * Called from "Ask about selection..." editor context menu action.
     */
    setContextText(text: string): void {
        // Switch to chat tab
        this.activeTab = "chat";
        this.renderContent();

        // Add a message showing the context
        const contextMsg: ChatMessage = {
            id:        Date.now().toString(),
            role:      "user",
            content:   `[Selected text]:\n"${text.slice(0, 500)}${text.length > 500 ? "..." : ""}"`,
            timestamp: Date.now(),
        };
        this.chatMessages.push(contextMsg);

        // Re-render to show the context
        this.renderContent();

        // Focus input for the question
        if (this.inputEl) {
            this.inputEl.placeholder = "Ask about this selection...";
            this.inputEl.focus();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tab Bar
    // ─────────────────────────────────────────────────────────────────────────

    private renderTabBar(tabBar: HTMLElement): void {
        tabBar.empty();

        // Tab buttons container
        const tabsContainer = tabBar.createEl("div", { cls: "chromadb-tabs-container" });

        const tabs: Array<{ id: TabType; label: string; icon: string }> = [
            { id: "search", label: "Search",  icon: "search" },
            { id: "chat",   label: "Chat",    icon: "message-circle" },
            { id: "sync",   label: "Sync",    icon: "refresh-cw" },
        ];

        for (const tab of tabs) {
            const tabBtn = tabsContainer.createEl("button", {
                cls: `chromadb-tab ${this.activeTab === tab.id ? "active" : ""}`,
                text: tab.label,
            });

            tabBtn.addEventListener("click", () => {
                this.activeTab = tab.id;
                this.renderTabBar(tabBar);
                this.renderContent();
            });
        }

        // Settings icon (always visible)
        const settingsBtn = tabBar.createEl("div", { cls: "chromadb-header-settings" });
        setIcon(settingsBtn, "settings");
        settingsBtn.setAttribute("aria-label", "Open settings");
        settingsBtn.addEventListener("click", () => {
            (this.app as any).setting.open();
            (this.app as any).setting.openTabById("chromadb-sync");
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Content Rendering
    // ─────────────────────────────────────────────────────────────────────────

    private renderContent(): void {
        this.contentEl.empty();

        // Clear sync refresh timer when switching away from sync tab
        if (this.syncRefreshTimer !== null && this.activeTab !== "sync") {
            window.clearInterval(this.syncRefreshTimer);
            this.syncRefreshTimer = null;
        }

        switch (this.activeTab) {
            case "search":
                this.renderSearchTab();
                break;
            case "chat":
                this.renderChatTab();
                break;
            case "sync":
                this.renderSyncTab();
                // Auto-refresh every 5 seconds (stats are cached for 30s to reduce backend load)
                if (this.syncRefreshTimer === null) {
                    this.syncRefreshTimer = window.setInterval(() => {
                        if (this.activeTab === "sync") {
                            this.renderSyncTab();
                        }
                    }, 5000);
                }
                break;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Search Tab
    // ─────────────────────────────────────────────────────────────────────────

    private renderSearchTab(): void {
        const wrapper = this.contentEl.createEl("div", { cls: "chromadb-search-wrapper" });

        // Results area (scrollable)
        this.resultsEl = wrapper.createEl("div", { cls: "chromadb-results" });
        this.resultsEl.createEl("div", {
            cls:  "chromadb-placeholder",
            text: "Enter a query to search your vault semantically.",
        });

        // Input area
        const inputArea = wrapper.createEl("div", { cls: "chromadb-input-area" });

        // Filter row with autocomplete
        const filterRow = inputArea.createEl("div", { cls: "chromadb-filter-row" });
        filterRow.createEl("span", { cls: "chromadb-filter-label", text: "Filter:" });

        // Create datalist for autocomplete
        const datalistId = "chromadb-folder-tags";
        const datalist = filterRow.createEl("datalist", { attr: { id: datalistId } });

        this.filterInputEl = filterRow.createEl("input", {
            type:        "text",
            placeholder: "Folder tag...",
            cls:         "chromadb-filter-input",
            value:       this.filterTag,
            attr:        { list: datalistId },
        });
        this.filterInputEl.addEventListener("input", () => {
            this.filterTag = this.filterInputEl?.value.trim() || "";
        });

        // Fetch folder tags for autocomplete
        this.plugin.chromaClient.getFolderTags().then((tags) => {
            datalist.empty();
            for (const tag of tags) {
                datalist.createEl("option", { value: tag });
            }
        }).catch(() => {
            // Ignore errors
        });

        // Synthesis toggle
        const toggleContainer = inputArea.createEl("div", { cls: "chromadb-toggle-row" });
        const toggleLabel = toggleContainer.createEl("label", { cls: "chromadb-toggle-label" });
        const toggle = toggleLabel.createEl("input", { type: "checkbox" });
        toggle.checked = this.synthesizeMode;
        toggle.addEventListener("change", () => {
            this.synthesizeMode = toggle.checked;
        });
        toggleLabel.appendText(" AI Synthesis");

        // Search input row
        const inputRow = inputArea.createEl("div", { cls: "chromadb-input-row" });
        this.inputEl = inputRow.createEl("input", {
            type:        "text",
            placeholder: "Search your vault...",
            cls:         "chromadb-input",
        });

        const sendBtn = inputRow.createEl("button", {
            cls:  "chromadb-send-btn",
            text: "Search",
        });

        this.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                this.performSearch();
            }
        });

        sendBtn.addEventListener("click", () => {
            this.performSearch();
        });

        this.inputEl.focus();
    }

    private async performSearch(): Promise<void> {
        if (!this.inputEl || !this.resultsEl) return;

        const query = this.inputEl.value.trim();
        if (!query) return;

        this.resultsEl.empty();
        this.resultsEl.createEl("div", {
            cls:  "chromadb-loading",
            text: this.synthesizeMode ? "Generating answer..." : "Searching...",
        });

        try {
            const filterTag = this.filterTag || undefined;

            if (this.synthesizeMode) {
                const model = this.plugin.settings.ollamaModel || undefined;
                const result = await this.plugin.chromaClient.synthesize(query, 5, model, filterTag);
                this.renderSynthesizedResult(result);
                logActivity("query", `AI synthesis: "${query.slice(0, 30)}${query.length > 30 ? "..." : ""}"`);
            } else {
                const results = await this.plugin.chromaClient.query(query, 10, filterTag);
                this.renderSearchResults(results);
                logActivity("query", `Search: "${query.slice(0, 30)}${query.length > 30 ? "..." : ""}" (${results.length} results)`);
            }
        } catch (error) {
            this.resultsEl.empty();
            const formatted = formatChromaError(error);

            const errorContainer = this.resultsEl.createEl("div", { cls: "chromadb-error-container" });
            errorContainer.createEl("div", {
                cls:  formatted.isCollectionMissing ? "chromadb-warning" : "chromadb-error",
                text: formatted.message,
            });
            if (formatted.suggestion) {
                errorContainer.createEl("div", {
                    cls:  "chromadb-suggestion",
                    text: formatted.suggestion,
                });
            }
            logActivity("error", `Search failed: ${formatted.message}`);
        }
    }

    private renderSearchResults(results: any[]): void {
        if (!this.resultsEl) return;
        this.resultsEl.empty();

        if (results.length === 0) {
            this.resultsEl.createEl("div", {
                cls:  "chromadb-placeholder",
                text: "No results found.",
            });
            return;
        }

        for (const result of results) {
            const item = this.resultsEl.createEl("div", { cls: "chromadb-result-item" });

            const source   = (result.metadata?.source as string) || "Unknown";
            const fileType = (result.metadata?.file_type as string) || "markdown";
            const heading  = (result.metadata?.heading as string) || "";
            const pageStart = result.metadata?.page_start as number | undefined;
            const pageEnd   = result.metadata?.page_end as number | undefined;

            // ─────────────────────────────────────────────────────────────
            // Header row with filename and score
            // ─────────────────────────────────────────────────────────────
            const header = item.createEl("div", { cls: "chromadb-result-header" });
            header.createEl("span", { cls: "chromadb-result-source", text: source.split("/").pop() });
            header.createEl("span", {
                cls:  "chromadb-result-score",
                text: `${(1 - result.distance).toFixed(3)}`,
            });

            // ─────────────────────────────────────────────────────────────
            // Section info (heading for markdown, page for PDF)
            // ─────────────────────────────────────────────────────────────
            if (heading) {
                const sectionEl = item.createEl("div", { cls: "chromadb-result-section" });
                sectionEl.createEl("span", { cls: "chromadb-section-icon", text: "§" });
                sectionEl.createEl("span", { text: heading });
            } else if (fileType === "pdf" && pageStart !== undefined) {
                const pageInfo = pageStart === pageEnd
                    ? `Page ${pageStart}`
                    : `Pages ${pageStart}–${pageEnd}`;
                const sectionEl = item.createEl("div", { cls: "chromadb-result-section" });
                sectionEl.createEl("span", { cls: "chromadb-section-icon", text: "📄" });
                sectionEl.createEl("span", { text: pageInfo });
            }

            // ─────────────────────────────────────────────────────────────
            // Content preview
            // ─────────────────────────────────────────────────────────────
            const preview = result.document.substring(0, 150) + (result.document.length > 150 ? "..." : "");
            item.createEl("div", { cls: "chromadb-result-preview", text: preview });

            // ─────────────────────────────────────────────────────────────
            // Click handler with section navigation
            // ─────────────────────────────────────────────────────────────
            item.addEventListener("click", async () => {
                await this.navigateToResult(source, fileType, heading, pageStart);
            });
        }
    }

    private async navigateToResult(
        source:    string,
        fileType:  string,
        heading?:  string,
        pageStart?: number
    ): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(source);

        if (!(file instanceof TFile)) {
            new Notice(`File not found: ${source}`);
            return;
        }

        // ─────────────────────────────────────────────────────────────────
        // Navigate based on file type
        // ─────────────────────────────────────────────────────────────────
        if (fileType === "pdf" && pageStart !== undefined) {
            // PDF: Open with page parameter
            // Obsidian supports opening PDFs to specific pages via subpath
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file, {
                eState: { page: pageStart }
            });
        } else if (heading) {
            // Markdown: Navigate to heading using subpath
            // Use openLinkText which handles heading navigation
            await this.app.workspace.openLinkText(
                `${source}#${heading}`,
                "",
                false
            );
        } else {
            // Fallback: Just open the file
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file);
        }
    }

    private renderSynthesizedResult(result: any): void {
        if (!this.resultsEl) return;
        this.resultsEl.empty();

        // Answer box
        const answerBox = this.resultsEl.createEl("div", { cls: "chromadb-answer-box" });
        answerBox.createEl("div", {
            cls:  "chromadb-answer-header",
            text: `AI Answer (${result.model})`,
        });
        answerBox.createEl("div", {
            cls:  "chromadb-answer-text",
            text: result.answer,
        });

        // Sources
        if (result.sources && result.sources.length > 0) {
            const sourcesEl = this.resultsEl.createEl("div", { cls: "chromadb-sources" });
            sourcesEl.createEl("div", { cls: "chromadb-sources-header", text: "Sources:" });

            for (const src of result.sources) {
                const srcItem = sourcesEl.createEl("div", { cls: "chromadb-source-item" });
                srcItem.createEl("span", { text: src.filename });
                srcItem.createEl("span", {
                    cls:  "chromadb-result-score",
                    text: `${(1 - src.distance).toFixed(3)}`,
                });

                srcItem.addEventListener("click", async () => {
                    const file = this.app.vault.getAbstractFileByPath(src.source);
                    if (file instanceof TFile) {
                        await this.app.workspace.getLeaf(false).openFile(file);
                    }
                });
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Chat Tab
    // ─────────────────────────────────────────────────────────────────────────

    private renderChatTab(): void {
        const wrapper = this.contentEl.createEl("div", { cls: "chromadb-chat-wrapper" });

        // Messages area (scrollable)
        const messagesEl = wrapper.createEl("div", { cls: "chromadb-messages" });

        if (this.chatMessages.length === 0) {
            messagesEl.createEl("div", {
                cls:  "chromadb-placeholder",
                text: "Ask questions about your vault.\n\nTips:\n• Type @ to mention notes or folders\n• Type / for commands\n• Context is included automatically",
            });
        } else {
            for (const msg of this.chatMessages) {
                this.renderChatMessage(messagesEl, msg);
            }
        }

        // Input area (with relative positioning for autocomplete)
        const inputArea = wrapper.createEl("div", { cls: "chromadb-input-area chromadb-input-area-chat" });

        // Suggestion popup container (positioned above input)
        this.suggestionEl = inputArea.createEl("div", { cls: "chromadb-suggestions hidden" });

        const inputRow = inputArea.createEl("div", { cls: "chromadb-input-row" });

        this.inputEl = inputRow.createEl("input", {
            type:        "text",
            placeholder: "Ask a question... (@ for notes, / for commands)",
            cls:         "chromadb-input",
        });

        const sendBtn = inputRow.createEl("button", {
            cls:  "chromadb-send-btn",
            text: "Send",
        });

        // Set up autocomplete handlers
        this.setupAutocomplete(this.inputEl);

        this.inputEl.addEventListener("keydown", (e) => {
            // Let autocomplete handle navigation keys if visible
            if (this.suggestionEl && !this.suggestionEl.hasClass("hidden")) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Escape" || e.key === "Tab") {
                    return; // Already handled by setupAutocomplete
                }
            }

            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                this.sendChatMessage(messagesEl);
            }
        });

        sendBtn.addEventListener("click", () => {
            this.sendChatMessage(messagesEl);
        });

        this.inputEl.focus();

        // Scroll to bottom
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    private renderChatMessage(container: HTMLElement, msg: ChatMessage): void {
        const msgEl = container.createEl("div", {
            cls: `chromadb-message chromadb-message-${msg.role}`,
        });
        msgEl.createEl("div", { cls: "chromadb-message-text", text: msg.content });

        if (msg.sources && msg.sources.length > 0) {
            const srcEl = msgEl.createEl("div", { cls: "chromadb-message-sources" });
            srcEl.createEl("span", { text: "Sources: " });
            srcEl.createEl("span", {
                text: msg.sources.map((s) => s.filename).join(", "),
            });
        }
    }

    private async sendChatMessage(messagesEl: HTMLElement): Promise<void> {
        if (!this.inputEl) return;

        const query = this.inputEl.value.trim();
        if (!query) return;

        // Clear input and hide suggestions
        this.inputEl.value = "";
        this.hideSuggestions();

        // ─────────────────────────────────────────────────────────────────────
        // Handle slash commands
        // ─────────────────────────────────────────────────────────────────────
        if (query.startsWith("/")) {
            const handled = await this.handleSlashCommand(query, messagesEl);
            if (handled) {
                this.mentionedNotes = [];
                return;
            }
        }

        // Add user message
        const userMsg: ChatMessage = {
            id:        Date.now().toString(),
            role:      "user",
            content:   query,
            timestamp: Date.now(),
        };
        this.chatMessages.push(userMsg);
        this.renderChatMessage(messagesEl, userMsg);

        // Show loading
        const loadingEl = messagesEl.createEl("div", {
            cls:  "chromadb-message chromadb-message-assistant chromadb-loading",
            text: "Thinking...",
        });
        messagesEl.scrollTop = messagesEl.scrollHeight;

        try {
            const model = this.plugin.settings.ollamaModel || undefined;

            // ─────────────────────────────────────────────────────────────────
            // Build context from mentioned notes
            // ─────────────────────────────────────────────────────────────────
            let contextQuery = query;
            if (this.mentionedNotes.length > 0) {
                const noteContents: string[] = [];
                for (const notePath of this.mentionedNotes) {
                    const file = this.app.vault.getAbstractFileByPath(notePath);
                    if (file instanceof TFile) {
                        const content = await this.app.vault.cachedRead(file);
                        noteContents.push(`--- ${file.basename} ---\n${content.slice(0, 2000)}`);
                    }
                }
                if (noteContents.length > 0) {
                    contextQuery = `Context from mentioned notes:\n${noteContents.join("\n\n")}\n\nQuestion: ${query}`;
                }
            }

            const result = await this.plugin.chromaClient.synthesize(contextQuery, 5, model);

            // Remove loading
            loadingEl.remove();

            // Add assistant message
            const assistantMsg: ChatMessage = {
                id:        (Date.now() + 1).toString(),
                role:      "assistant",
                content:   result.answer,
                timestamp: Date.now(),
                sources:   result.sources,
            };
            this.chatMessages.push(assistantMsg);
            this.renderChatMessage(messagesEl, assistantMsg);
        } catch (error) {
            loadingEl.remove();

            const formatted = formatChromaError(error);
            let errorContent = formatted.message;
            if (formatted.suggestion) {
                errorContent += `\n\n💡 ${formatted.suggestion}`;
            }

            const errorMsg: ChatMessage = {
                id:        (Date.now() + 1).toString(),
                role:      "assistant",
                content:   errorContent,
                timestamp: Date.now(),
            };
            this.chatMessages.push(errorMsg);
            this.renderChatMessage(messagesEl, errorMsg);
        }

        // Clear mentioned notes after sending
        this.mentionedNotes = [];
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Slash Command Handling
    // ─────────────────────────────────────────────────────────────────────────

    private async handleSlashCommand(query: string, messagesEl: HTMLElement): Promise<boolean> {
        const parts = query.slice(1).split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1).join(" ");

        switch (command) {
            case "clear":
                this.chatMessages = [];
                this.renderContent();
                new Notice("Chat history cleared");
                return true;

            case "tags": {
                const tags = await this.plugin.chromaClient.getFolderTags();
                const tagList = tags.length > 0 ? tags.join(", ") : "No tags found";
                const msg: ChatMessage = {
                    id:        Date.now().toString(),
                    role:      "assistant",
                    content:   `Available folder tags:\n${tagList}`,
                    timestamp: Date.now(),
                };
                this.chatMessages.push(msg);
                this.renderChatMessage(messagesEl, msg);
                return true;
            }

            case "search": {
                if (!args) {
                    new Notice("Usage: /search <query>");
                    return true;
                }
                // Switch to search tab and perform search
                this.activeTab = "search";
                this.renderContent();
                if (this.inputEl) {
                    this.inputEl.value = args;
                    this.performSearch();
                }
                return true;
            }

            case "related": {
                // Find related notes to the current file or specified note
                const activeFile = this.app.workspace.getActiveFile();
                const searchQuery = args || activeFile?.basename || "";
                if (!searchQuery) {
                    new Notice("No note specified and no active file");
                    return true;
                }
                // Use the note name as the search query
                const userMsg: ChatMessage = {
                    id:        Date.now().toString(),
                    role:      "user",
                    content:   `/related ${searchQuery}`,
                    timestamp: Date.now(),
                };
                this.chatMessages.push(userMsg);
                this.renderChatMessage(messagesEl, userMsg);

                const results = await this.plugin.chromaClient.query(searchQuery, 5);
                const relatedList = results.map((r: any) => `• ${r.metadata?.source || "Unknown"}`).join("\n");
                const msg: ChatMessage = {
                    id:        (Date.now() + 1).toString(),
                    role:      "assistant",
                    content:   `Related notes for "${searchQuery}":\n${relatedList || "No related notes found"}`,
                    timestamp: Date.now(),
                };
                this.chatMessages.push(msg);
                this.renderChatMessage(messagesEl, msg);
                return true;
            }

            case "summarize": {
                // If no args and no mentions, use the active note
                if (!args && this.mentionedNotes.length === 0) {
                    const activeFile = this.app.workspace.getActiveFile();
                    if (!activeFile) {
                        new Notice("No active note. Use /summarize @[[note]] to specify one.");
                        return true;
                    }
                    // Add active file to mentioned notes for context
                    this.mentionedNotes.push(activeFile.path);

                    // Show user message
                    const userMsg: ChatMessage = {
                        id:        Date.now().toString(),
                        role:      "user",
                        content:   `/summarize [[${activeFile.basename}]]`,
                        timestamp: Date.now(),
                    };
                    this.chatMessages.push(userMsg);
                    this.renderChatMessage(messagesEl, userMsg);

                    // Show loading
                    const loadingEl = messagesEl.createEl("div", {
                        cls:  "chromadb-message chromadb-message-assistant chromadb-loading",
                        text: "Summarizing...",
                    });
                    messagesEl.scrollTop = messagesEl.scrollHeight;

                    // Get note content and summarize
                    try {
                        const content = await this.app.vault.cachedRead(activeFile);
                        const model = this.plugin.settings.ollamaModel || undefined;
                        const result = await this.plugin.chromaClient.synthesize(
                            `Please summarize the following note:\n\n${content.slice(0, 4000)}`,
                            3,
                            model
                        );

                        loadingEl.remove();

                        const msg: ChatMessage = {
                            id:        (Date.now() + 1).toString(),
                            role:      "assistant",
                            content:   result.answer,
                            timestamp: Date.now(),
                        };
                        this.chatMessages.push(msg);
                        this.renderChatMessage(messagesEl, msg);
                    } catch (error) {
                        loadingEl.remove();
                        const formatted = formatChromaError(error);
                        let errorContent = formatted.message;
                        if (formatted.suggestion) {
                            errorContent += ` - ${formatted.suggestion}`;
                        }
                        new Notice(errorContent);
                    }

                    this.mentionedNotes = [];
                    messagesEl.scrollTop = messagesEl.scrollHeight;
                    return true;
                }
                // If there are mentions or args, fall through to normal processing
                return false;
            }

            default:
                // Unknown command - let it be processed as a regular query
                return false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Autocomplete System
    // ─────────────────────────────────────────────────────────────────────────

    private setupAutocomplete(inputEl: HTMLInputElement): void {
        inputEl.addEventListener("input", () => this.onInputChange(inputEl));
        inputEl.addEventListener("keydown", (e) => this.onInputKeydown(e, inputEl));
        inputEl.addEventListener("blur", () => {
            // Delay hiding to allow click events on suggestions
            setTimeout(() => this.hideSuggestions(), 150);
        });
    }

    private onInputChange(inputEl: HTMLInputElement): void {
        const value = inputEl.value;
        const cursorPos = inputEl.selectionStart || 0;

        // Check for trigger characters
        const beforeCursor = value.slice(0, cursorPos);

        // Find the last @ or / before cursor that isn't preceded by another character
        const atMatch = beforeCursor.match(/(^|[\s])@([^\s]*)$/);
        const slashMatch = beforeCursor.match(/^\/([^\s]*)$/);

        if (atMatch) {
            this.triggerType = "@";
            this.triggerStart = beforeCursor.lastIndexOf("@");
            const searchTerm = atMatch[2].toLowerCase();
            this.showNoteFolderSuggestions(searchTerm);
        } else if (slashMatch) {
            this.triggerType = "/";
            this.triggerStart = 0;
            const searchTerm = slashMatch[1].toLowerCase();
            this.showCommandSuggestions(searchTerm);
        } else {
            this.hideSuggestions();
        }
    }

    private onInputKeydown(e: KeyboardEvent, inputEl: HTMLInputElement): void {
        if (!this.suggestionEl || this.suggestionEl.hasClass("hidden")) {
            return;
        }

        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                this.selectedIndex = Math.min(this.selectedIndex + 1, this.suggestions.length - 1);
                this.renderSuggestions();
                break;

            case "ArrowUp":
                e.preventDefault();
                this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
                this.renderSuggestions();
                break;

            case "Tab":
            case "Enter":
                if (this.suggestions.length > 0) {
                    e.preventDefault();
                    this.selectSuggestion(inputEl, this.suggestions[this.selectedIndex]);
                }
                break;

            case "Escape":
                e.preventDefault();
                this.hideSuggestions();
                break;
        }
    }

    private showNoteFolderSuggestions(searchTerm: string): void {
        const suggestions: SuggestionItem[] = [];
        const searchLower = searchTerm.toLowerCase();

        // Get all files
        const files = this.app.vault.getFiles();
        for (const file of files) {
            if (file.extension === "md" || file.extension === "pdf") {
                const name = file.basename.toLowerCase();
                if (name.includes(searchLower) || searchTerm === "") {
                    suggestions.push({
                        type:        "note",
                        label:       file.basename,
                        value:       file.path,
                        description: file.parent?.path || "",
                        icon:        file.extension === "pdf" ? "file-text" : "file",
                    });
                }
            }
            if (suggestions.length >= 10) break;
        }

        // Get all folders
        const folders = this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder);
        for (const folder of folders) {
            if (folder.path === "/") continue;
            const name = folder.name.toLowerCase();
            if (name.includes(searchLower) || searchTerm === "") {
                suggestions.push({
                    type:        "folder",
                    label:       folder.name,
                    value:       folder.path,
                    description: "Folder",
                    icon:        "folder",
                });
            }
            if (suggestions.length >= 15) break;
        }

        this.suggestions = suggestions.slice(0, 10);
        this.selectedIndex = 0;
        this.renderSuggestions();
    }

    private showCommandSuggestions(searchTerm: string): void {
        const searchLower = searchTerm.toLowerCase();

        this.suggestions = this.slashCommands
            .filter((cmd) => cmd.name.includes(searchLower) || searchTerm === "")
            .map((cmd) => ({
                type:        "command" as const,
                label:       `/${cmd.name}`,
                value:       cmd.name,
                description: cmd.description,
                icon:        cmd.icon,
            }));

        this.selectedIndex = 0;
        this.renderSuggestions();
    }

    private previewEl: HTMLElement | null = null;
    private previewTimeout: number | null = null;

    private renderSuggestions(): void {
        if (!this.suggestionEl) return;

        this.suggestionEl.empty();
        this.hidePreview();

        if (this.suggestions.length === 0) {
            this.hideSuggestions();
            return;
        }

        this.suggestionEl.removeClass("hidden");

        for (let i = 0; i < this.suggestions.length; i++) {
            const suggestion = this.suggestions[i];
            const item = this.suggestionEl.createEl("div", {
                cls: `chromadb-suggestion-item ${i === this.selectedIndex ? "selected" : ""}`,
            });

            const iconEl = item.createEl("span", { cls: "chromadb-suggestion-icon" });
            if (suggestion.icon) {
                setIcon(iconEl, suggestion.icon);
            }

            const textEl = item.createEl("span", { cls: "chromadb-suggestion-text" });
            textEl.createEl("span", { cls: "chromadb-suggestion-label", text: suggestion.label });
            if (suggestion.description) {
                textEl.createEl("span", { cls: "chromadb-suggestion-desc", text: suggestion.description });
            }

            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                if (this.inputEl) {
                    this.selectSuggestion(this.inputEl, suggestion);
                }
            });

            item.addEventListener("mouseenter", () => {
                this.selectedIndex = i;
                // Don't re-render (causes flicker), just update selected class
                this.suggestionEl?.querySelectorAll(".chromadb-suggestion-item").forEach((el, idx) => {
                    el.toggleClass("selected", idx === i);
                });

                // Show preview for notes after a short delay
                if (suggestion.type === "note") {
                    this.schedulePreview(suggestion.value, item);
                } else {
                    this.hidePreview();
                }
            });

            item.addEventListener("mouseleave", () => {
                this.cancelPreview();
            });
        }
    }

    private schedulePreview(filePath: string, anchorEl: HTMLElement): void {
        this.cancelPreview();
        this.previewTimeout = window.setTimeout(() => {
            this.showNotePreview(filePath, anchorEl);
        }, 300);
    }

    private cancelPreview(): void {
        if (this.previewTimeout !== null) {
            window.clearTimeout(this.previewTimeout);
            this.previewTimeout = null;
        }
    }

    private async showNotePreview(filePath: string, anchorEl: HTMLElement): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;

        try {
            const content = await this.app.vault.cachedRead(file);
            const preview = content.slice(0, 500);

            // Create or update preview element
            if (!this.previewEl) {
                this.previewEl = document.body.createEl("div", { cls: "chromadb-note-preview" });
            }

            this.previewEl.empty();
            this.previewEl.createEl("div", { cls: "chromadb-preview-title", text: file.basename });
            this.previewEl.createEl("div", { cls: "chromadb-preview-content", text: preview + (content.length > 500 ? "..." : "") });

            // Position near the anchor
            const rect = anchorEl.getBoundingClientRect();
            this.previewEl.style.top = `${rect.top}px`;
            this.previewEl.style.left = `${rect.left - 320}px`;
            this.previewEl.style.display = "block";

        } catch (error) {
            // Silently fail
        }
    }

    private hidePreview(): void {
        this.cancelPreview();
        if (this.previewEl) {
            this.previewEl.style.display = "none";
        }
    }

    private selectSuggestion(inputEl: HTMLInputElement, suggestion: SuggestionItem): void {
        const value = inputEl.value;

        if (suggestion.type === "command") {
            // Replace entire input with the command
            inputEl.value = `/${suggestion.value} `;
        } else {
            // Replace from trigger to cursor with the mention
            const before = value.slice(0, this.triggerStart);
            const after = value.slice(inputEl.selectionStart || value.length);

            if (suggestion.type === "note") {
                inputEl.value = `${before}@[[${suggestion.label}]]${after}`;
                // Track mentioned note
                if (!this.mentionedNotes.includes(suggestion.value)) {
                    this.mentionedNotes.push(suggestion.value);
                }
            } else if (suggestion.type === "folder") {
                inputEl.value = `${before}@{${suggestion.label}}${after}`;
            }
        }

        this.hideSuggestions();
        inputEl.focus();

        // Move cursor to end of inserted text
        const newPos = inputEl.value.length - (suggestion.type === "command" ? 0 : value.slice(inputEl.selectionStart || value.length).length);
        inputEl.setSelectionRange(newPos, newPos);
    }

    private hideSuggestions(): void {
        if (this.suggestionEl) {
            this.suggestionEl.addClass("hidden");
            this.suggestionEl.empty();
        }
        this.suggestions = [];
        this.triggerType = null;
        this.triggerStart = -1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sync Tab
    // ─────────────────────────────────────────────────────────────────────────

    private renderSyncTab(): void {
        // Clear and re-render just the sync content
        this.contentEl.empty();

        const wrapper = this.contentEl.createEl("div", { cls: "chromadb-sync-wrapper" });

        // ─────────────────────────────────────────────────────────────────────
        // Status section (top bar)
        // ─────────────────────────────────────────────────────────────────────
        const statusSection = wrapper.createEl("div", { cls: "chromadb-sync-status" });

        const syncEnabled = this.plugin.settings.syncEnabled;
        const isSyncing   = this.plugin.syncManager.isCurrentlySyncing();
        const dirtyCount  = this.plugin.syncManager.getDirtyCount();

        const statusRow = statusSection.createEl("div", { cls: "chromadb-status-row" });
        statusRow.createEl("span", {
            cls: `chromadb-status-dot ${isSyncing ? "syncing" : syncEnabled ? "enabled" : "disabled"}`,
        });
        statusRow.createEl("span", {
            text: isSyncing
                ? "Syncing..."
                : syncEnabled
                    ? "Sync enabled"
                    : "Sync disabled",
        });

        if (dirtyCount > 0) {
            statusSection.createEl("div", {
                cls:  "chromadb-pending-count",
                text: `${dirtyCount} file(s) pending sync`,
            });
        }

        // ─────────────────────────────────────────────────────────────────────
        // Actions section
        // ─────────────────────────────────────────────────────────────────────
        const actionsSection = wrapper.createEl("div", { cls: "chromadb-sync-actions" });

        const syncModifiedBtn = actionsSection.createEl("button", {
            cls:  "chromadb-action-btn",
            text: "Sync Modified",
        });
        syncModifiedBtn.disabled = !syncEnabled || dirtyCount === 0 || isSyncing;
        syncModifiedBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const btn = e.target as HTMLButtonElement;
            btn.disabled = true;
            try {
                await this.plugin.runManualSync();
            } catch (err) {
                console.error("Sync modified failed:", err);
                new Notice(`Sync failed: ${err.message}`);
            }
        });

        const syncAllBtn = actionsSection.createEl("button", {
            cls:  "chromadb-action-btn",
            text: "Sync All",
        });
        syncAllBtn.disabled = !syncEnabled || isSyncing;
        syncAllBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const btn = e.target as HTMLButtonElement;
            btn.disabled = true;
            try {
                await this.plugin.runFullSync();
            } catch (err) {
                console.error("Sync all failed:", err);
                new Notice(`Sync failed: ${err.message}`);
            }
        });

        const stopBtn = actionsSection.createEl("button", {
            cls:  "chromadb-action-btn chromadb-action-btn-warning",
            text: "Stop Sync",
        });
        stopBtn.disabled = !isSyncing;
        stopBtn.addEventListener("click", (e) => {
            e.preventDefault();
            this.plugin.syncManager.requestCancel();
            new Notice("Stopping sync...");
        });

        // ─────────────────────────────────────────────────────────────────────
        // Scrollable content area
        // ─────────────────────────────────────────────────────────────────────
        const scrollArea = wrapper.createEl("div", { cls: "chromadb-sync-scroll" });

        // ─────────────────────────────────────────────────────────────────────
        // Database stats section
        // ─────────────────────────────────────────────────────────────────────
        const dbSection = scrollArea.createEl("div", { cls: "chromadb-db-section" });
        dbSection.createEl("div", {
            cls:  "chromadb-section-header",
            text: "Database",
        });

        const dbStats = dbSection.createEl("div", { cls: "chromadb-db-stats" });

        // Collection name
        this.createStatRow(dbStats, "Collection", this.plugin.getCollectionName());

        // Backend URL
        const backendUrl = this.plugin.settings.chromaDbUrl;
        const urlDisplay = backendUrl.replace(/^https?:\/\//, "");
        this.createStatRow(dbStats, "Backend", urlDisplay);

        // Files to sync count
        const filesToSync = this.plugin.syncManager.getFilesToSync().length;
        this.createStatRow(dbStats, "Tracked files", String(filesToSync));

        // Show cached stats immediately if available
        if (this.cachedStats) {
            this.createStatRow(dbStats, "Indexed chunks", String(this.cachedStats.chunkCount));
            this.createStatRow(dbStats, "Folder tags", String(this.cachedStats.folderTagCount));
        }

        // Fetch fresh stats only if cache is stale (and not syncing)
        const now = Date.now();
        const cacheExpired = (now - this.statsLastFetched) > ChromaDBView.STATS_CACHE_MS;

        if (!isSyncing && cacheExpired) {
            this.fetchStats(dbStats);
        }

        // ─────────────────────────────────────────────────────────────────────
        // Activity log section
        // ─────────────────────────────────────────────────────────────────────
        const activitySection = scrollArea.createEl("div", { cls: "chromadb-activity-section" });
        activitySection.createEl("div", {
            cls:  "chromadb-section-header",
            text: "Recent Activity",
        });

        if (activityLog.length > 0) {
            const activityList = activitySection.createEl("div", { cls: "chromadb-activity-list" });

            for (const entry of activityLog) {
                const entryEl = activityList.createEl("div", { cls: `chromadb-activity-entry chromadb-activity-${entry.type}` });

                const timeStr = this.formatTime(entry.timestamp);
                entryEl.createEl("span", { cls: "chromadb-activity-time", text: timeStr });
                entryEl.createEl("span", { cls: "chromadb-activity-msg", text: entry.message });
            }
        } else {
            activitySection.createEl("div", {
                cls:  "chromadb-activity-empty",
                text: "No recent activity",
            });
        }
    }

    private async fetchStats(dbStats: HTMLElement): Promise<void> {
        this.statsLastFetched = Date.now();

        try {
            const [chunkCount, tags] = await Promise.all([
                this.plugin.chromaClient.getCollectionCount(),
                this.plugin.chromaClient.getFolderTags(),
            ]);

            this.cachedStats = {
                chunkCount,
                folderTagCount: tags.length,
            };

            // Update display if element still exists and we don't already have stats shown
            if (dbStats.isConnected) {
                // Remove old stat rows for chunks/tags if they exist, then add new ones
                const existingRows = dbStats.querySelectorAll(".chromadb-stat-row");
                let hasChunks = false;
                let hasTags = false;
                existingRows.forEach((row) => {
                    const label = row.querySelector(".chromadb-stat-label")?.textContent;
                    if (label === "Indexed chunks") hasChunks = true;
                    if (label === "Folder tags") hasTags = true;
                });

                if (!hasChunks) {
                    this.createStatRow(dbStats, "Indexed chunks", String(chunkCount));
                }
                if (!hasTags) {
                    this.createStatRow(dbStats, "Folder tags", String(tags.length));
                }
            }
        } catch {
            // Ignore errors
        }
    }

    private createStatRow(container: HTMLElement, label: string, value: string): void {
        const row = container.createEl("div", { cls: "chromadb-stat-row" });
        row.createEl("span", { cls: "chromadb-stat-label", text: label });
        row.createEl("span", { cls: "chromadb-stat-value", text: value });
    }

    private formatTime(timestamp: number): string {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Styles
    // ─────────────────────────────────────────────────────────────────────────

    private addStyles(container: HTMLElement): void {
        const style = document.createElement("style");
        style.textContent = `
            /* ═══════════════════════════════════════════════════════════════════════
               ChromaDB Sync Plugin Styles
               ═══════════════════════════════════════════════════════════════════════ */

            /* ───────────────────────────────────────────────────────────────────────
               Container & Layout
               ─────────────────────────────────────────────────────────────────────── */

            .chromadb-view-container {
                display: flex;
                flex-direction: column;
                height: 100%;
                padding: 0;
            }

            .chromadb-tab-bar {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 12px 12px 8px 12px;
                border-bottom: 1px solid var(--background-modifier-border);
            }

            .chromadb-tabs-container {
                display: flex;
                flex: 1;
                gap: 4px;
            }

            .chromadb-tab {
                flex: 1;
                padding: 6px 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: var(--radius-s);
                background: var(--background-secondary);
                color: var(--text-muted);
                cursor: pointer;
                font-size: 0.85em;
                font-weight: 500;
                transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
            }

            .chromadb-tab:hover {
                background: var(--background-modifier-hover);
                border-color: var(--background-modifier-border-hover);
                color: var(--text-normal);
            }

            .chromadb-tab.active {
                background: var(--interactive-accent);
                border-color: var(--interactive-accent);
                color: var(--text-on-accent);
            }

            .chromadb-header-settings {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 28px;
                height: 28px;
                border-radius: var(--radius-s);
                color: var(--text-muted);
                cursor: pointer;
                transition: background 0.15s ease, color 0.15s ease;
            }

            .chromadb-header-settings:hover {
                background: var(--background-modifier-hover);
                color: var(--text-normal);
            }

            .chromadb-content {
                flex: 1;
                overflow: hidden;
                display: flex;
                flex-direction: column;
            }

            /* ───────────────────────────────────────────────────────────────────────
               Search & Chat Wrappers
               ─────────────────────────────────────────────────────────────────────── */

            .chromadb-search-wrapper,
            .chromadb-chat-wrapper {
                display: flex;
                flex-direction: column;
                height: 100%;
            }

            .chromadb-results,
            .chromadb-messages {
                flex: 1;
                overflow-y: auto;
                padding: 8px;
            }

            /* ───────────────────────────────────────────────────────────────────────
               Input Area
               ─────────────────────────────────────────────────────────────────────── */

            .chromadb-input-area {
                padding: 12px;
                border-top: 1px solid var(--background-modifier-border);
                background: var(--background-primary);
            }

            .chromadb-filter-row {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 8px;
            }

            .chromadb-filter-label {
                font-size: 0.85em;
                color: var(--text-muted);
                white-space: nowrap;
            }

            .chromadb-filter-input {
                flex: 1;
                padding: 6px 8px;
                border: 1px solid var(--background-modifier-border);
                border-radius: var(--radius-s);
                background: var(--background-primary);
                font-size: 0.85em;
                transition: border-color 0.15s ease;
            }

            .chromadb-filter-input:focus {
                border-color: var(--interactive-accent);
                outline: none;
            }

            .chromadb-toggle-row {
                display: flex;
                align-items: center;
                gap: 6px;
                margin-bottom: 8px;
                padding: 4px 0;
            }

            .chromadb-toggle-label {
                display: flex;
                align-items: center;
                gap: 6px;
                cursor: pointer;
                font-size: 0.85em;
                color: var(--text-muted);
            }

            .chromadb-input-row {
                display: flex;
                gap: 8px;
            }

            .chromadb-input {
                flex: 1;
                padding: 8px 10px;
                border: 1px solid var(--background-modifier-border);
                border-radius: var(--radius-s);
                background: var(--background-primary);
                font-size: 0.9em;
                transition: border-color 0.15s ease;
            }

            .chromadb-input:focus {
                border-color: var(--interactive-accent);
                outline: none;
            }

            .chromadb-send-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                padding: 8px 16px;
                border: none;
                border-radius: var(--radius-s);
                background: var(--interactive-accent);
                color: var(--text-on-accent);
                font-size: 0.9em;
                font-weight: 500;
                cursor: pointer;
                transition: background 0.15s ease;
            }

            .chromadb-send-btn:hover {
                background: var(--interactive-accent-hover);
            }

            /* ───────────────────────────────────────────────────────────────────────
               Placeholder & States
               ─────────────────────────────────────────────────────────────────────── */

            .chromadb-placeholder {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 8px;
                padding: 40px 20px;
                color: var(--text-muted);
                font-size: 0.9em;
                flex: 1;
            }

            .chromadb-loading {
                color: var(--text-muted);
                font-style: italic;
                font-size: 0.85em;
            }

            .chromadb-error {
                color: var(--text-error);
                padding: 12px;
                font-size: 0.85em;
            }

            .chromadb-error-container {
                padding: 16px;
                background: var(--background-secondary);
                border-radius: var(--radius-m);
                border-left: 3px solid var(--text-warning);
            }

            .chromadb-warning {
                color: var(--text-warning);
                font-weight: 500;
                font-size: 0.9em;
                margin-bottom: 8px;
            }

            .chromadb-suggestion {
                color: var(--text-muted);
                font-size: 0.85em;
                line-height: 1.4;
            }

            /* ───────────────────────────────────────────────────────────────────────
               Search Results
               ─────────────────────────────────────────────────────────────────────── */

            .chromadb-result-item {
                padding: 10px 12px;
                margin-bottom: 6px;
                background: var(--background-secondary);
                border-radius: var(--radius-m);
                border: 1px solid var(--background-modifier-border);
                cursor: pointer;
                transition: border-color 0.15s ease, box-shadow 0.15s ease;
            }

            .chromadb-result-item:hover {
                border-color: var(--background-modifier-border-hover);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
            }

            .chromadb-result-item:last-child {
                margin-bottom: 0;
            }

            .chromadb-result-header {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                margin-bottom: 4px;
            }

            .chromadb-result-source {
                font-weight: 600;
                font-size: 0.9em;
                color: var(--text-normal);
                word-break: break-word;
            }

            .chromadb-result-score {
                color: var(--text-muted);
                font-size: 0.8em;
                font-weight: 500;
                flex-shrink: 0;
                margin-left: 8px;
            }

            .chromadb-result-section {
                display: flex;
                align-items: center;
                gap: 4px;
                font-size: 0.8em;
                color: var(--text-accent);
                margin-bottom: 6px;
            }

            .chromadb-section-icon {
                display: flex;
                opacity: 0.7;
            }

            .chromadb-result-preview {
                font-size: 0.85em;
                color: var(--text-muted);
                line-height: 1.4;
            }

            /* ───────────────────────────────────────────────────────────────────────
               Answer Box (AI Synthesis)
               ─────────────────────────────────────────────────────────────────────── */

            .chromadb-answer-box {
                background: var(--background-secondary);
                border: 1px solid var(--background-modifier-border);
                border-radius: var(--radius-m);
                padding: 12px;
                margin-bottom: 12px;
            }

            .chromadb-answer-header {
                font-weight: 600;
                font-size: 0.9em;
                color: var(--text-accent);
                margin-bottom: 8px;
            }

            .chromadb-answer-text {
                white-space: pre-wrap;
                line-height: 1.5;
                font-size: 0.9em;
            }

            .chromadb-sources {
                margin-top: 12px;
                padding-top: 12px;
                border-top: 1px solid var(--background-modifier-border);
            }

            .chromadb-sources-header {
                font-weight: 600;
                font-size: 0.85em;
                margin-bottom: 8px;
                color: var(--text-muted);
            }

            .chromadb-source-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 6px 10px;
                background: var(--background-primary);
                border-radius: var(--radius-s);
                margin-bottom: 4px;
                cursor: pointer;
                font-size: 0.85em;
                transition: background 0.15s ease;
            }

            .chromadb-source-item:hover {
                background: var(--background-modifier-hover);
            }

            /* ───────────────────────────────────────────────────────────────────────
               Chat Messages
               ─────────────────────────────────────────────────────────────────────── */

            .chromadb-message {
                padding: 10px 12px;
                border-radius: var(--radius-m);
                margin-bottom: 8px;
                max-width: 85%;
                font-size: 0.9em;
                line-height: 1.4;
            }

            .chromadb-message-user {
                background: var(--interactive-accent);
                color: var(--text-on-accent);
                margin-left: auto;
            }

            .chromadb-message-assistant {
                background: var(--background-secondary);
                border: 1px solid var(--background-modifier-border);
            }

            .chromadb-message-sources {
                font-size: 0.8em;
                color: var(--text-muted);
                margin-top: 8px;
                padding-top: 8px;
                border-top: 1px solid var(--background-modifier-border);
            }

            /* ───────────────────────────────────────────────────────────────────────
               Autocomplete Suggestions
               ─────────────────────────────────────────────────────────────────────── */

            .chromadb-input-area-chat {
                position: relative;
            }

            .chromadb-suggestions {
                position: absolute;
                bottom: 100%;
                left: 12px;
                right: 12px;
                max-height: 200px;
                overflow-y: auto;
                background: var(--background-primary);
                border: 1px solid var(--background-modifier-border);
                border-radius: var(--radius-m);
                box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.15);
                margin-bottom: 4px;
                z-index: 100;
            }

            .chromadb-suggestions.hidden {
                display: none;
            }

            .chromadb-suggestion-item {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 12px;
                cursor: pointer;
                transition: background 0.1s ease;
            }

            .chromadb-suggestion-item:hover,
            .chromadb-suggestion-item.selected {
                background: var(--background-modifier-hover);
            }

            .chromadb-suggestion-icon {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 18px;
                height: 18px;
                color: var(--text-muted);
                flex-shrink: 0;
            }

            .chromadb-suggestion-icon svg {
                width: 16px;
                height: 16px;
            }

            .chromadb-suggestion-text {
                display: flex;
                flex-direction: column;
                gap: 2px;
                min-width: 0;
                flex: 1;
            }

            .chromadb-suggestion-label {
                font-size: 0.9em;
                font-weight: 500;
                color: var(--text-normal);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .chromadb-suggestion-desc {
                font-size: 0.75em;
                color: var(--text-muted);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            /* ───────────────────────────────────────────────────────────────────────
               Note Preview Tooltip
               ─────────────────────────────────────────────────────────────────────── */

            .chromadb-note-preview {
                position: fixed;
                width: 300px;
                max-height: 250px;
                background: var(--background-primary);
                border: 1px solid var(--background-modifier-border);
                border-radius: var(--radius-m);
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
                padding: 12px;
                z-index: 1000;
                display: none;
                overflow: hidden;
            }

            .chromadb-preview-title {
                font-weight: 600;
                font-size: 0.95em;
                margin-bottom: 8px;
                padding-bottom: 6px;
                border-bottom: 1px solid var(--background-modifier-border);
                color: var(--text-normal);
            }

            .chromadb-preview-content {
                font-size: 0.85em;
                color: var(--text-muted);
                line-height: 1.5;
                max-height: 180px;
                overflow: hidden;
                white-space: pre-wrap;
                word-wrap: break-word;
            }

            /* ───────────────────────────────────────────────────────────────────────
               Sync Tab
               ─────────────────────────────────────────────────────────────────────── */

            .chromadb-sync-wrapper {
                display: flex;
                flex-direction: column;
                height: 100%;
                padding: 0;
                position: relative;
            }

            .chromadb-sync-status {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 12px;
                background: var(--background-secondary);
                border-bottom: 1px solid var(--background-modifier-border);
            }

            .chromadb-status-row {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .chromadb-status-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                flex-shrink: 0;
            }

            .chromadb-status-dot.enabled {
                background: var(--text-success);
            }

            .chromadb-status-dot.disabled {
                background: var(--text-error);
            }

            .chromadb-status-dot.syncing {
                background: var(--text-warning);
                animation: chromadb-pulse 1s infinite;
            }

            @keyframes chromadb-pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.4; }
            }

            .chromadb-status-row span:last-child {
                font-size: 0.85em;
                color: var(--text-muted);
            }

            .chromadb-pending-count {
                font-size: 0.85em;
                font-weight: 500;
                color: var(--text-warning);
            }

            /* ───────────────────────────────────────────────────────────────────────
               Sync Actions (Footer style)
               ─────────────────────────────────────────────────────────────────────── */

            .chromadb-sync-actions {
                display: flex;
                gap: 8px;
                padding: 12px;
                border-bottom: 1px solid var(--background-modifier-border);
                background: var(--background-primary);
            }

            .chromadb-action-btn {
                flex: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                padding: 8px 12px;
                border-radius: var(--radius-m);
                border: 1px solid var(--background-modifier-border);
                background: var(--background-secondary);
                color: var(--text-normal);
                font-size: 0.85em;
                font-weight: 500;
                cursor: pointer;
                transition: background 0.15s ease, border-color 0.15s ease;
            }

            .chromadb-action-btn:hover:not(:disabled) {
                background: var(--background-modifier-hover);
                border-color: var(--background-modifier-border-hover);
            }

            .chromadb-action-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            .chromadb-action-btn-warning {
                background: var(--background-modifier-error);
                border-color: var(--background-modifier-error);
                color: var(--text-on-accent);
            }

            .chromadb-action-btn-warning:hover:not(:disabled) {
                background: var(--text-error);
                border-color: var(--text-error);
            }

            /* ───────────────────────────────────────────────────────────────────────
               Scrollable Content Area
               ─────────────────────────────────────────────────────────────────────── */

            .chromadb-sync-scroll {
                flex: 1;
                overflow-y: auto;
                padding: 12px;
            }

            .chromadb-section-header {
                font-size: 0.75em;
                font-weight: 600;
                color: var(--text-muted);
                text-transform: uppercase;
                letter-spacing: 0.05em;
                padding-bottom: 8px;
                margin-bottom: 8px;
                border-bottom: 1px solid var(--background-modifier-border);
            }

            /* ───────────────────────────────────────────────────────────────────────
               Activity Log
               ─────────────────────────────────────────────────────────────────────── */

            .chromadb-activity-section {
                margin-bottom: 16px;
            }

            .chromadb-activity-list {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }

            .chromadb-activity-entry {
                display: flex;
                gap: 8px;
                padding: 5px 8px;
                border-radius: var(--radius-s);
                background: var(--background-secondary);
                font-size: 0.8em;
            }

            .chromadb-activity-time {
                color: var(--text-faint);
                white-space: nowrap;
                font-family: var(--font-monospace);
                font-size: 0.9em;
            }

            .chromadb-activity-msg {
                color: var(--text-muted);
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .chromadb-activity-empty {
                font-size: 0.8em;
                color: var(--text-faint);
                font-style: italic;
                padding: 8px 0;
            }

            .chromadb-activity-sync .chromadb-activity-msg {
                color: var(--text-success);
            }

            .chromadb-activity-delete .chromadb-activity-msg {
                color: var(--text-warning);
            }

            .chromadb-activity-error .chromadb-activity-msg {
                color: var(--text-error);
            }

            /* ───────────────────────────────────────────────────────────────────────
               Database Stats
               ─────────────────────────────────────────────────────────────────────── */

            .chromadb-db-section {
                margin-bottom: 16px;
            }

            .chromadb-db-stats {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }

            .chromadb-stat-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 6px 10px;
                background: var(--background-secondary);
                border-radius: var(--radius-s);
                font-size: 0.8em;
            }

            .chromadb-stat-label {
                color: var(--text-muted);
            }

            .chromadb-stat-value {
                color: var(--text-normal);
                font-weight: 500;
                font-family: var(--font-monospace);
                font-size: 0.95em;
            }

            .chromadb-activity-query .chromadb-activity-msg {
                color: var(--text-accent);
            }
        `;
        container.appendChild(style);
    }
}
