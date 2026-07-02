import { RepositoryContext } from '../context/repositoryContext';

import * as fs from 'fs';
import * as path from 'path';
import { streamChat } from '../ollama/inferencer';
import { AnnotationRole, FileAnnotation, FileAnnotationEngine } from '../comprehension/fileAnnotationEngine';
import { HybridRetrievalFusion } from './hybridRetrievalFusion';
import { embedText } from '../ollama/embedder';
import { PlanDocumentParser, ParsedPlanDocument } from './planDocumentParser';

const VALID_ROLES: AnnotationRole[] = [
    'entry_point', 'route_handler', 'service', 'model',
    'middleware', 'repository', 'utility', 'configuration',
    'interface', 'test', 'event_handler', 'worker', 'other'
];

const ROLE_SET = new Set<string>(VALID_ROLES);
const MATCH_THRESHOLD = 0.60;
const IMPLEMENTED_THRESHOLD = 0.65;

export type PlanItemStatus = 'implemented' | 'partial' | 'different' | 'missing' | 'unclear';

export interface PlanFeatureItem {
    id: string;
    name: string;
    description: string;
    expected_role: AnnotationRole;
    source_section?: string;
    source_page?: number;
}

export interface PlanEvidence {
    file: string;
    annotation_what?: string;
    key_symbols?: string[];
    similarity: number;
    reason: string;
}

export interface PlanAnalysisItem extends PlanFeatureItem {
    status: PlanItemStatus;
    matched_files: string[];
    match_confidence: number;
    deviation_note: string | null;
    evidence: PlanEvidence[];
}

export interface PlanAnalysisReport {
    plan_file: string;
    parsed_at: string;
    items: PlanAnalysisItem[];
    summary: {
        total_items: number;
        implemented: number;
        partial: number;
        different: number;
        missing: number;
        unclear: number;
        unplanned_files: number;
        unplanned_files_definition: string;
        completion_percentage: number;
    };
    warnings?: string[];
}

interface ScoredAnnotation {
    annotation: FileAnnotation;
    confidence: number;
    similarity: number;
    retrieved: boolean;
    reason: string;
}

export class PlanAnalyzer {
    private readonly annotationEngine: FileAnnotationEngine;
    private readonly parser: PlanDocumentParser;

    constructor(
        private readonly context: RepositoryContext,
        private readonly intentClassifier: any,
        private readonly hybridRetrieval: HybridRetrievalFusion
    ) {
        this.annotationEngine = new FileAnnotationEngine(context.repoguideDataDir || context.workspaceRoot, '', context.logger as any);
        this.parser = new PlanDocumentParser();
    }

