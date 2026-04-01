#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# Markdown Parser
# Ported from TypeScript plugin implementation
# ═══════════════════════════════════════════════════════════════════════════

import re
from dataclasses import dataclass, field
from typing import Any

# ───────────────────────────────────────────────────────────────────────────────
# Types
# ───────────────────────────────────────────────────────────────────────────────

@dataclass
class ParserOptions:
    chunk_by_headers: bool = True
    max_chunk_size:   int = 2000


@dataclass
class DocumentChunk:
    content:      str
    header_path:  str
    chunk_index:  int


@dataclass
class ParsedDocument:
    frontmatter: dict[str, Any] = field(default_factory=dict)
    chunks:      list[DocumentChunk] = field(default_factory=list)
    wikilinks:   list[str] = field(default_factory=list)
    tags:        list[str] = field(default_factory=list)


# ───────────────────────────────────────────────────────────────────────────────
# Regex Patterns
# ───────────────────────────────────────────────────────────────────────────────

FRONTMATTER_REGEX = re.compile(r'^---\n([\s\S]*?)\n---\n?')
HEADER_REGEX      = re.compile(r'^(#{1,6})\s+(.+)$', re.MULTILINE)
WIKILINK_REGEX    = re.compile(r'\[\[([^\]|]+)(?:\|[^\]]+)?\]\]')
TAG_REGEX         = re.compile(r'(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)')
CODE_BLOCK_REGEX  = re.compile(r'```[\s\S]*?```')


# ───────────────────────────────────────────────────────────────────────────────
# Main Parser
# ───────────────────────────────────────────────────────────────────────────────

def parse_markdown(content: str, options: ParserOptions) -> ParsedDocument:
    """Parse markdown content into chunks with metadata."""

    # ─────────────────────────────────────────────────────────────────
    # Extract frontmatter
    # ─────────────────────────────────────────────────────────────────
    frontmatter = {}
    body_content = content

    fm_match = FRONTMATTER_REGEX.match(content)
    if fm_match:
        frontmatter = parse_frontmatter(fm_match.group(1))
        body_content = content[fm_match.end():]

    # ─────────────────────────────────────────────────────────────────
    # Extract wikilinks and tags
    # ─────────────────────────────────────────────────────────────────
    wikilinks = extract_wikilinks(body_content)
    tags = extract_tags(body_content)

    # Also extract tags from frontmatter
    if "tags" in frontmatter:
        fm_tags = frontmatter["tags"]
        if isinstance(fm_tags, list):
            for t in fm_tags:
                if isinstance(t, str) and t not in tags:
                    tags.append(t)
        elif isinstance(fm_tags, str) and fm_tags not in tags:
            tags.append(fm_tags)

    # ─────────────────────────────────────────────────────────────────
    # Chunk content
    # ─────────────────────────────────────────────────────────────────
    if options.chunk_by_headers:
        chunks = chunk_by_headers(body_content, options.max_chunk_size)
    else:
        chunks = chunk_by_size(body_content, options.max_chunk_size)

    return ParsedDocument(
        frontmatter=frontmatter,
        chunks=chunks,
        wikilinks=wikilinks,
        tags=tags
    )


# ───────────────────────────────────────────────────────────────────────────────
# Frontmatter Parser
# ───────────────────────────────────────────────────────────────────────────────

def parse_frontmatter(yaml_content: str) -> dict[str, Any]:
    """Simple YAML frontmatter parser."""
    result = {}
    lines = yaml_content.split("\n")

    current_key = ""
    in_array = False
    array_values = []

    for line in lines:
        # Skip empty lines
        if not line.strip():
            continue

        # Check for array item
        if re.match(r'^\s+-\s+', line):
            value = re.sub(r'^\s+-\s+', '', line).strip()
            if in_array and current_key:
                array_values.append(clean_yaml_value(value))
            continue

        # Finish previous array if we were in one
        if in_array and current_key:
            result[current_key] = array_values
            in_array = False
            array_values = []
            current_key = ""

        # Parse key: value
        colon_index = line.find(":")
        if colon_index > 0:
            key = line[:colon_index].strip()
            value = line[colon_index + 1:].strip()

            if value == "" or value in ("|", ">"):
                # Start of array or multiline
                current_key = key
                in_array = True
                array_values = []
            elif value.startswith("[") and value.endswith("]"):
                # Inline array: [a, b, c]
                items = [clean_yaml_value(s.strip()) for s in value[1:-1].split(",")]
                result[key] = items
            else:
                result[key] = clean_yaml_value(value)

    # Finish any pending array
    if in_array and current_key:
        result[current_key] = array_values

    return result


def clean_yaml_value(value: str):
    """Clean and convert YAML value to appropriate type."""
    # Remove quotes
    if (value.startswith('"') and value.endswith('"')) or \
       (value.startswith("'") and value.endswith("'")):
        return value[1:-1]

    # Boolean
    if value.lower() == "true":
        return True
    if value.lower() == "false":
        return False

    # Number
    try:
        if "." in value:
            return float(value)
        return int(value)
    except ValueError:
        pass

    return value


