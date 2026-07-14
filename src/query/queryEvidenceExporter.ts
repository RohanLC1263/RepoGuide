import * as fs from 'fs';
import * as path from 'path';
import { EvidenceItem, EvidencePacket } from './evidencePacket';
import { GateResult } from './answerGate';

/**
 * Exports the evidence behind a chat/MCP answer to a small workspace file, so
 * a connected Claude Code (MCP) session can reuse it directly instead of
 * rediscovering the same context independently -- see the MCP capability
 * investigation and the query-evidence-export design that followed it.
 *
 * Extracted as a standalone, side-effect-free module (buildEntry) plus a thin
 * file-I/O function (exportQueryEvidence), the same pattern as
 * askRepoguideTokenProcessor.ts/dependentsResponseBuilder.ts: mcpServer.ts
 * can't be imported into a test process, and this way queryDispatcher.ts's
 * own tests don't need real disk I/O just to exercise entry-building logic.
 *
 * References only, never evidence content: index-time chunk text can lag the
 * real file (no live reindex -- see README.md's MCP section), so exporting
 * it would invite exactly the "generate from stale text" failure mode the
 * MCP workflow guidance warns against; a caller Reads the real file itself.
 * This also means there is no redaction concern to introduce -- file paths,
 * line ranges, and symbol names cannot carry a redacted .env value through,
 * since there is no content field for one to hide in.
 */

export const QUERY_EVIDENCE_SCHEMA = 'repoguide.query_evidence.v1';
export const QUERY_EVIDENCE_MAX_ENTRIES = 10;
export const QUERY_EVIDENCE_FILENAME = 'last_query_evidence.json';

/**
 * Per-KIND reference cap ('item' and 'fact' each get their own budget), not a
 * flat cap on the combined array -- live-tested finding: a flat slice(0, 50)
 * on `[...items, ...facts]` (items always listed first) would return ZERO
 * fact references whenever items alone exceed the cap, which is exactly
 * what CraftConnect's real stored entries do (109/352 and 128/374
 * items/facts) -- silently dropping an entire evidence kind, not just
 * trimming volume. 25 per kind (50 total per entry) mirrors this week's
 * other MCP list caps (citation ranking at 25, the aggregate item cap at
 * 50) and was checked against real data: get_current_timestamp/
 * confidence_threshold-shaped queries return well under 25 of either kind,
 * so this only bites on genuinely broad answers, matching the ones that
 * overflowed live (219,992 chars for 2 entries, cut to ~26KB at this cap).
 */
export const QUERY_EVIDENCE_MAX_REFERENCES_PER_KIND = 25;

/**
 * Keep-first per kind, not a re-ranking pass: `packet.items`/`packet.facts`
 * (the source `toReferences()` iterates) are already relevance-sorted by
 * EvidencePacketBuilder.rankItems (confidence -> score -> role) before
 * queryDispatcher.ts ever calls buildEntry, so the array head already IS
 * the most-relevant subset -- capping here doesn't discard anything a
 * re-ranking pass would have kept instead. Exported so
 * lastChatEvidenceResponseBuilder.ts (mcpServer.ts's get_last_chat_evidence
 * response path) can apply the identical cap to entries already on disk
 * from before this fix, without needing a new write to take effect.
 */
export function capReferencesByKind(
    references: QueryEvidenceReference[],
    maxPerKind: number = QUERY_EVIDENCE_MAX_REFERENCES_PER_KIND
): QueryEvidenceReference[] {
    const counts: Record<'item' | 'fact', number> = { item: 0, fact: 0 };
    const out: QueryEvidenceReference[] = [];
    for (const ref of references) {
        if (counts[ref.kind] >= maxPerKind) {
            continue;
        }
        counts[ref.kind]++;
        out.push(ref);
    }
    return out;
}

export interface QueryEvidenceReference {
    file: string;
    startLine: number;
    endLine: number;
    symbol?: string;
    type: string;
    kind: 'item' | 'fact';
}