    async analyze(planDocumentPath: string, workspaceRoot: string): Promise<PlanAnalysisReport> {
        const absolutePlanPath = path.resolve(planDocumentPath);
        const parsedDoc = await this.parser.parse(absolutePlanPath);
        const featureMap = await this.parsePlanIntoFeatureMap(parsedDoc.text, path.basename(absolutePlanPath));
        
        if (parsedDoc.sections.length > 0) {
            for (const item of featureMap) {
                const section = parsedDoc.sections.find(s => s.text.includes(item.name)) || parsedDoc.sections[0];
                item.source_section = section.heading;
                item.source_page = section.page_start;
            }
        }

        const allAnnotations = await this.annotationEngine.getAllAnnotations();
        const items: PlanAnalysisItem[] = [];

        for (const item of featureMap) {
            this.context.logger?.info(`[PlanAnalyzer] Matching plan item: ${item.name}`);
            const query = `${item.name}\n${item.description}`;
            const assembly = await this.hybridRetrieval.retrieveContext(query);
            const retrievedFiles = Array.from(new Set(assembly.chunks.map(chunk => chunk.chunk.filePath)));
            const candidates = collectCandidateAnnotations(retrievedFiles, allAnnotations, assembly.annotations);
            
            const matches = await this.scoreMatches(item, candidates);
            const validMatches = matches.filter(match => match.confidence >= MATCH_THRESHOLD)
                                        .sort((a, b) => b.confidence - a.confidence);

            if (validMatches.length === 0) {
                items.push({
                    ...item,
                    status: 'missing',
                    matched_files: [],
                    match_confidence: 0,
                    deviation_note: 'No retrieved file annotation matched the planned component above the confidence threshold.',
                    evidence: []
                });
                continue;
            }

            const best = validMatches[0];
            const evidence = validMatches.slice(0, 5).map(m => ({
                file: normalizeReportPath(m.annotation.file, workspaceRoot),
                annotation_what: m.annotation.what,
                key_symbols: m.annotation.key_symbols,
                similarity: roundConfidence(m.similarity),
                reason: m.reason
            }));

            let status: PlanItemStatus = 'unclear';
            let deviationNote: string | null = null;

            const isSemanticMatch = best.similarity >= IMPLEMENTED_THRESHOLD;
            const isRoleMatch = best.annotation.role === item.expected_role;

            if (isSemanticMatch && isRoleMatch) {
                if (best.annotation.confidence === 'high' || validMatches.length > 1) {
                    status = 'implemented';
                } else {
                    status = 'partial';
                    deviationNote = `Good semantic match, but implementation may be incomplete or low confidence.`;
                }
            } else if (isSemanticMatch && !isRoleMatch) {
                status = 'different';
                deviationNote = `Semantic match found, but purpose diverges (Expected: ${item.expected_role}, Found: ${best.annotation.role}).`;
            } else if (!isSemanticMatch && isRoleMatch) {
                status = 'partial';
                deviationNote = `Role matches, but semantic confidence is weak.`;
            } else {
                status = 'different';
                deviationNote = `Matched files mention related symbols, but annotation purpose diverges significantly. Best annotation: ${best.annotation.what}`;
            }

            items.push({
                ...item,
                status,
                matched_files: Array.from(new Set(evidence.map(e => e.file))),
                match_confidence: roundConfidence(best.confidence),
                deviation_note: deviationNote,
                evidence
            });
        }

        const allIndexedFiles = await this.hybridRetrieval.getIndexedFilePathsForAnalysis();
        const report = buildReport(path.basename(absolutePlanPath), items, allIndexedFiles, parsedDoc.warnings);
        
        const repoguideDir = this.context.repoguideDataDir || this.context.workspaceRoot;
        await fs.promises.mkdir(repoguideDir, { recursive: true });
        await fs.promises.writeFile(
            path.join(repoguideDir, 'plan_analysis.json'),
            JSON.stringify(report, null, 2),
            'utf8'
        );
        return report;
    }

    private async scoreMatches(item: PlanFeatureItem, candidates: Array<{ annotation: FileAnnotation; retrieved: boolean }>): Promise<ScoredAnnotation[]> {
        let itemVector: number[] | null = null;
        try {
            itemVector = await embedText(this.context, `${item.name} ${item.description}`);
        } catch (e) {
            this.context.logger?.info(`[PlanAnalyzer] Warning: Embedding failed for plan item, falling back to lexical. ${e}`);
        }

        const results: ScoredAnnotation[] = [];
        for (const candidate of candidates) {
            const { annotation, retrieved } = candidate;
            const symbolText = [...(annotation.key_symbols ?? []), ...(annotation.depends_on ?? [])].join(' ');
            const semanticText = [annotation.what, symbolText, annotation.role].join(' ');
            
            let similarity = 0;
            let usedSemantic = false;
            
            if (itemVector) {
                try {
                    const annVector = await embedText(this.context, semanticText);
                    similarity = cosineSimilarity(itemVector, annVector);
                    usedSemantic = true;
                } catch (e) {
                    // Fallback to lexical
                }
            }

            if (!usedSemantic) {
                const textSim = textSimilarity(item.description, annotation.what);
                const symSim = textSimilarity(`${item.name} ${item.description}`, semanticText);
                similarity = (textSim * 0.55) + (symSim * 0.45);
            }

            const roleBonus = annotation.role === item.expected_role ? 0.12 : 0;
            const confidenceBonus = annotation.confidence === 'high' ? 0.08 : annotation.confidence === 'medium' ? 0.04 : 0;
            const retrievalBonus = retrieved ? 0.08 : 0;

            const confidence = Math.min(1, similarity + roleBonus + confidenceBonus + retrievalBonus);
            
            const reason = usedSemantic 
                ? `Semantic similarity ${similarity.toFixed(2)} with role/retrieval bonuses applied.`
                : `Lexical similarity ${similarity.toFixed(2)} with role/retrieval bonuses applied (fallback).`;

            results.push({
                annotation,
                similarity,
                retrieved,
                confidence,
                reason
            });
        }
        return results;
    }

