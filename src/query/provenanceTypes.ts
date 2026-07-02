import { CodeChunk } from '../store/storeTypes';

// ── Provenance Taxonomy ────────────────────────────────────────────────────

/**
 * Every piece of context assembled for a prompt belongs to one of these tiers.
 * The tiers are ordered from highest trust to lowest:
 *
 * 1. direct_code        — Actual source code from vector/keyword/symbol search
 * 2. graph_derived      — Call graph, behavioral path, import graph traversal
 * 3. synthesis_derived  — File/module/project understanding, concept map
 * 4. conversation_derived — Working set, history, accumulator boost
 * 5. cached             — QA cache hit (pre-computed, not re-derived)
 * 6. inferred           — Model's own reasoning (not tagged at retrieval)
 */
export type ProvenanceTier =
    | 'direct_code'
    | 'graph_derived'
    | 'synthesis_derived'
    | 'conversation_derived'
    | 'cached'
    | 'inferred';

export interface ProvenanceTag {
    tier: ProvenanceTier;
    /** Specific retrieval source, e.g. 'vector_search', 'call_graph', 'module_summary'. */
    source: string;
    /** Confidence in this context, 0–1. From health service or artifact confidence. */
    confidence: number;
    /** True if the health service reports this artifact as stale. */
    stale: boolean;
    /** Human-readable reason why this context may be outdated. */
    staleCaveat?: string;
}

export interface TaggedCodeChunk {
    chunk: CodeChunk;
    score: number;
    provenance: ProvenanceTag;
}

export interface TaggedContextBlock {
    /** Section label shown in the prompt, e.g. 'FILE UNDERSTANDING CONTEXT'. */
    label: string;
    /** Formatted text content of this block. */
    content: string;
    provenance: ProvenanceTag;
}

// ── Provenance Breakdown (stored with conversation history) ────────────────

export type EvidenceSourceType =
    | 'direct_code'
    | 'annotation'
    | 'community_summary'
    | 'note'
    | 'inferred';

export interface AnswerSource {
    id: string;
    source_type: EvidenceSourceType;
    file?: string;
    line_start?: number;
    line_end?: number;
    symbol?: string;
    source_excerpt?: string;
    confidence: number;
    is_stale: boolean;
    origin?: string;
    alignment_text: string;
}

export interface EvidenceClaim {
    id: string;
    claim_text: string;
    source_type: EvidenceSourceType;
    file?: string;
    line_start?: number;
    line_end?: number;
    symbol?: string;
    source_excerpt?: string;
    confidence: number;
    is_stale: boolean;
    alignment_reason: string;
}

export interface AnswerProvenance {
    answer_id: string;
    claims: EvidenceClaim[];
    sources: AnswerSource[];
    unsupported_claims: EvidenceClaim[];
    stale_sources: AnswerSource[];
}

export interface ProvenanceBreakdown {
    /** Files whose actual source code was shown to the model. */
    directCodeFiles: string[];
    /** Graph-derived sources used, e.g. ['call_graph', 'behavioral_path']. */
    graphDerivedSources: string[];
    /** Synthesis sources used, e.g. ['file_understanding', 'module_summary']. */
    synthesisSources: string[];
    /** Whether working set or conversation history contributed. */
    conversationDerived: boolean;
    /** Artifact names that were reported stale by the health service. */
    staleArtifacts: string[];
    timestamp: number;
}

// ── Factory helpers ────────────────────────────────────────────────────────

export function makeDirectCodeTag(source: string): ProvenanceTag {
    return { tier: 'direct_code', source, confidence: 1.0, stale: false };
}

export function makeGraphDerivedTag(source: string, confidence = 0.9, stale = false, staleCaveat?: string): ProvenanceTag {
    return { tier: 'graph_derived', source, confidence, stale, staleCaveat };
}

export function makeSynthesisTag(source: string, confidence = 0.8, stale = false, staleCaveat?: string): ProvenanceTag {
    return { tier: 'synthesis_derived', source, confidence, stale, staleCaveat };
}

export function makeConversationTag(source: string): ProvenanceTag {
    return { tier: 'conversation_derived', source, confidence: 0.7, stale: false };
}

export function makeCachedTag(): ProvenanceTag {
    return { tier: 'cached', source: 'qa_cache', confidence: 0.85, stale: false };
}

export function makeNoteTag(source: string, stale = false, staleCaveat?: string): ProvenanceTag {
    return { tier: 'direct_code', source, confidence: 1.0, stale, staleCaveat };
}

/**
 * Build a provenance breakdown from tagged chunks and blocks.
 * Called after answer generation, before storing in conversation history.
 */
export function buildProvenanceBreakdown(
    taggedChunks: TaggedCodeChunk[],
    taggedBlocks: TaggedContextBlock[],
    conversationDerived: boolean
): ProvenanceBreakdown {
    const directCodeFiles = new Set<string>();
    const graphDerivedSources = new Set<string>();
    const synthesisSources = new Set<string>();
    const staleArtifacts = new Set<string>();

    for (const tc of taggedChunks) {
        if (tc.provenance.tier === 'direct_code') {
            directCodeFiles.add(tc.chunk.filePath);
        } else if (tc.provenance.tier === 'graph_derived') {
            graphDerivedSources.add(tc.provenance.source);
        } else if (tc.provenance.tier === 'synthesis_derived') {
            synthesisSources.add(tc.provenance.source);
        }
        if (tc.provenance.stale) {
            staleArtifacts.add(tc.provenance.source);
        }
    }

    for (const tb of taggedBlocks) {
        if (tb.provenance.tier === 'graph_derived') {
            graphDerivedSources.add(tb.provenance.source);
        } else if (tb.provenance.tier === 'synthesis_derived') {
            synthesisSources.add(tb.provenance.source);
        }
        if (tb.provenance.stale) {
            staleArtifacts.add(tb.provenance.source);
        }
    }

    return {
        directCodeFiles: Array.from(directCodeFiles),
        graphDerivedSources: Array.from(graphDerivedSources),
        synthesisSources: Array.from(synthesisSources),
        conversationDerived,
        staleArtifacts: Array.from(staleArtifacts),
        timestamp: Date.now()
    };
}
