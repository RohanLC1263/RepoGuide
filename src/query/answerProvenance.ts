import * as fs from 'fs';
import * as path from 'path';
import type { FileAnnotation } from '../comprehension/fileAnnotationEngine';
import type { CommunitySummary } from '../comprehension/communityClustering';
import type { FusedChunk } from './hybridRetrievalFusion';
import type {
    AnswerProvenance,
    AnswerSource,
    EvidenceClaim,
    EvidenceSourceType,
    TaggedContextBlock
} from './provenanceTypes';

interface InventoryInput {
    chunks: FusedChunk[];
    annotations: FileAnnotation[];
    communities: CommunitySummary[];
    taggedBlocks?: TaggedContextBlock[];
    repoguideDir?: string;
}

interface AlignmentCandidate {
    source: AnswerSource;
    score: number;
    tokenOverlap: number;
    fileMention: boolean;
    symbolOverlap: boolean;
    lineOverlap: boolean;
}

const STOP_WORDS = new Set([
    'about', 'after', 'again', 'also', 'because', 'before', 'being', 'between',
    'could', 'does', 'from', 'have', 'here', 'into', 'like', 'lines', 'more',
    'that', 'their', 'there', 'these', 'this', 'through', 'what', 'when',
    'where', 'which', 'with', 'would', 'your'
]);

export function buildAnswerSourceInventory(input: InventoryInput): AnswerSource[] {
    const hashRegistry = loadHashRegistry(input.repoguideDir);
    const health = loadUnderstandingHealth(input.repoguideDir);
    const sources: AnswerSource[] = [];
    const seen = new Set<string>();

    for (const item of input.chunks) {
        const source: AnswerSource = {
            id: `code:${item.chunk.id}`,
            source_type: 'direct_code',
            file: item.chunk.filePath,
            line_start: item.chunk.startLine + 1,
            line_end: item.chunk.endLine + 1,
            source_excerpt: trimExcerpt(item.chunk.text),
            confidence: 1.0,
            is_stale: false,
            origin: 'retrieval',
            alignment_text: [item.chunk.filePath, item.chunk.text].join('\n')
        };
        addSource(sources, seen, source);
    }

    for (const annotation of input.annotations) {
        const isStale = isAnnotationStale(annotation, hashRegistry);
        const source: AnswerSource = {
            id: `annotation:${annotation.hash}:${annotation.file}`,
            source_type: 'annotation',
            file: annotation.file,
            symbol: annotation.key_symbols?.[0],
            source_excerpt: annotation.what,
            confidence: annotationConfidence(annotation.confidence),
            is_stale: isStale,
            origin: 'file_annotation',
            alignment_text: [
                annotation.file,
                annotation.what,
                annotation.role,
                ...(annotation.key_symbols ?? []),
                ...(annotation.depends_on ?? []),
                ...(annotation.signals ?? [])
            ].join(' ')
        };
        addSource(sources, seen, source);
    }

    const communityFresh = health?.artifacts?.['community_summaries.json']?.fresh;
    for (const community of input.communities) {
        const source: AnswerSource = {
            id: `community:${community.id}`,
            source_type: 'community_summary',
            file: community.central_file,
            source_excerpt: community.summary,
            confidence: communityFresh === false ? 0.65 : 0.8,
            is_stale: communityFresh === false,
            origin: `community_summary:${community.name}`,
            alignment_text: [
                community.name,
                community.central_file,
                community.summary,
                ...community.files
            ].join(' ')
        };
        addSource(sources, seen, source);
    }

    for (const block of input.taggedBlocks ?? []) {
        let sourceType: EvidenceSourceType = 'inferred';
        if (block.provenance.source === 'developer_note' || block.provenance.source === 'chat_distilled_note') {
            sourceType = 'note';
        } else if (block.provenance.tier === 'synthesis_derived') {
            sourceType = 'annotation';
        }
        const source: AnswerSource = {
            id: `block:${block.label}:${sources.length}`,
            source_type: sourceType,
            source_excerpt: trimExcerpt(block.content),
            confidence: block.provenance.confidence,
            is_stale: block.provenance.stale,
            origin: block.provenance.source,
            alignment_text: [block.label, block.content].join('\n')
        };
        addSource(sources, seen, source);
    }

    return sources;
}