    private async parsePlanIntoFeatureMap(content: string, filename: string): Promise<PlanFeatureItem[]> {
        const messages = buildPlanParsingMessages(content, filename);
        let raw = '';
        try {
            for await (const token of streamChat(this.context, messages)) {
                raw += token;
            }
            return validateFeatureMap(parseJsonOnly(raw));
        } catch (e) {
            this.context.logger?.info(`[PlanAnalyzer] Model plan parse failed, using deterministic fallback: ${e}`);
            return parsePlanFallback(content);
        }
    }
}

function buildPlanParsingMessages(content: string, filename: string): Array<{ role: string; content: string }> {
    return [
        {
            role: 'system',
            content: [
                'You parse implementation plan documents into a feature map.',
                'Return ONLY valid JSON. No markdown. No prose. Start with { and end with }.',
                'Use this exact shape:',
                '{',
                '  "items": [',
                '    {',
                '      "id": "unique stable string",',
                '      "name": "component name",',
                '      "description": "what it should do",',
                `      "expected_role": "one of: ${VALID_ROLES.join(' | ')}"`,
                '    }',
                '  ]',
                '}'
            ].join('\n')
        },
        {
            role: 'user',
            content: [
                `Plan file: ${filename}`,
                '',
                'Plan document:',
                content.slice(0, 16000)
            ].join('\n')
        }
    ];
}

function parseJsonOnly(raw: string): unknown {
    const cleaned = raw.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
        throw new Error('Model did not return a JSON object.');
    }
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
}

function validateFeatureMap(parsed: unknown): PlanFeatureItem[] {
    const obj = parsed as { items?: unknown };
    if (!obj || !Array.isArray(obj.items)) {
        throw new Error('Feature map JSON must contain an items array.');
    }

    const seen = new Set<string>();
    return obj.items.map((item, index) => {
        const raw = item as Partial<PlanFeatureItem>;
        const id = sanitizeText(raw.id) || `item-${index + 1}`;
        const uniqueId = seen.has(id) ? `${id}-${index + 1}` : id;
        seen.add(uniqueId);

        const name = sanitizeText(raw.name);
        const description = sanitizeText(raw.description);
        if (!name || !description) {
            throw new Error('Each feature map item must include name and description.');
        }

        const expectedRole = ROLE_SET.has(String(raw.expected_role))
            ? raw.expected_role as AnnotationRole
            : 'other';

        return {
            id: uniqueId,
            name,
            description,
            expected_role: expectedRole
        };
    });
}

function parsePlanFallback(content: string): PlanFeatureItem[] {
    const lines = content.split(/\r?\n/);
    const items: PlanFeatureItem[] = [];
    for (const line of lines) {
        const match = line.match(/^\s*(?:[-*]|\d+\.)\s*(?:\*\*)?([^:]+?)(?:\*\*)?\s*:\s*(.+)$/);
        if (!match) continue;
        items.push({
            id: slugify(match[1]) || `item-${items.length + 1}`,
            name: match[1].trim(),
            description: match[2].trim(),
            expected_role: inferRole(match[1], match[2])
        });
    }
    if (items.length === 0) {
        throw new Error('Could not parse plan into feature map.');
    }
    return validateFeatureMap({ items });
}