# ───────────────────────────────────────────────────────────────────────────────
# Wikilink Extraction
# ───────────────────────────────────────────────────────────────────────────────

def extract_wikilinks(content: str) -> list[str]:
    """Extract wikilinks from content."""
    links = []

    for match in WIKILINK_REGEX.finditer(content):
        link = match.group(1).strip()
        # Normalize: remove heading anchors, take just the note name
        normalized = link.split("#")[0].strip()
        if normalized and normalized not in links:
            links.append(normalized)

    return links


# ───────────────────────────────────────────────────────────────────────────────
# Tag Extraction
# ───────────────────────────────────────────────────────────────────────────────

def extract_tags(content: str) -> list[str]:
    """Extract tags from content, excluding code blocks."""
    tags = []

    # Remove code blocks to avoid extracting tags from code
    content_without_code = CODE_BLOCK_REGEX.sub("", content)

    for match in TAG_REGEX.finditer(content_without_code):
        tag = match.group(1)
        if tag not in tags:
            tags.append(tag)

    return tags


# ───────────────────────────────────────────────────────────────────────────────
# Header-based Chunking
# ───────────────────────────────────────────────────────────────────────────────

@dataclass
class HeaderNode:
    level:     int
    title:     str
    content:   str
    start_pos: int


def chunk_by_headers(content: str, max_chunk_size: int) -> list[DocumentChunk]:
    """Split content by markdown headers."""
    chunks = []
    headers = []

    # Find all headers
    for match in HEADER_REGEX.finditer(content):
        headers.append(HeaderNode(
            level=len(match.group(1)),
            title=match.group(2).strip(),
            content="",
            start_pos=match.start()
        ))

    # If no headers, treat entire content as one chunk
    if not headers:
        return chunk_by_size(content, max_chunk_size)

    # Extract content between headers
    for i, header in enumerate(headers):
        start = header.start_pos
        end = headers[i + 1].start_pos if i + 1 < len(headers) else len(content)
        header.content = content[start:end].strip()

    # Content before first header (if any)
    pre_header_content = content[:headers[0].start_pos].strip()
    if pre_header_content:
        pre_chunks = split_large_content(pre_header_content, max_chunk_size)
        for pc in pre_chunks:
            chunks.append(DocumentChunk(
                content=pc,
                header_path="",
                chunk_index=len(chunks)
            ))

    # Build header path stack for nested headers
    header_stack = []

    for header in headers:
        # Adjust stack to current level
        while len(header_stack) >= header.level:
            header_stack.pop()
        header_stack.append(header.title)

        header_path = " > ".join(header_stack)
        sub_chunks = split_large_content(header.content, max_chunk_size)

        for sub_chunk in sub_chunks:
            chunks.append(DocumentChunk(
                content=sub_chunk,
                header_path=header_path,
                chunk_index=len(chunks)
            ))

    return chunks


# ───────────────────────────────────────────────────────────────────────────────
# Size-based Chunking
# ───────────────────────────────────────────────────────────────────────────────

def chunk_by_size(content: str, max_chunk_size: int) -> list[DocumentChunk]:
    """Split content by size only."""
    chunks = []
    sub_chunks = split_large_content(content, max_chunk_size)

    for i, sc in enumerate(sub_chunks):
        chunks.append(DocumentChunk(
            content=sc,
            header_path="",
            chunk_index=i
        ))

    return chunks


# ───────────────────────────────────────────────────────────────────────────────
# Content Splitting Helper
# ───────────────────────────────────────────────────────────────────────────────

def split_large_content(content: str, max_size: int) -> list[str]:
    """Split content that exceeds max size."""
    if len(content) <= max_size:
        return [content.strip()] if content.strip() else []

    result = []
    paragraphs = re.split(r'\n\n+', content)

    current_chunk = ""

    for para in paragraphs:
        if len(para) > max_size:
            # Paragraph itself is too large, split by sentences/lines
            if current_chunk:
                result.append(current_chunk.strip())
                current_chunk = ""

            sentences = re.split(r'(?<=[.!?])\s+|\n', para)
            for sentence in sentences:
                if len(current_chunk) + len(sentence) + 1 > max_size:
                    if current_chunk:
                        result.append(current_chunk.strip())
                    current_chunk = sentence
                else:
                    current_chunk += (" " if current_chunk else "") + sentence

        elif len(current_chunk) + len(para) + 2 > max_size:
            # Adding this paragraph would exceed limit
            result.append(current_chunk.strip())
            current_chunk = para
        else:
            current_chunk += ("\n\n" if current_chunk else "") + para

    if current_chunk.strip():
        result.append(current_chunk.strip())

    return result
