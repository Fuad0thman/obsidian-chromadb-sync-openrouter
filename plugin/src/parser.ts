// ════════════════════════════════════════════════════════════════════════════
// Markdown Parser
// ════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedDocument {
    frontmatter:    Record<string, unknown>;
    chunks:         DocumentChunk[];
    wikilinks:      string[];
    tags:           string[];
}

export interface DocumentChunk {
    content:      string;
    headerPath:   string;
    chunkIndex:   number;
}

export interface ParserOptions {
    chunkByHeaders: boolean;
    maxChunkSize:   number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Regex Patterns
// ─────────────────────────────────────────────────────────────────────────────

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?/;
const HEADER_REGEX      = /^(#{1,6})\s+(.+)$/gm;
const WIKILINK_REGEX    = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const TAG_REGEX         = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g;
const CODE_BLOCK_REGEX  = /```[\s\S]*?```/g;

// ─────────────────────────────────────────────────────────────────────────────
// Main Parser
// ─────────────────────────────────────────────────────────────────────────────

export function parseMarkdown(content: string, options: ParserOptions): ParsedDocument {
    // ─────────────────────────────────────────────────────────────────────────
    // Extract frontmatter
    // ─────────────────────────────────────────────────────────────────────────
    let frontmatter: Record<string, unknown> = {};
    let bodyContent = content;

    const fmMatch = content.match(FRONTMATTER_REGEX);
    if (fmMatch) {
        frontmatter = parseFrontmatter(fmMatch[1]);
        bodyContent = content.slice(fmMatch[0].length);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Extract wikilinks and tags from full content
    // ─────────────────────────────────────────────────────────────────────────
    const wikilinks = extractWikilinks(bodyContent);
    const tags      = extractTags(bodyContent);

    // Also extract tags from frontmatter if present
    if (frontmatter.tags) {
        const fmTags = Array.isArray(frontmatter.tags)
            ? frontmatter.tags
            : [frontmatter.tags];
        for (const t of fmTags) {
            if (typeof t === "string" && !tags.includes(t)) {
                tags.push(t);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Chunk content
    // ─────────────────────────────────────────────────────────────────────────
    let chunks: DocumentChunk[];
    if (options.chunkByHeaders) {
        chunks = chunkByHeaders(bodyContent, options.maxChunkSize);
    } else {
        chunks = chunkBySize(bodyContent, options.maxChunkSize);
    }

    return { frontmatter, chunks, wikilinks, tags };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter Parser
// ─────────────────────────────────────────────────────────────────────────────

function parseFrontmatter(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = yaml.split("\n");

    let currentKey    = "";
    let inArray       = false;
    let arrayValues: (string | number | boolean)[] = [];

    for (const line of lines) {
        // Skip empty lines
        if (line.trim() === "") continue;

        // Check for array item
        if (line.match(/^\s+-\s+/)) {
            const value = line.replace(/^\s+-\s+/, "").trim();
            if (inArray && currentKey) {
                arrayValues.push(cleanYamlValue(value));
            }
            continue;
        }

        // Finish previous array if we were in one
        if (inArray && currentKey) {
            result[currentKey] = arrayValues;
            inArray     = false;
            arrayValues = [];
            currentKey  = "";
        }

        // Parse key: value
        const colonIndex = line.indexOf(":");
        if (colonIndex > 0) {
            const key   = line.slice(0, colonIndex).trim();
            const value = line.slice(colonIndex + 1).trim();

            if (value === "" || value === "|" || value === ">") {
                // Start of array or multiline
                currentKey = key;
                inArray    = true;
                arrayValues = [];
            } else if (value.startsWith("[") && value.endsWith("]")) {
                // Inline array: [a, b, c]
                const items = value.slice(1, -1).split(",").map((s) => cleanYamlValue(s.trim()));
                result[key] = items;
            } else {
                result[key] = cleanYamlValue(value);
            }
        }
    }

    // Finish any pending array
    if (inArray && currentKey) {
        result[currentKey] = arrayValues;
    }

    return result;
}

function cleanYamlValue(value: string): string | number | boolean {
    // Remove quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }

    // Boolean
    if (value === "true")  return true;
    if (value === "false") return false;

    // Number
    const num = Number(value);
    if (!isNaN(num) && value !== "") return num;

    return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wikilink Extraction
// ─────────────────────────────────────────────────────────────────────────────

export function extractWikilinks(content: string): string[] {
    const links: string[] = [];
    let match: RegExpExecArray | null;

    // Reset regex state
    WIKILINK_REGEX.lastIndex = 0;

    while ((match = WIKILINK_REGEX.exec(content)) !== null) {
        const link = match[1].trim();
        // Normalize: remove heading anchors, take just the note name
        const normalized = link.split("#")[0].trim();
        if (normalized && !links.includes(normalized)) {
            links.push(normalized);
        }
    }

    return links;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tag Extraction
// ─────────────────────────────────────────────────────────────────────────────

export function extractTags(content: string): string[] {
    const tags: string[] = [];

    // Remove code blocks to avoid extracting tags from code
    const contentWithoutCode = content.replace(CODE_BLOCK_REGEX, "");

    let match: RegExpExecArray | null;
    TAG_REGEX.lastIndex = 0;

    while ((match = TAG_REGEX.exec(contentWithoutCode)) !== null) {
        const tag = match[1];
        if (!tags.includes(tag)) {
            tags.push(tag);
        }
    }

    return tags;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header-based Chunking
// ─────────────────────────────────────────────────────────────────────────────

interface HeaderNode {
    level:    number;
    title:    string;
    content:  string;
    startPos: number;
}

export function chunkByHeaders(content: string, maxChunkSize: number): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    const headers: HeaderNode[] = [];

    // Find all headers
    let match: RegExpExecArray | null;
    HEADER_REGEX.lastIndex = 0;

    while ((match = HEADER_REGEX.exec(content)) !== null) {
        headers.push({
            level:    match[1].length,
            title:    match[2].trim(),
            content:  "",
            startPos: match.index,
        });
    }

    // If no headers, treat entire content as one chunk
    if (headers.length === 0) {
        return chunkBySize(content, maxChunkSize);
    }

    // Extract content between headers
    for (let i = 0; i < headers.length; i++) {
        const start = headers[i].startPos;
        const end   = i + 1 < headers.length ? headers[i + 1].startPos : content.length;
        headers[i].content = content.slice(start, end).trim();
    }

    // Content before first header (if any)
    const preHeaderContent = content.slice(0, headers[0].startPos).trim();
    if (preHeaderContent) {
        const preChunks = splitLargeContent(preHeaderContent, maxChunkSize);
        for (let i = 0; i < preChunks.length; i++) {
            chunks.push({
                content:    preChunks[i],
                headerPath: "",
                chunkIndex: chunks.length,
            });
        }
    }

    // Build header path stack for nested headers
    const headerStack: string[] = [];

    for (const header of headers) {
        // Adjust stack to current level
        while (headerStack.length >= header.level) {
            headerStack.pop();
        }
        headerStack.push(header.title);

        const headerPath = headerStack.join(" > ");
        const subChunks  = splitLargeContent(header.content, maxChunkSize);

        for (const subChunk of subChunks) {
            chunks.push({
                content:    subChunk,
                headerPath: headerPath,
                chunkIndex: chunks.length,
            });
        }
    }

    return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Size-based Chunking
// ─────────────────────────────────────────────────────────────────────────────

export function chunkBySize(content: string, maxChunkSize: number): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    const subChunks = splitLargeContent(content, maxChunkSize);

    for (let i = 0; i < subChunks.length; i++) {
        chunks.push({
            content:    subChunks[i],
            headerPath: "",
            chunkIndex: i,
        });
    }

    return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Content Splitting Helper
// ─────────────────────────────────────────────────────────────────────────────

function splitLargeContent(content: string, maxSize: number): string[] {
    if (content.length <= maxSize) {
        return content.trim() ? [content.trim()] : [];
    }

    const result: string[] = [];
    const paragraphs = content.split(/\n\n+/);

    let currentChunk = "";

    for (const para of paragraphs) {
        if (para.length > maxSize) {
            // Paragraph itself is too large, split by sentences/lines
            if (currentChunk) {
                result.push(currentChunk.trim());
                currentChunk = "";
            }
            const sentences = para.split(/(?<=[.!?])\s+|\n/);
            for (const sentence of sentences) {
                if (currentChunk.length + sentence.length + 1 > maxSize) {
                    if (currentChunk) {
                        result.push(currentChunk.trim());
                    }
                    currentChunk = sentence;
                } else {
                    currentChunk += (currentChunk ? " " : "") + sentence;
                }
            }
        } else if (currentChunk.length + para.length + 2 > maxSize) {
            // Adding this paragraph would exceed limit
            result.push(currentChunk.trim());
            currentChunk = para;
        } else {
            currentChunk += (currentChunk ? "\n\n" : "") + para;
        }
    }

    if (currentChunk.trim()) {
        result.push(currentChunk.trim());
    }

    return result;
}
