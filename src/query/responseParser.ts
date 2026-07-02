export interface LocationData {
    filePath: string;
    startLine: number;
    endLine: number;
}

function stripMarkdownFences(text: string): string {
    const trimmed = text.trim();
    const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

function parseRegexLocation(response: string): LocationData | null {
    const regex = /\[FILE:\s*(.+?)\s*LINES:\s*(\d+)\s*-\s*(\d+)\s*\]/i;
    const match = response.match(regex);
    if (!match) {
        return null;
    }

    const filePath = match[1].trim();
    const startLine = parseInt(match[2], 10) - 1;
    const endLine = parseInt(match[3], 10) - 1;

    if (isNaN(startLine) || isNaN(endLine)) {
        return null;
    }
    if (filePath.length < 3) {
        return null;
    }

    return { filePath, startLine, endLine };
}

export function stripLocationsBlock(response: string): string {
    const markerIndex = response.search(/\bLOCATIONS:\s*/i);
    if (markerIndex === -1) {
        return response;
    }
    return response.slice(0, markerIndex).trimEnd();
}

export function parseAllLocations(response: string): LocationData[] {
    try {
        const markerMatch = response.match(/(?:LOCATIONS:|### Locations)\s*([\s\S]+)$/i);
        if (!markerMatch) {
            return [];
        }

        const contentText = stripMarkdownFences(markerMatch[1]);
        
        // Try parsing as JSON first (legacy)
        try {
            const parsed = JSON.parse(contentText) as Array<{
                file?: string;
                startLine?: number;
                endLine?: number;
            }>;
            if (Array.isArray(parsed)) {
                return parsed
                    .filter(item => typeof item.file === 'string' && typeof item.startLine === 'number' && typeof item.endLine === 'number')
                    .map(item => ({
                        filePath: item.file!.trim(),
                        startLine: Math.max(0, item.startLine! - 1),
                        endLine: Math.max(0, item.endLine! - 1)
                    }))
                    .filter(item => item.filePath.length > 2);
            }
        } catch {
            // Not JSON, continue to Markdown parser
        }

        // Parse as Markdown links: * [name](file:///path#L1-10)
        const locations: LocationData[] = [];
        const regex = /\[.*?\]\(file:\/\/(.*?)(?:#L(\d+)-(\d+))?\)/gi;
        let match;
        while ((match = regex.exec(contentText)) !== null) {
            let filePath = match[1];
            if (filePath.startsWith('/')) {
                // Remove the extra slash for Windows paths (e.g. file:///C:/...)
                if (filePath.match(/^\/[a-zA-Z]:/)) {
                    filePath = filePath.substring(1);
                }
            }
            const startLine = match[2] ? Math.max(0, parseInt(match[2], 10) - 1) : 0;
            const endLine = match[3] ? Math.max(0, parseInt(match[3], 10) - 1) : 0;
            
            if (filePath.length > 2) {
                locations.push({ filePath, startLine, endLine });
            }
        }
        
        return locations;
    } catch {
        return [];
    }
}

/**
 * Fallback parser: extracts file locations by matching context file basenames
 * mentioned in the response text. Only matches files that were actually in
 * the retrieval context to avoid hallucinated paths.
 */
export function parseInlineLocations(
    response: string,
    contextChunks: Array<{ filePath: string; startLine: number; endLine: number }>
): LocationData[] {
    const locations: LocationData[] = [];
    const seen = new Set<string>();

    for (const chunk of contextChunks) {
        if (seen.has(chunk.filePath)) {
            continue;
        }
        const parts = chunk.filePath.split(/[\\/]/);
        const basename = parts[parts.length - 1] ?? '';
        if (basename.length > 2 && response.includes(basename)) {
            seen.add(chunk.filePath);
            locations.push({
                filePath: chunk.filePath,
                startLine: chunk.startLine,
                endLine: chunk.endLine
            });
        }
    }

    return locations.slice(0, 5);
}

export function parseLocation(response: string): LocationData | null {
    const parsedLocations = parseAllLocations(response);
    if (parsedLocations.length > 0) {
        return parsedLocations[0];
    }
    return parseRegexLocation(response);
}
