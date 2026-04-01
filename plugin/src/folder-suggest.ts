// ════════════════════════════════════════════════════════════════════════════
// Path Autocomplete Components
// ════════════════════════════════════════════════════════════════════════════

import { AbstractInputSuggest, App, TFolder, TFile } from "obsidian";

// ─────────────────────────────────────────────────────────────────────────────
// Folder Suggest (Autocomplete)
// ─────────────────────────────────────────────────────────────────────────────

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
    private onSelectCallback: ((folder: TFolder, evt: MouseEvent | KeyboardEvent) => void) | null = null;

    constructor(app: App, inputEl: HTMLInputElement) {
        super(app, inputEl);
        this.limit = 100;
    }

    getSuggestions(query: string): TFolder[] {
        const allFolders = this.getAllFolders();
        const lowerQuery = query.toLowerCase();

        if (!query) {
            return allFolders.slice(0, this.limit);
        }

        return allFolders
            .filter((folder) => folder.path.toLowerCase().includes(lowerQuery))
            .slice(0, this.limit);
    }

    renderSuggestion(folder: TFolder, el: HTMLElement): void {
        el.addClass("folder-suggest-item");

        const path = folder.path || "/";
        const parts = path.split("/");
        const name = parts.pop() || "/";
        const parentPath = parts.join("/");

        if (parentPath) {
            el.createEl("span", {
                cls: "folder-suggest-parent",
                text: parentPath + "/"
            });
        }
        el.createEl("span", {
            cls: "folder-suggest-name",
            text: name
        });
    }

    selectSuggestion(folder: TFolder, evt: MouseEvent | KeyboardEvent): void {
        this.setValue(folder.path);
        if (this.onSelectCallback) {
            this.onSelectCallback(folder, evt);
        }
        this.close();
    }

    onSelect(callback: (folder: TFolder, evt: MouseEvent | KeyboardEvent) => void): this {
        this.onSelectCallback = callback;
        return this;
    }

    private getAllFolders(): TFolder[] {
        const folders: TFolder[] = [];

        // Recursively collect all folders
        const collectFolders = (folder: TFolder) => {
            folders.push(folder);
            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    collectFolders(child);
                }
            }
        };

        const root = this.app.vault.getRoot();
        // Don't include root itself, start with its children
        for (const child of root.children) {
            if (child instanceof TFolder) {
                collectFolders(child);
            }
        }

        // Sort alphabetically by path
        return folders.sort((a, b) => a.path.localeCompare(b.path));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Folder List Setting Component
// ─────────────────────────────────────────────────────────────────────────────

export interface FolderListOptions {
    app:           App;
    containerEl:   HTMLElement;
    folders:       string[];
    placeholder?:  string;
    onChange:      (folders: string[]) => void;
}

export class FolderListSetting {
    private app:         App;
    private containerEl: HTMLElement;
    private folders:     string[];
    private placeholder: string;
    private onChange:    (folders: string[]) => void;
    private listEl:      HTMLElement;
    private inputEl:     HTMLInputElement;

    constructor(options: FolderListOptions) {
        this.app         = options.app;
        this.containerEl = options.containerEl;
        this.folders     = [...options.folders];
        this.placeholder = options.placeholder || "Type folder path...";
        this.onChange    = options.onChange;

        this.render();
    }

