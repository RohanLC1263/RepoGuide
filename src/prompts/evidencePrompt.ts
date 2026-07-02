import { EvidencePacket, EvidenceItem } from '../query/evidencePacket';
import { Message } from '../query/conversationHistory';

export function buildEvidenceMessages(packet: EvidencePacket, history: Message[] = []): Array<{ role: string; content: string }> {
    const systemPrompt = [
        'You are an evidence-based answer synthesizer.',
        'Your only job is to answer the user\'s query strictly using the provided Evidence Packet.',
        '',
        'CRITICAL RULES:',
        '1. STRICT EXTRACTOR: You are a strict extraction bot. You only extract facts that are literally present in the Evidence Packet.',
        '2. NO GUESSING: If the exact answer (like a specific number, quote, or list of steps) is NOT explicitly written in the Evidence Packet, you MUST output the exact phrase "evidence does not determine". Do NOT guess or use pre-trained knowledge.',
        '3. DO NOT USE QUOTATION MARKS ("") in your answer. Paraphrase instead of quoting. Do not invent any quotes.',
        '4. CITATIONS REQUIRED: Cite your evidence using the item id e.g. [id: 123].',
        '5. NO HALLUCINATION: If a specific symbol or function is queried and it is NOT in the evidence, say "evidence does not determine".',
        '6. MANDATORY GAP DISCLOSURE: If KNOWN GAPS are provided, you MUST explicitly state them.',
        '7. DO NOT OUTPUT NUMBERS unless they are literally in the Evidence Packet.',
        '',
        '--- STRUCTURAL EVIDENCE ---',
        formatPacket(packet)
    ].join('\n');

    const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: systemPrompt }];
    for (const message of history) {
        messages.push({ role: message.role, content: message.content });
    }
    messages.push({ role: 'user', content: packet.query });
    return messages;
}

function formatPacket(packet: EvidencePacket): string {
    const lines: string[] = [];
    
    // Warn about staleness if any item is stale
    const isStale = packet.items.some(i => i.stale) || packet.facts.some(f => f.stale);
    if (isStale) {
        lines.push('WARNING: Some evidence items in this packet are marked as STALE. The answer must explicitly mention this staleness warning to the user.');
        lines.push('');
    }

    if (packet.gaps && packet.gaps.length > 0) {
        lines.push('KNOWN GAPS:');
        for (const gap of packet.gaps) {
            lines.push(`- ${gap}`);
        }
        lines.push('');
        lines.push('CRITICAL MANDATE: Because there are KNOWN GAPS in this packet, you MUST include the exact phrase "evidence does not determine" in your response.');
        lines.push('');
    }

    lines.push('EVIDENCE FACTS:');
    if (packet.facts.length === 0) {
        lines.push('(No explicit facts extracted)');
    } else {
        const sortedFacts = [...packet.facts].sort((a, b) => b.score - a.score);
        for (const fact of sortedFacts.slice(0, 50)) {
            lines.push(formatItem(fact));
        }
    }
    lines.push('');

    lines.push('EVIDENCE CHUNKS:');
    if (packet.items.length === 0) {
        lines.push('(No code chunks retrieved)');
    } else {
        const sortedItems = [...packet.items].sort((a, b) => b.score - a.score);
        for (const item of sortedItems.slice(0, 30)) {
            lines.push(formatItem(item));
        }
    }

    return lines.join('\n');
}

function formatItem(item: EvidenceItem): string {
    const staleMarker = item.stale ? ' [STALE]' : '';
    const header = `--- Item [id: ${item.id}] | ${item.file}:${item.startLine}-${item.endLine} | Type: ${item.type}${staleMarker} ---`;
    return `${header}\n${item.content}\n`;
}
