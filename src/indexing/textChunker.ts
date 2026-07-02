export const MIN_CHUNK_CHARS = 8;
export const MAX_CHUNK_CHARS = 6000;

function normalizeChunkText(text: string): string | null {
    const trimmed = text.trim();
    if (trimmed.length < MIN_CHUNK_CHARS) {
        return null;
    }
    if (text.length > MAX_CHUNK_CHARS) {
        return text.slice(0, MAX_CHUNK_CHARS);
    }
    return text;
}

/**
 * Fallback chunker that splits file content into fixed-size overlapping
 * text windows. Used when Tree-sitter cannot parse a file (e.g. markdown,
 * unsupported languages, or parse errors).
 */
export function textChunk(filePath: string, content: string, language: string): Array<{text: string, startLine: number, endLine: number}> {
    const lines = content.split(/\r?\n/);
    const chunks: Array<{text: string, startLine: number, endLine: number}> = [];
    const chunkSize = 50;
    const overlap = 10;
    
    if (lines.length === 0) {
        return [];
    }

    let i = 0;
    while (i < lines.length) {
        const endLine = Math.min(i + chunkSize - 1, lines.length - 1);
        const chunkText = lines.slice(i, endLine + 1).join('\n');
        const normalizedText = normalizeChunkText(chunkText);
        if (normalizedText) {
            chunks.push({
                text: normalizedText,
                startLine: i,
                endLine: endLine
            });
        }
        
        if (endLine === lines.length - 1) {
            // Reached the end
            break;
        }
        
        i += (chunkSize - overlap);
        // Avoid infinite loops just in case
        if (chunkSize <= overlap) {
            break;
        }
    }

    return chunks;
}