export interface QueryEvidenceEntry {
    schema: typeof QUERY_EVIDENCE_SCHEMA;
    question: string;
    answer: string;
    answeredAt: string;
    client: 'vscode' | 'mcp';
    decomposed: boolean;
    gateStatus: {
        outcome: GateResult['outcome'];
        mode: EvidencePacket['plan']['confidence_mode'];
    };
    coverageScore: number;
    references: QueryEvidenceReference[];
}

function referenceKey(file: string, startLine: number, endLine: number): string {
    return `${file}:${startLine}:${endLine}`;
}

function toReferences(items: EvidenceItem[], kind: 'item' | 'fact', seen: Set<string>): QueryEvidenceReference[] {
    const out: QueryEvidenceReference[] = [];
    for (const item of items) {
        const key = referenceKey(item.file, item.startLine, item.endLine);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push({
            file: item.file,
            startLine: item.startLine,
            endLine: item.endLine,
            symbol: item.symbol,
            type: item.type,
            kind
        });
    }
    return out;
}

/**
 * Pure entry builder. `gateResult` is expected to already reflect any
 * decomposition-outcome correction the caller applies -- see
 * queryDispatcher.ts's emitFinalAnswer, which computes the same corrected
 * status for its own gateStatus token. A raw decomposed GateResult can read
 * 'block' even when real, individually-verified content was actually
 * delivered via the sectioned fallback; this export must not mislead a
 * consumer into discarding real delivered content as blocked.
 */
export function buildEntry(
    question: string,
    answer: string,
    packet: EvidencePacket,
    gateResult: GateResult,
    client: 'vscode' | 'mcp',
    decomposed: boolean,
    now: Date = new Date()
): QueryEvidenceEntry {
    const seen = new Set<string>();
    const references = [
        ...toReferences(packet.items, 'item', seen),
        ...toReferences(packet.facts, 'fact', seen)
    ];

    return {
        schema: QUERY_EVIDENCE_SCHEMA,
        question,
        answer,
        answeredAt: now.toISOString(),
        client,
        decomposed,
        gateStatus: {
            outcome: gateResult.outcome,
            mode: packet.plan.confidence_mode
        },
        coverageScore: packet.coverageScore,
        references: capReferencesByKind(references)
    };
}

/**
 * Reads the rolling history file -- used both by exportQueryEvidence (to
 * prepend the new entry) and by mcpServer.ts's get_last_chat_evidence tool
 * (a read-only path a connected agent calls proactively). A missing or
 * corrupt file, or one that no longer parses to an array, returns an empty
 * array rather than throwing.
 */
export async function readQueryEvidence(repoguideDir: string): Promise<QueryEvidenceEntry[]> {
    const filePath = path.join(repoguideDir, QUERY_EVIDENCE_FILENAME);
    try {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Reads the rolling history file, prepends the new entry (newest first),
 * caps at QUERY_EVIDENCE_MAX_ENTRIES, and rewrites the whole file. A missing
 * or corrupt existing file starts fresh rather than throwing -- this export
 * must never be able to break answer delivery (callers additionally wrap
 * this in try/catch, since even mkdir/writeFile can fail on a read-only or
 * full disk). Whole-file rewrite is a last-writer-wins simplification across
 * concurrent chat/MCP writers, accepted for a single-user local tool rather
 * than engineered around.
 */
export async function exportQueryEvidence(repoguideDir: string, entry: QueryEvidenceEntry): Promise<void> {
    const filePath = path.join(repoguideDir, QUERY_EVIDENCE_FILENAME);
    const existing = await readQueryEvidence(repoguideDir);
    const updated = [entry, ...existing].slice(0, QUERY_EVIDENCE_MAX_ENTRIES);
    await fs.promises.mkdir(repoguideDir, { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(updated, null, 2), 'utf8');
}