function collectCandidateAnnotations(
    retrievedFiles: string[],
    allAnnotations: FileAnnotation[],
    assemblyAnnotations: FileAnnotation[]
): Array<{ annotation: FileAnnotation; retrieved: boolean }> {
    const byFile = new Map<string, { annotation: FileAnnotation; retrieved: boolean }>();
    const normalizedRetrieved = retrievedFiles.map(normalizePath);
    for (const annotation of [...assemblyAnnotations, ...allAnnotations]) {
        if (!annotation?.file) continue;
        const normalizedAnnotation = normalizePath(annotation.file);
        const retrieved = normalizedRetrieved.some(file =>
            file === normalizedAnnotation ||
            file.endsWith('/' + normalizedAnnotation) ||
            file.includes('/' + normalizedAnnotation)
        );
        const previous = byFile.get(annotation.file);
        byFile.set(annotation.file, {
            annotation,
            retrieved: retrieved || previous?.retrieved === true
        });
    }
    return Array.from(byFile.values());
}

function buildReport(planFile: string, items: PlanAnalysisItem[], allIndexedFiles: string[], warnings: string[] = []): PlanAnalysisReport {
    const implemented = items.filter(item => item.status === 'implemented').length;
    const partial = items.filter(item => item.status === 'partial').length;
    const different = items.filter(item => item.status === 'different').length;
    const missing = items.filter(item => item.status === 'missing').length;
    const unclear = items.filter(item => item.status === 'unclear').length;
    
    const matched = new Set(items.flatMap(item => item.matched_files).map(normalizePath));
    const unplannedFiles = allIndexedFiles.filter(file => !matched.has(normalizePath(file))).length;

    return {
        plan_file: planFile,
        parsed_at: new Date().toISOString(),
        items,
        summary: {
            total_items: items.length,
            implemented,
            partial,
            different,
            missing,
            unclear,
            unplanned_files: unplannedFiles,
            unplanned_files_definition: "Count of all indexed files in the LanceDB store that were not matched as evidence for any plan item.",
            completion_percentage: items.length === 0 ? 0 : Math.round((implemented / items.length) * 100)
        },
        warnings: warnings.length > 0 ? warnings : undefined
    };
}

function textSimilarity(a: string, b: string): number {
    const aTokens = tokenize(a);
    const bTokens = tokenize(b);
    if (aTokens.size === 0 || bTokens.size === 0) {
        return 0;
    }
    let intersection = 0;
    for (const token of aTokens) {
        if (bTokens.has(token)) intersection++;
    }
    const union = new Set([...aTokens, ...bTokens]).size;
    return union === 0 ? 0 : intersection / union;
}

function tokenize(text: string): Set<string> {
    const stop = new Set([
        'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'should',
        'must', 'will', 'component', 'feature', 'support', 'handles', 'handle',
        'management', 'system', 'code', 'file', 'actual', 'planned', 'plan'
    ]);
    const normalized = text
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .filter(token => token.length > 2 && !stop.has(token))
        .map(stemToken);
    return new Set(normalized);
}

function stemToken(token: string): string {
    if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3);
    if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
    if (token.endsWith('es') && token.length > 4) return token.slice(0, -2);
    if (token.endsWith('s') && token.length > 4) return token.slice(0, -1);
    return token;
}

function inferRole(name: string, description: string): AnnotationRole {
    const text = `${name} ${description}`.toLowerCase();
    if (/\b(config|configuration|option|setting)\b/.test(text)) return 'configuration';
    if (/\b(test|spec)\b/.test(text)) return 'test';
    if (/\b(model|schema|type)\b/.test(text)) return 'model';
    if (/\bmiddleware\b/.test(text)) return 'middleware';
    if (/\bworker|background\b/.test(text)) return 'worker';
    if (/\binterface|api contract\b/.test(text)) return 'interface';
    if (/\bentry|command|cli\b/.test(text)) return 'entry_point';
    if (/\broute|handler\b/.test(text)) return 'route_handler';
    if (/\bhelper|build|parse|format|url|header|utility|utils\b/.test(text)) return 'utility';
    return 'service';
}

function sanitizeText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase();
}

function normalizeReportPath(filePath: string, workspaceRoot: string): string {
    if (path.isAbsolute(filePath)) {
        return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
    }
    return filePath.replace(/\\/g, '/');
}

function roundConfidence(value: number): number {
    return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0.0;
    let normA = 0.0;
    let normB = 0.0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