    private render(): void {
        this.containerEl.empty();
        this.containerEl.addClass("folder-list-setting");

        // ─────────────────────────────────────────────────────────────────────
        // Current folders list
        // ─────────────────────────────────────────────────────────────────────
        this.listEl = this.containerEl.createEl("div", { cls: "folder-list" });
        this.renderFolderList();

        // ─────────────────────────────────────────────────────────────────────
        // Add folder row
        // ─────────────────────────────────────────────────────────────────────
        const addRow = this.containerEl.createEl("div", { cls: "folder-add-row" });

        this.inputEl = addRow.createEl("input", {
            type:        "text",
            placeholder: this.placeholder,
            cls:         "folder-input",
        });

        const addBtn = addRow.createEl("button", {
            cls:  "folder-add-btn",
            text: "+",
        });
        addBtn.setAttribute("aria-label", "Add folder");

        // Attach autocomplete
        const suggest = new FolderSuggest(this.app, this.inputEl);
        suggest.onSelect((folder) => {
            this.addFolder(folder.path);
        });

        // Handle enter key
        this.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                const value = this.inputEl.value.trim();
                if (value) {
                    this.addFolder(value);
                }
            }
        });

        // Handle add button click
        addBtn.addEventListener("click", () => {
            const value = this.inputEl.value.trim();
            if (value) {
                this.addFolder(value);
            }
        });

        // ─────────────────────────────────────────────────────────────────────
        // Styles
        // ─────────────────────────────────────────────────────────────────────
        this.addStyles();
    }

    private renderFolderList(): void {
        this.listEl.empty();

        if (this.folders.length === 0) {
            this.listEl.createEl("div", {
                cls:  "folder-list-empty",
                text: "(none)",
            });
            return;
        }

        for (let i = 0; i < this.folders.length; i++) {
            const folder = this.folders[i];
            const itemEl = this.listEl.createEl("div", { cls: "folder-list-item" });

            const pathEl = itemEl.createEl("span", {
                cls:  "folder-list-path",
                text: folder,
            });

            // Click to edit
            pathEl.addEventListener("click", () => {
                this.startEditing(itemEl, i, folder);
            });

            const removeBtn = itemEl.createEl("button", {
                cls:  "folder-remove-btn",
                text: "×",
            });
            removeBtn.setAttribute("aria-label", "Remove folder");

            removeBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.removeFolder(folder);
            });
        }
    }

    private startEditing(itemEl: HTMLElement, index: number, currentValue: string): void {
        // Replace item content with editable input
        itemEl.empty();
        itemEl.addClass("folder-list-item-editing");

        const editInput = itemEl.createEl("input", {
            type:  "text",
            value: currentValue,
            cls:   "folder-edit-input",
        });

        const saveBtn = itemEl.createEl("button", {
            cls:  "folder-save-btn",
            text: "✓",
        });
        saveBtn.setAttribute("aria-label", "Save");

        const cancelBtn = itemEl.createEl("button", {
            cls:  "folder-cancel-btn",
            text: "×",
        });
        cancelBtn.setAttribute("aria-label", "Cancel");

        // Attach autocomplete
        const suggest = new FolderSuggest(this.app, editInput);
        suggest.onSelect((folder) => {
            this.finishEditing(index, folder.path);
        });

        // Focus input
        editInput.focus();
        editInput.select();

        // Handle keys
        editInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                const value = editInput.value.trim();
                if (value) {
                    this.finishEditing(index, value);
                }
            } else if (e.key === "Escape") {
                e.preventDefault();
                this.renderFolderList();
            }
        });

        // Save button
        saveBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const value = editInput.value.trim();
            if (value) {
                this.finishEditing(index, value);
            }
        });

        // Cancel button
        cancelBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.renderFolderList();
        });
    }

    private finishEditing(index: number, newPath: string): void {
        // Normalize path
        newPath = newPath.replace(/^\/+|\/+$/g, "").trim();

        if (!newPath) {
            this.renderFolderList();
            return;
        }

        // Check for duplicates (excluding current index)
        const isDuplicate = this.folders.some((f, i) => i !== index && f === newPath);
        if (isDuplicate) {
            this.renderFolderList();
            return;
        }

        this.folders[index] = newPath;
        this.renderFolderList();
        this.onChange(this.folders);
    }

    private addFolder(path: string): void {
        // Normalize path
        path = path.replace(/^\/+|\/+$/g, "").trim();

        if (!path) return;

        // Don't add duplicates
        if (this.folders.includes(path)) {
            this.inputEl.value = "";
            return;
        }

        this.folders.push(path);
        this.inputEl.value = "";
        this.renderFolderList();
        this.onChange(this.folders);
    }

    private removeFolder(path: string): void {
        this.folders = this.folders.filter((f) => f !== path);
        this.renderFolderList();
        this.onChange(this.folders);
    }

    private addStyles(): void {
        // Only add styles once
        if (document.getElementById("folder-list-setting-styles")) {
            return;
        }

        const style = document.createElement("style");
        style.id = "folder-list-setting-styles";
        style.textContent = `
            .folder-list-setting {
                margin-top: 8px;
            }

            .folder-list {
                margin-bottom: 8px;
            }

            .folder-list-empty {
                color: var(--text-muted);
                font-style: italic;
                font-size: 12px;
                padding: 4px 0;
            }

            .folder-list-item {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 4px 8px;
                margin-bottom: 4px;
                background: var(--background-secondary);
                border-radius: 4px;
                font-size: 13px;
            }

            .folder-list-path {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                cursor: pointer;
                padding: 2px 4px;
                border-radius: 3px;
            }

            .folder-list-path:hover {
                background: var(--background-modifier-hover);
            }

            .folder-list-item-editing {
                gap: 4px;
            }

            .folder-edit-input {
                flex: 1;
                padding: 4px 6px;
                border: 1px solid var(--interactive-accent);
                border-radius: 3px;
                background: var(--background-primary);
                font-size: 13px;
                min-width: 0;
            }

            .folder-save-btn,
            .folder-cancel-btn {
                background: none;
                border: none;
                cursor: pointer;
                font-size: 14px;
                padding: 2px 6px;
                border-radius: 3px;
            }

            .folder-save-btn {
                color: var(--text-success);
            }

            .folder-save-btn:hover {
                background: var(--background-modifier-success);
            }

            .folder-cancel-btn {
                color: var(--text-muted);
            }

            .folder-cancel-btn:hover {
                color: var(--text-error);
            }

            .folder-remove-btn {
                background: none;
                border: none;
                color: var(--text-muted);
                cursor: pointer;
                font-size: 16px;
                padding: 0 4px;
                margin-left: 8px;
            }

            .folder-remove-btn:hover {
                color: var(--text-error);
            }

            .folder-add-row {
                display: flex;
                gap: 8px;
            }

            .folder-input {
                flex: 1;
                padding: 6px 8px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                font-size: 13px;
            }

            .folder-add-btn {
                padding: 6px 12px;
                border: none;
                border-radius: 4px;
                background: var(--interactive-accent);
                color: var(--text-on-accent);
                cursor: pointer;
                font-size: 16px;
                font-weight: bold;
            }

            .folder-add-btn:hover {
                background: var(--interactive-accent-hover);
            }

            /* Suggest dropdown styling */
            .folder-suggest-item {
                padding: 6px 10px;
            }

            .folder-suggest-parent {
                color: var(--text-muted);
            }

            .folder-suggest-name {
                font-weight: 500;
            }

            /* Full-width setting control */
            .setting-item-control-full {
                width: 100%;
                margin-top: 8px;
            }

            .setting-item:has(.setting-item-control-full) {
                flex-direction: column;
                align-items: flex-start;
            }

            .setting-item:has(.setting-item-control-full) .setting-item-info {
                width: 100%;
            }
        `;
        document.head.appendChild(style);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// File Suggest (Autocomplete)
// ─────────────────────────────────────────────────────────────────────────────

export class FileSuggest extends AbstractInputSuggest<TFile> {
    private onSelectCallback: ((file: TFile, evt: MouseEvent | KeyboardEvent) => void) | null = null;
    private extensions: string[];

    constructor(app: App, inputEl: HTMLInputElement, extensions: string[] = ["md", "pdf"]) {
        super(app, inputEl);
        this.limit = 100;
        this.extensions = extensions;
    }

    getSuggestions(query: string): TFile[] {
        const allFiles = this.getAllFiles();
        const lowerQuery = query.toLowerCase();

        if (!query) {
            return allFiles.slice(0, this.limit);
        }

        return allFiles
            .filter((file) => file.path.toLowerCase().includes(lowerQuery))
            .slice(0, this.limit);
    }

    renderSuggestion(file: TFile, el: HTMLElement): void {
        el.addClass("file-suggest-item");

        const parts = file.path.split("/");
        const name = parts.pop() || "";
        const parentPath = parts.join("/");

        if (parentPath) {
            el.createEl("span", {
                cls:  "file-suggest-parent",
                text: parentPath + "/"
            });
        }
        el.createEl("span", {
            cls:  "file-suggest-name",
            text: name
        });
    }

    selectSuggestion(file: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.setValue(file.path);
        if (this.onSelectCallback) {
            this.onSelectCallback(file, evt);
        }
        this.close();
    }

    onSelect(callback: (file: TFile, evt: MouseEvent | KeyboardEvent) => void): this {
        this.onSelectCallback = callback;
        return this;
    }

    private getAllFiles(): TFile[] {
        return this.app.vault.getFiles()
            .filter((file) => {
                const ext = file.extension.toLowerCase();
                return this.extensions.includes(ext);
            })
            .sort((a, b) => a.path.localeCompare(b.path));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// File List Setting Component
// ─────────────────────────────────────────────────────────────────────────────

export interface FileListOptions {
    app:           App;
    containerEl:   HTMLElement;
    files:         string[];
    placeholder?:  string;
    extensions?:   string[];
    onChange:      (files: string[]) => void;
}

export class FileListSetting {
    private app:         App;
    private containerEl: HTMLElement;
    private files:       string[];
    private placeholder: string;
    private extensions:  string[];
    private onChange:    (files: string[]) => void;
    private listEl:      HTMLElement;
    private inputEl:     HTMLInputElement;

    constructor(options: FileListOptions) {
        this.app         = options.app;
        this.containerEl = options.containerEl;
        this.files       = [...options.files];
        this.placeholder = options.placeholder || "Type file path...";
        this.extensions  = options.extensions || ["md", "pdf"];
        this.onChange    = options.onChange;

        this.render();
    }

    private render(): void {
        this.containerEl.empty();
        this.containerEl.addClass("file-list-setting");

        // ─────────────────────────────────────────────────────────────────────
        // Current files list
        // ─────────────────────────────────────────────────────────────────────
        this.listEl = this.containerEl.createEl("div", { cls: "folder-list" });
        this.renderFileList();

        // ─────────────────────────────────────────────────────────────────────
        // Add file row
        // ─────────────────────────────────────────────────────────────────────
        const addRow = this.containerEl.createEl("div", { cls: "folder-add-row" });

        this.inputEl = addRow.createEl("input", {
            type:        "text",
            placeholder: this.placeholder,
            cls:         "folder-input",
        });

        const addBtn = addRow.createEl("button", {
            cls:  "folder-add-btn",
            text: "+",
        });
        addBtn.setAttribute("aria-label", "Add file");

        // Attach autocomplete
        const suggest = new FileSuggest(this.app, this.inputEl, this.extensions);
        suggest.onSelect((file) => {
            this.addFile(file.path);
        });

        // Handle enter key
        this.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                const value = this.inputEl.value.trim();
                if (value) {
                    this.addFile(value);
                }
            }
        });

        // Handle add button click
        addBtn.addEventListener("click", () => {
            const value = this.inputEl.value.trim();
            if (value) {
                this.addFile(value);
            }
        });

        // Add file-specific styles
        this.addStyles();
    }

    private renderFileList(): void {
        this.listEl.empty();

        if (this.files.length === 0) {
            this.listEl.createEl("div", {
                cls:  "folder-list-empty",
                text: "(none)",
            });
            return;
        }

        for (let i = 0; i < this.files.length; i++) {
            const file = this.files[i];
            const itemEl = this.listEl.createEl("div", { cls: "folder-list-item" });

            // Show truncated path for long files
            const displayPath = this.truncatePath(file);
            const pathEl = itemEl.createEl("span", {
                cls:   "folder-list-path",
                text:  displayPath,
                title: file,  // Full path on hover
            });

            // Click to edit
            pathEl.addEventListener("click", () => {
                this.startEditing(itemEl, i, file);
            });

            const removeBtn = itemEl.createEl("button", {
                cls:  "folder-remove-btn",
                text: "×",
            });
            removeBtn.setAttribute("aria-label", "Remove file");

            removeBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.removeFile(file);
            });
        }
    }

    private truncatePath(path: string, maxLen: number = 50): string {
        if (path.length <= maxLen) return path;

        const parts = path.split("/");
        const filename = parts.pop() || "";

        if (filename.length >= maxLen - 3) {
            return "..." + filename.slice(-(maxLen - 3));
        }

        let parentPath = parts.join("/");
        const available = maxLen - filename.length - 4; // 4 for ".../""

        if (available > 0 && parentPath.length > available) {
            parentPath = "..." + parentPath.slice(-available);
        }

        return parentPath + "/" + filename;
    }

    private startEditing(itemEl: HTMLElement, index: number, currentValue: string): void {
        itemEl.empty();
        itemEl.addClass("folder-list-item-editing");

        const editInput = itemEl.createEl("input", {
            type:  "text",
            value: currentValue,
            cls:   "folder-edit-input",
        });

        const saveBtn = itemEl.createEl("button", {
            cls:  "folder-save-btn",
            text: "✓",
        });
        saveBtn.setAttribute("aria-label", "Save");

        const cancelBtn = itemEl.createEl("button", {
            cls:  "folder-cancel-btn",
            text: "×",
        });
        cancelBtn.setAttribute("aria-label", "Cancel");

        // Attach autocomplete
        const suggest = new FileSuggest(this.app, editInput, this.extensions);
        suggest.onSelect((file) => {
            this.finishEditing(index, file.path);
        });

        editInput.focus();
        editInput.select();

        editInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                const value = editInput.value.trim();
                if (value) {
                    this.finishEditing(index, value);
                }
            } else if (e.key === "Escape") {
                e.preventDefault();
                this.renderFileList();
            }
        });

        saveBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const value = editInput.value.trim();
            if (value) {
                this.finishEditing(index, value);
            }
        });

        cancelBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.renderFileList();
        });
    }

    private finishEditing(index: number, newPath: string): void {
        newPath = newPath.trim();

        if (!newPath) {
            this.renderFileList();
            return;
        }

        const isDuplicate = this.files.some((f, i) => i !== index && f === newPath);
        if (isDuplicate) {
            this.renderFileList();
            return;
        }

        this.files[index] = newPath;
        this.renderFileList();
        this.onChange(this.files);
    }

    private addFile(path: string): void {
        path = path.trim();

        if (!path) return;

        if (this.files.includes(path)) {
            this.inputEl.value = "";
            return;
        }

        this.files.push(path);
        this.inputEl.value = "";
        this.renderFileList();
        this.onChange(this.files);
    }

    private removeFile(path: string): void {
        this.files = this.files.filter((f) => f !== path);
        this.renderFileList();
        this.onChange(this.files);
    }

    private addStyles(): void {
        if (document.getElementById("file-list-setting-styles")) {
            return;
        }

        const style = document.createElement("style");
        style.id = "file-list-setting-styles";
        style.textContent = `
            .file-suggest-item {
                padding: 6px 10px;
            }

            .file-suggest-parent {
                color: var(--text-muted);
                font-size: 12px;
            }

            .file-suggest-name {
                font-weight: 500;
            }
        `;
        document.head.appendChild(style);
    }
}