export function buildAnswerProvenance(
    answerId: string,
    answerText: string,
    sources: AnswerSource[]
): AnswerProvenance {
    const sentences = extractClaims(answerText);
    const claims = sentences.map((sentence, index) => alignClaim(sentence, index, sources));
    const unsupported = claims.filter(claim => claim.source_type === 'inferred');
    const staleSources = sources.filter(source => source.is_stale);

    return {
        answer_id: answerId,
        claims,
        sources,
        unsupported_claims: unsupported,
        stale_sources: staleSources
    };
}

function alignClaim(sentence: string, index: number, sources: AnswerSource[]): EvidenceClaim {
    const ranked = sources
        .map(source => scoreSource(sentence, source))
        .sort((a, b) => b.score - a.score);
    const best = ranked[0];

    if (!best || best.score < 2.6 || !hasConcreteAlignment(best)) {
        return {
            id: `claim_${index + 1}`,
            claim_text: sentence,
            source_type: 'inferred',
            confidence: 0.35,
            is_stale: false,
            alignment_reason: 'No retrieved source met deterministic alignment thresholds.'
        };
    }

    return {
        id: `claim_${index + 1}`,
        claim_text: sentence,
        source_type: best.source.source_type,
        file: best.source.file,
        line_start: best.source.line_start,
        line_end: best.source.line_end,
        symbol: best.source.symbol,
        source_excerpt: best.source.source_excerpt,
        confidence: Math.min(best.source.confidence, Math.max(0.45, Math.min(0.98, best.score / 7))),
        is_stale: best.source.is_stale,
        alignment_reason: describeAlignment(best)
    };
}

function scoreSource(sentence: string, source: AnswerSource): AlignmentCandidate {
    const lower = sentence.toLowerCase();
    const sourceTokens = tokenize(source.alignment_text);
    const sentenceTokens = Array.from(tokenize(sentence));
    const overlapCount = sentenceTokens.filter(token => sourceTokens.has(token)).length;
    const tokenOverlap = sentenceTokens.length > 0 ? overlapCount / sentenceTokens.length : 0;
    const fileMention = !!source.file && mentionsFile(lower, source.file);
    const symbolOverlap = !!source.symbol && lower.includes(source.symbol.toLowerCase());
    const lineOverlap = hasLineOverlap(sentence, source);

    let score = tokenOverlap * 4;
    if (fileMention) {
        score += 3.5;
        if (source.source_type === 'direct_code') {
            score += 2.5;
        }
    }
    if (symbolOverlap) {
        score += 1.5;
    }
    if (lineOverlap) {
        score += 2.0;
    }
    if (source.source_type === 'direct_code' && tokenOverlap >= 0.18) {
        score += 0.75;
    }
    if ((source.source_type === 'annotation' || source.source_type === 'community_summary') && tokenOverlap >= 0.14) {
        score += 0.5;
    }

    return { source, score, tokenOverlap, fileMention, symbolOverlap, lineOverlap };
}

function hasConcreteAlignment(candidate: AlignmentCandidate): boolean {
    if (candidate.fileMention || candidate.lineOverlap) {
        return true;
    }
    if (candidate.tokenOverlap >= 0.18) {
        return true;
    }
    return candidate.symbolOverlap && candidate.tokenOverlap >= 0.12;
}

function describeAlignment(candidate: AlignmentCandidate): string {
    const reasons: string[] = [];
    if (candidate.fileMention) {
        reasons.push('file path mention');
    }
    if (candidate.symbolOverlap) {
        reasons.push('symbol overlap');
    }
    if (candidate.lineOverlap) {
        reasons.push('line range overlap');
    }
    if (candidate.tokenOverlap > 0) {
        reasons.push(`token overlap ${candidate.tokenOverlap.toFixed(2)}`);
    }
    return reasons.length > 0 ? reasons.join(', ') : 'best deterministic source match';
}

