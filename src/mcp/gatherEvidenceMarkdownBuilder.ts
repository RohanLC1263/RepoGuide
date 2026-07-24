/**
 * Renders a built EvidencePacket as clean, tiered **markdown** for the `gather_evidence`
 * MCP tool -- the format RepoGuide hands to the calling Claude model (Claude Desktop, etc.)
 * to reason over. This is the deliberate format decision behind gather_evidence (see the
 * tool's doc comment): a document, not a JSON blob, with headers per category, full fenced
 * code blocks for the top-ranked items, and pointer-only entries for the long tail (the same
 * rank-based tiering the JSON builder applies, expressed as document structure).
 *
 * It reuses buildGatherEvidenceResponse() so the cap/tier/trim logic lives in exactly one
 * place -- this module is pure presentation over that already-tiered data. The identical
 * markdown is returned in BOTH an inline TextContent block and an EmbeddedResource block by
 * mcpServer.ts (dual content block): Claude Desktop renders the text inline today, and the
 * resource upgrades to a visible attachment automatically if/when the client starts
 * surfacing EmbeddedResource, at zero additional cost now.
 */
import { EvidencePacket } from '../query/evidencePacket';
import {
    buildGatherEvidenceResponse,
    GATHER_FULL_CONTENT_ITEMS,
    GatherFact,
    GatherContext
} from './gatherEvidenceResponseBuilder';

/** Maps a file path to a markdown code-fence language hint. Best-effort by extension;
 * unknown extensions get no hint (a bare ``` fence), which renders fine. */
function fenceLanguage(file: string): string {
    const ext = (file.split('.').pop() || '').toLowerCase();
    const map: Record<string, string> = {
        ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
        py: 'python', java: 'java', go: 'go', rs: 'rust', rb: 'ruby',
        cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'cpp', c: 'c',
        cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin',
        json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown', sh: 'bash'
    };
    return map[ext] ?? '';
}

/** A fenced code block that won't be broken by content containing its own ``` fences:
 * pick a fence longer than any run of backticks inside the content. */
function safeFence(content: string, lang: string): string {
    let longest = 0;
    for (const m of content.matchAll(/`+/g)) { longest = Math.max(longest, m[0].length); }
    const ticks = '`'.repeat(Math.max(3, longest + 1));
    return `${ticks}${lang}\n${content}\n${ticks}`;
}

function loc(file: string, start: number, end: number): string {
    return end && end !== start ? `${file}:${start}-${end}` : `${file}:${start}`;
}

function renderFact(f: GatherFact, i: number): string {
    const head = `### ${i + 1}. \`${f.symbol || f.type}\` — ${loc(f.file, f.startLine, f.endLine)}`;
    const meta = `_signal: ${f.retrieval_signal} · confidence: ${f.confidence}${f.stale ? ' · ⚠ stale' : ''}_`;
    return `${head}\n${meta}\n\n${safeFence(f.content, fenceLanguage(f.file))}`;
}

function renderContext(c: GatherContext, i: number): string {
    const head = `### ${i + 1}. \`${c.symbol || c.type}\` — ${loc(c.file, c.startLine, c.endLine)}`;
    const meta = `_signal: ${c.retrieval_signal} · score: ${typeof c.score === 'number' ? c.score.toFixed(3) : c.score}${c.stale ? ' · ⚠ stale' : ''}_`;
    // Long-tail items (rank >= GATHER_FULL_CONTENT_ITEMS) are pointer-only: identify + Read,
    // no large fence -- the JSON builder already trimmed their content to the pointer cap.
    if (i >= GATHER_FULL_CONTENT_ITEMS) {
        return `${head}\n${meta}\n\n_Pointer only — Read ${loc(c.file, c.startLine, c.endLine)} for full content._`;
    }
    return `${head}\n${meta}\n\n${safeFence(c.content, fenceLanguage(c.file))}`;
}

export function buildGatherEvidenceMarkdown(
    packet: EvidencePacket,
    indexAge?: { lastIndexedAt?: string; ageSeconds?: number }
): string {
    const r = buildGatherEvidenceResponse(packet);
    const cov = r.coverage;

    const lines: string[] = [];
    lines.push(`# Evidence for: ${r.query}`);
    lines.push('');
    lines.push(`> ${r.guidance}`);
    lines.push('');

    lines.push('## Coverage');
    lines.push(`- **Grounding:** ${cov.sparse ? '⚠ THIN' : 'reasonable'} — ${cov.note}`);
    // Coverage score deliberately NOT displayed: it is matchedRequiredEvidence/
    // requiredEvidence count (0 when the plan enumerates none, i.e. most queries),
    // so it is not diagnostic of answer grounding and reads misleadingly low on
    // correct answers. The grounding line + fact/code counts below are the honest
    // signals. The raw score remains on the internal coverage object for telemetry.
    lines.push(`- **Deterministic facts:** ${cov.deterministicFactsReturned} returned / ${cov.deterministicFactsFound} found`);
    lines.push(`- **Code context:** ${cov.codeContextReturned} returned / ${cov.codeContextFound} found`);
    if (cov.matchedEvidenceTypes.length) { lines.push(`- **Matched evidence types:** ${cov.matchedEvidenceTypes.join(', ')}`); }
    if (cov.knownGaps.length) { lines.push(`- **Known gaps:** ${cov.knownGaps.join(', ')}`); }
    if (indexAge?.lastIndexedAt) { lines.push(`- **Index age:** last indexed ${indexAge.lastIndexedAt}${typeof indexAge.ageSeconds === 'number' ? ` (${indexAge.ageSeconds}s ago)` : ''}`); }
    lines.push('');

    lines.push('## Deterministic Facts');
    lines.push('_AST-derived, high-confidence structured facts. These cannot be "reasoned wrong" — prefer them._');
    lines.push('');
    if (r.deterministic_facts.length === 0) {
        lines.push('_None matched._');
    } else {
        r.deterministic_facts.forEach((f, i) => { lines.push(renderFact(f, i)); lines.push(''); });
    }
    lines.push('');

    lines.push('## Retrieved Code Context');
    lines.push('_Real code/graph/RAG chunks, relevance-ranked (lower certainty). Always Read the cited file:line before relying on a snippet — index content can lag the file._');
    lines.push('');
    if (r.retrieved_code_context.length === 0) {
        lines.push('_None matched._');
    } else {
        r.retrieved_code_context.forEach((c, i) => { lines.push(renderContext(c, i)); lines.push(''); });
    }

    return lines.join('\n');
}
