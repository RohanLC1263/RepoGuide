import { CodeChunk } from '../store/storeTypes';

export function buildDocPrompt(chunksByFolder: Map<string, CodeChunk[]>): Array<{role: string, content: string}> {
    const messages: Array<{role: string, content: string}> = [];
    
    messages.push({
        role: 'system',
        content: "You are a technical documentation assistant. Generate a structured project overview. Respond in this exact structure: PROJECT OVERVIEW, TECH STACK, ARCHITECTURE, MODULES (one paragraph per folder), ENTRY POINTS, KEY FILES. Base your response strictly on the provided code. Do not invent details."
    });

    let userContent = "";
    for (const [folder, chunks] of chunksByFolder.entries()) {
        userContent += `## ${folder}\n`;
        for (const chunk of chunks) {
            userContent += `${chunk.text}\n---\n`;
        }
    }

    messages.push({
        role: 'user',
        content: userContent
    });

    return messages;
}