function extractClaims(answerText: string): string[] {
    const withoutLocations = answerText.replace(/\n?(?:LOCATIONS:|### Locations)\s*\n?[\s\S]*$/mi, '');
    const normalized = withoutLocations
        .replace(/\r/g, '')
        .split(/\n+/)
        .map(line => line.replace(/^[-*\d.]+\s+/, '').trim())
        .filter(line => line.length > 0 && !/^[A-Z][A-Z\s]+:$/.test(line))
        .join(' ');

    return normalized
        .split(/(?<=[.!?])\s+/)
        .map(sentence => sentence.trim())
        .filter(sentence => sentence.length >= 24)
        .slice(0, 20);
}

function tokenize(text: string): Set<string> {
    const tokens = text
        .toLowerCase()
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/[^a-z0-9_./-]+/)
        .flatMap(token => token.split(/[./-]/))
        .map(token => token.trim())
        .filter(token => token.length >= 3 && !STOP_WORDS.has(token));
    return new Set(tokens);
}

function mentionsFile(lowerSentence: string, filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    const base = path.basename(normalized);
    return lowerSentence.includes(normalized) || lowerSentence.includes(base);
}

function hasLineOverlap(sentence: string, source: AnswerSource): boolean {
    if (source.line_start === undefined || source.line_end === undefined) {
        return false;
    }
    const ranges = Array.from(sentence.matchAll(/\b(?:lines?|l)\s*(\d+)(?:\s*[-:]\s*(\d+))?/gi));
    return ranges.some(match => {
        const start = Number(match[1]);
        const end = Number(match[2] ?? match[1]);
        return start <= source.line_end! && end >= source.line_start!;
    });
}

function addSource(sources: AnswerSource[], seen: Set<string>, source: AnswerSource): void {
    const key = [
        source.source_type,
        source.file ?? '',
        source.line_start ?? '',
        source.line_end ?? '',
        source.symbol ?? '',
        source.id
    ].join(':');
    if (seen.has(key)) {
        return;
    }
    seen.add(key);
    sources.push(source);
}

function trimExcerpt(text: string | undefined): string | undefined {
    if (!text) {
        return undefined;
    }
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length <= 400 ? normalized : `${normalized.slice(0, 397)}...`;
}

function annotationConfidence(confidence: FileAnnotation['confidence']): number {
    if (confidence === 'high') {
        return 0.9;
    }
    if (confidence === 'medium') {
        return 0.7;
    }
    return 0.45;
}

function isAnnotationStale(annotation: FileAnnotation, hashRegistry: Record<string, string>): boolean {
    const normalizedAnnotation = normalizePath(annotation.file);
    const match = Object.entries(hashRegistry).find(([file]) => {
        const normalizedFile = normalizePath(file);
        return normalizedFile === normalizedAnnotation ||
            normalizedFile.endsWith('/' + normalizedAnnotation) ||
            normalizedAnnotation.endsWith('/' + normalizedFile);
    });
    return !!match && match[1] !== annotation.hash;
}

function loadHashRegistry(repoguideDir?: string): Record<string, string> {
    if (!repoguideDir) {
        return {};
    }
    const hashesPath = path.join(repoguideDir, 'file_hashes.json');
    if (!fs.existsSync(hashesPath)) {
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(hashesPath, 'utf8')) as Record<string, string>;
    } catch {
        return {};
    }
}

function loadUnderstandingHealth(repoguideDir?: string): any {
    if (!repoguideDir) {
        return null;
    }
    const healthPath = path.join(repoguideDir, 'understanding', 'understanding_health.json');
    if (!fs.existsSync(healthPath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(healthPath, 'utf8'));
    } catch {
        return null;
    }
}

function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}
