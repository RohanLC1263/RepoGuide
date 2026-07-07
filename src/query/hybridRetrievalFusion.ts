
import * as fs from 'fs';
import * as path from 'path';
import { Bm25Store } from '../store/bm25Store';
import { LanceStore } from '../store/lanceStore';
import { PageRankGraph } from '../indexing/pageRankGraphBuilder';
import { FileAnnotationEngine, FileAnnotation } from '../comprehension/fileAnnotationEngine';
import { CommunityClusteringOutput, CommunitySummary } from '../comprehension/communityClustering';
import { embedText } from '../ollama/embedder';
import { IntentClassifier } from './intentClassifier';
import { CodeChunk, SymbolEntry } from '../store/storeTypes';
import { SymbolIndex } from '../indexing/symbolIndex';
import { isOnboardingQuestion } from '../prompts/chatPrompt';
import { StrategyRouter } from './strategyRouter';
import { trimToTokenBudget } from './tokenBudget';
import { ImportGraphSearcher } from '../comprehension/importGraphSearcher';
import { ConceptMapSearcher } from '../comprehension/conceptMapSearcher';
import { ComprehensionEngine } from '../comprehension/comprehensionEngine';
import { ConversationHistory, Message } from './conversationHistory';
import { NotesManager } from '../notes/notesManager';
import { RepositoryContext } from '../context/repositoryContext';
import { AnswerMetadata } from './answerMetadata';

export interface HybridFusionConfig {
    bm25Weight: number;
    vectorWeight: number;
    pagerankWeight: number;
}

export interface FusedChunk {
    chunk: CodeChunk;
    score: number;
    rank: number;
}

export interface HybridContextAssembly {
    chunks: FusedChunk[];
    annotations: FileAnnotation[];
    communities: CommunitySummary[];
    /** Channels that errored (not just "found nothing") during this retrieval,
     * and were weighted meaningfully by the routed strategy -- e.g. a Lance
     * IO error on the vector channel of a query weighted vectorWeight: 0.6.
     * Populated regardless of whether other channels still returned results,
     * so a total per-channel failure doesn't get silently absorbed into an
     * overall "success" just because a sibling channel worked. */
    degradedChannels: DegradedChannel[];
}

export interface DegradedChannel {
    channel: 'bm25' | 'vector' | 'pagerank';
    weight: number;
    error: string;
    /** True when the error looks like store-level corruption (e.g. a Lance
     * manifest referencing a data fragment that no longer exists on disk) --
     * a real, on-disk data-integrity problem that a retry won't fix, rather
     * than a transient failure. Callers use this to give a materially
     * different (more actionable, "run Re-sync Index") message. */
    isCorruption: boolean;
}

/** Below this weight, a channel's failure isn't worth surfacing as a gap --
 * the routed strategy already didn't expect it to contribute meaningfully. */
const DEGRADED_CHANNEL_WEIGHT_THRESHOLD = 0.4;

/** Matches LanceDB's own error shape for a manifest referencing a data
 * fragment that's missing from disk (`LanceError(IO): External error: Not
 * found: .../<uuid>.lance`) -- confirmed, real symptom from manual testing.
 * Investigated at length (see HALLUCINATION_INVESTIGATION_REPORT.md-adjacent
 * work): the underlying cause was never conclusively reproduced (ruled out
 * OneDrive sync and RepoGuide's own file-watcher; a targeted concurrent
 * read-during-write race test at real corpus scale did not reproduce it
 * either). Since the actual trigger can't be fixed with confidence, this
 * detects the *symptom* directly and treats it as data corruption needing a
 * reindex, the same way other corrupted/missing artifacts are already
 * handled -- rather than continuing to silently return empty results. */
export function isLanceCorruptionError(message: string): boolean {
    return /LanceError\(IO\)/i.test(message) && /not found/i.test(message);
}

/** Pure function, extracted for direct unit testing without needing to mock
 * retrieveContext()'s full dependency chain (IntentClassifier, StrategyRouter,
 * etc.) -- filters channel errors down to the ones weighted meaningfully by
 * the routed strategy's config. */
export function computeDegradedChannels(
    channelErrors: Array<{ channel: DegradedChannel['channel']; error: string }>,
    config: HybridFusionConfig
): DegradedChannel[] {
    const channelWeights: Record<DegradedChannel['channel'], number> = {
        bm25: config.bm25Weight,
        vector: config.vectorWeight,
        pagerank: config.pagerankWeight
    };
    return channelErrors
        .filter(ce => channelWeights[ce.channel] >= DEGRADED_CHANNEL_WEIGHT_THRESHOLD)
        .map(ce => ({
            channel: ce.channel,
            weight: channelWeights[ce.channel],
            error: ce.error,
            isCorruption: isLanceCorruptionError(ce.error)
        }));
}

// Generic terms to skip for symbol lookup and definition bonus
const GENERIC_PLANNER_TERMS = new Set([
    'data', 'type', 'value', 'name', 'list', 'item', 'result', 'error',
    'state', 'action', 'event', 'handler', 'config', 'option', 'options',
    'input', 'output', 'response', 'request', 'message', 'node', 'path',
    'file', 'module', 'source', 'target', 'context', 'model', 'service',
    'test', 'spec', 'mock', 'util', 'utils', 'helper', 'core', 'base',
    'index', 'main', 'app', 'init', 'setup', 'start', 'stop', 'run',
    'process', 'create', 'update', 'delete', 'remove', 'fetch', 'load',
    'save', 'send', 'read', 'write', 'parse', 'format', 'build', 'make'
]);

const SYMBOL_LOOKUP_STOPWORDS = new Set([
    'handled', 'handle', 'used', 'called', 'defined', 'created',
    'implemented', 'where', 'what', 'how', 'why', 'find', 'show',
    'get', 'set', 'is', 'are', 'the', 'this', 'that', 'deleted',
    'just', 'some', 'files', 'file', 'can', 'trace'
]);

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase();
}

export class HybridRetrievalFusion {
    private fileAnnotationEngine: FileAnnotationEngine;
    /** Reset at the start of every retrieveContext() call; not safe for
     * concurrent calls on the same instance (matching this class's existing
     * single-query-at-a-time usage pattern elsewhere in this file). */
    private channelErrors: Array<{ channel: DegradedChannel['channel']; error: string }> = [];

    constructor(
        private store: LanceStore,
        private bm25Store: Bm25Store,
        private repoguideDir: string,
        private workspaceRoot: string,
        private intentClassifier: IntentClassifier,
        private context: RepositoryContext,
        private symbolIndex?: SymbolIndex,
        private importGraphSearcher?: ImportGraphSearcher,
        private comprehensionEngine?: ComprehensionEngine,
        private history?: ConversationHistory,
        private notesManager?: NotesManager
    ) {
        this.fileAnnotationEngine = new FileAnnotationEngine(this.repoguideDir, this.workspaceRoot, this.context);
    }

    async retrieveContext(
        question: string,
        seedFiles: string[] = [],
        preferredAnnotationSignals: string[] = []
    ): Promise<HybridContextAssembly> {
        this.channelErrors = [];

        // 1. Intent Classification & Strategy Routing
        const classified = await this.intentClassifier.classify(question);
        const router = new StrategyRouter('http://127.0.0.1:11434', 'llama3', this.context);
        const routedStrategy = await router.route(question, classified);

        let config: HybridFusionConfig = {
            bm25Weight: 0.2,
            vectorWeight: 0.6,
            pagerankWeight: 0.4
        };

        if (['symbol_lookup', 'configuration_lookup', 'targeted_extraction'].includes(routedStrategy.strategy)) {
            config = { bm25Weight: 0.7, vectorWeight: 0.3, pagerankWeight: 0.4 };
        } else if (routedStrategy.strategy === 'flow_tracing') {
            config = { bm25Weight: 0.2, vectorWeight: 0.3, pagerankWeight: 0.6 };
        }

        this.context.logger.info(`[HybridRetrieval] Strategy: ${routedStrategy.strategy}. Weights: BM25=${config.bm25Weight}, Vector=${config.vectorWeight}, PageRank=${config.pagerankWeight}`);

        // Inject README/package.json for onboarding queries
        if (classified.intent === 'orientation' || isOnboardingQuestion(question)) {
            const configFiles = await this.findPackageOrConfigFiles('');
            for (const cf of configFiles) {
                if (!seedFiles.includes(cf)) {
                    seedFiles.push(cf);
                }
            }
        }

        // Extract concepts / symbols directly from the query.
        // Repo-specific or model-generated expansion is intentionally excluded
        // from the core path; the proof-first architecture must generalize
        // across repositories without hidden corpus-specific hints.
        const extractedKw = this.extractKeywords(question);
        const queryTerms = Array.from(new Set([...classified.concepts, ...extractedKw]));
        
        // 2. Parallel Retrieval
        const [bm25Results, vectorResults, prResults] = await Promise.all([
            this.searchBm25(question, queryTerms),
            this.searchVector(question),
            this.searchPageRank(seedFiles)
        ]);

        const signalSeedChunks = await this.findAnnotationSignalSeedChunks(
            question,
            queryTerms,
            preferredAnnotationSignals as any
        );
        if (signalSeedChunks.length > 0) {
            bm25Results.push(...signalSeedChunks);
            this.context.logger.info(
                `[HybridRetrieval] Annotation signal prefilter injected ${signalSeedChunks.length} chunks for ${preferredAnnotationSignals.join(', ')}`
            );
        }
        
        bm25Results.forEach((c, idx) => (c as any).__preFusionScore = (15 - idx) * 0.001);
        vectorResults.forEach((c, idx) => (c as any).__preFusionScore = (15 - idx) * 0.001);

        this.context.logger.info(`[HybridRetrieval] BM25 found ${bm25Results.length} chunks`);
        this.context.logger.info(`[HybridRetrieval] Vector found ${vectorResults.length} chunks`);
        this.context.logger.info(`[HybridRetrieval] PageRank found ${prResults.length} files`);

        const explicitPathChunks: CodeChunk[] = [];
        await this.injectExplicitPathChunks(queryTerms, (chunk) => {
            (chunk as any).__symbolScore = 5.0; // Very high score for exact path match
            explicitPathChunks.push(chunk);
        });

        const seedFileChunks: CodeChunk[] = [];
        for (const seedFile of seedFiles) {
            const resolvedSeed = path.isAbsolute(seedFile) ? seedFile : path.join(this.workspaceRoot, seedFile);
            const chunks = await this.store.getChunksByFile(resolvedSeed);
            for (const chunk of chunks.slice(0, 3)) {
                (chunk as any).__seedFileScore = 4.0;
                seedFileChunks.push(chunk);
            }
        }

        // Exact identifier bypass
        const LOCAL_STOPWORDS = new Set(['in', 'on', 'at', 'is', 'to', 'do', 'go', 'no', 'so', 'we', 'he', 'me', 'be', 'an', 'as', 'by', 'of', 'or', 'up', 'us', 'if', 'am', 'my']);
        const exactIdentifiers = [
            ...(question.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || []),
            ...(question.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || []),
            ...(question.match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g) || []),
            ...(question.match(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g) || []),
            ...(question.match(/\b[A-Z][A-Z0-9]{1,}\b/g) || []) // Matches single-word ALL_CAPS, 2+ chars
        ].filter(id => !SYMBOL_LOOKUP_STOPWORDS.has(id.toLowerCase()) && !LOCAL_STOPWORDS.has(id.toLowerCase()));

        let termsToLookup = new Set<string>();

        if (exactIdentifiers.length > 0) {
            exactIdentifiers.forEach(id => termsToLookup.add(id));
        }

        if (classified.intent === 'location') {
            const filteredTerms = queryTerms.filter(
                k => !SYMBOL_LOOKUP_STOPWORDS.has(k.toLowerCase()) && k.length >= 4
            );
            filteredTerms.forEach(kw => termsToLookup.add(kw));
        }

        // 2b. Symbol Index injection
        if (this.symbolIndex && termsToLookup.size > 0) {
            const primaryEntity = (classified.primaryEntity ?? '').toLowerCase().replace(/_/g, '');
            const symbolHitsSeen = new Set<string>();

            if (process.env.LOG_TOKENIZATION === 'true') {
                this.context.logger.info(`[Tokenization] Original: ${question}`);
                this.context.logger.info(`[Tokenization] Extracted: ${JSON.stringify(queryTerms)}`);
                this.context.logger.info(`[Tokenization] PassedToLookup: ${JSON.stringify(Array.from(termsToLookup))}`);
                (global as any).__lastTokens = { extracted: queryTerms, passed: Array.from(termsToLookup) };
            }

            let injectedCount = 0;
            for (const kw of termsToLookup) {
                const kwLower = kw.toLowerCase();
                if (GENERIC_PLANNER_TERMS.has(kwLower)) continue;

                const matches = this.symbolIndex.lookupFuzzy(kw);
                console.log(`[DEBUG] kw=${kw}, matches=${matches.length}`);
                for (const match of matches) {
                    const hitKey = `${match.filePath}:${match.startLine}`;
                    if (symbolHitsSeen.has(hitKey)) continue;
                    symbolHitsSeen.add(hitKey);


                    // Quality-weighted scoring
                    const matchNameLower = match.name.toLowerCase();
                    let symbolScore = 2.0; // base
                    const primaryEntityLower = (primaryEntity ?? '').toLowerCase();

                    if (primaryEntityLower && matchNameLower.includes(primaryEntityLower)) {
                        symbolScore = 2.5;
                    } else if (primaryEntityLower && primaryEntityLower.includes(matchNameLower)) {
                        symbolScore = 2.0;
                    } else {
                        symbolScore = 0.6;
                    }

                    if (match.kind === 'class') {
                        symbolScore += 0.5;
                    }

                    this.context.logger.info(
                        `[HybridRetrieval] Symbol hit: ${match.name} -> ${match.filePath}:${match.startLine} (score=${symbolScore.toFixed(1)}, term=${kw})`
                    );

                    // Get actual chunks from the store for this file
                    const fileChunks = await this.store.getChunksByFile(match.filePath);
                    let overlapCount = 0;
                    if (fileChunks.length > 0) {
                        for (const fc of fileChunks) {
                            if (fc.startLine <= match.endLine && fc.endLine >= match.startLine) {
                                (fc as any).__preFusionScore = ((fc as any).__preFusionScore || 0) + symbolScore;
                                bm25Results.push(fc);
                                injectedCount++;
                                overlapCount++;
                            }
                        }
                    }
                    if (overlapCount === 0) {
                        // Fallback: read from disk
                        try {
                            const absPath = path.isAbsolute(match.filePath) ? match.filePath : path.join(this.workspaceRoot, match.filePath);
                            console.log(`[DEBUG] Fallback absPath=${absPath}`);
                            const content = await fs.promises.readFile(absPath, 'utf-8');
                            const lines = content.split(/\r?\n/);
                            const start = Math.max(0, match.startLine - 5);
                            const end = Math.min(lines.length - 1, match.endLine + 15);
                            const text = lines.slice(start, end + 1).join('\n');

                            const syntheticChunk: CodeChunk = {
                                id: `symbol_${match.filePath}_${match.startLine}`,
                                filePath: match.filePath,
                                language: 'unknown',
                                startLine: start,
                                endLine: end,
                                text: text,
                                vector: [],
                                hash: ''
                            };
                            (syntheticChunk as any).__preFusionScore = symbolScore;
                            bm25Results.push(syntheticChunk);
                            injectedCount++;
                            console.log(`[DEBUG] Injected synthetic chunk id=${syntheticChunk.id}`);
                        } catch (e) {
                            console.log(`[DEBUG] Exception in fallback: ${e}`);
                            this.context.logger.info(`[HybridRetrieval] Failed to read fallback chunk: ${e}`);
                        }
                    }
                }
            }
            this.context.logger.info(`[HybridRetrieval] Symbol index injected ${injectedCount} chunks directly into BM25`);
        }
        
        // 2c. Concept Map Injection
        if (classified.intent === 'location') {
            const conceptMapPath = path.join(this.repoguideDir, 'concept_map.json');
            if (fs.existsSync(conceptMapPath)) {
                try {
                    const conceptMapData = JSON.parse(await fs.promises.readFile(conceptMapPath, 'utf8'));
                    const indexMap = new Map();
                    if (conceptMapData.index) {
                        for (const k of Object.keys(conceptMapData.index)) {
                            indexMap.set(k, conceptMapData.index[k]);
                        }
                    }
                    const searcher = new ConceptMapSearcher(indexMap, conceptMapData as any);
                    const conceptResults = searcher.search(question, 10);
                    let injectedConceptCount = 0;
                    for (const result of conceptResults.filter(r => r.matchScore > 0.4)) {
                        const fileChunks = await this.store.getChunksByFile(result.location.filePath);
                        const chunk = fileChunks.find(c =>
                            c.startLine <= result.location.startLine && c.endLine >= result.location.startLine
                        );
                        if (chunk) {
                            (chunk as any).__preFusionScore = ((chunk as any).__preFusionScore || 0) + (result.matchScore * 2.0);
                            bm25Results.push(chunk);
                            injectedConceptCount++;
                            this.context.logger.info(`[HybridRetrieval] Concept map hit: "${result.matchedConcept}" -> ${result.location.filePath}:${result.location.startLine}`);
                        }
                    }
                    if (injectedConceptCount > 0) {
                        this.context.logger.info(`[HybridRetrieval] Concept map injected ${injectedConceptCount} chunks directly into BM25`);
                    }
                } catch (e) {
                    this.context.logger.info(`[HybridRetrieval] Failed to load concept map: ${e}`);
                }
            }
        }

        if (explicitPathChunks.length > 0) {
            this.context.logger.info(`[HybridRetrieval] Explicit path chunks injected: ${explicitPathChunks.length}`);
        }
        if (seedFileChunks.length > 0) {
            this.context.logger.info(`[HybridRetrieval] Seed file chunks injected: ${seedFileChunks.length}`);
        }

        // 3. Reciprocal Rank Fusion (RRF)
        const combinedScores = new Map<string, { chunk: CodeChunk, score: number }>();

        const pe = (classified.primaryEntity ?? '').toLowerCase().replace(/_/g, '');
        if (classified.intent === 'location') {
            const addBonus = (c: CodeChunk) => {
                const bonus = getDefinitionBonus(c.text, queryTerms, pe);
                if (bonus > 0) {
                    (c as any).__preFusionScore = ((c as any).__preFusionScore || 0) + bonus;
                }
            };
            bm25Results.forEach(addBonus);
            vectorResults.forEach(addBonus);
        }

        bm25Results.sort((a, b) => ((b as any).__preFusionScore || 0) - ((a as any).__preFusionScore || 0));
        vectorResults.sort((a, b) => ((b as any).__preFusionScore || 0) - ((a as any).__preFusionScore || 0));

        const k = 60;
        const qLower = question.toLowerCase();
        const mentionsTest = qLower.includes('test') || qLower.includes('verify') || qLower.includes('spec');

        const isTestPath = (p: string) => {
            const pLower = p.toLowerCase();
            return pLower.includes('test') || pLower.includes('tests') || pLower.includes('__tests__') || 
                   pLower.includes('spec') || pLower.includes('verify_') || 
                   pLower.includes('mock') || pLower.includes('fixture');
        };

        const addScore = (chunk: CodeChunk, rank: number, weight: number) => {
            if (!combinedScores.has(chunk.id)) {
                combinedScores.set(chunk.id, { chunk, score: 0 });
            }
            let baseRankScore = weight * (1 / (k + rank));
            combinedScores.get(chunk.id)!.score += baseRankScore;
        };

        bm25Results.forEach((c, idx) => addScore(c, idx + 1, config.bm25Weight));
        vectorResults.forEach((c, idx) => addScore(c, idx + 1, config.vectorWeight));

        // FIX 1+2: Carry __preFusionScore directly into the combined score.
        // Carry high-confidence symbol and definition scores into final ranking.
        // and definition bonuses (1.5-2.5) directly to the final score map.
        // Without this, RRF rank-based scoring caps the contribution at ~0.011,
        // which is too small to guarantee symbol-matched files rank first.
        const allRetrieved = [...bm25Results, ...vectorResults];
        const seenPreFusion = new Set<string>();
        for (const c of allRetrieved) {
            const preFusion = (c as any).__preFusionScore ?? 0;
            if (preFusion >= 0.1 && !seenPreFusion.has(c.id)) {
                seenPreFusion.add(c.id);
                if (!combinedScores.has(c.id)) {
                    combinedScores.set(c.id, { chunk: c, score: 0 });
                }
                combinedScores.get(c.id)!.score += preFusion;
            }
        }

        for (const sc of explicitPathChunks) {
            const symScore = (sc as any).__symbolScore ?? 2.0;
            if (!combinedScores.has(sc.id)) {
                combinedScores.set(sc.id, { chunk: sc, score: 0 });
            }
            // Add the full symbol score directly (was multiplied by 0.02 before)
            combinedScores.get(sc.id)!.score += symScore;
        }

        for (const sc of seedFileChunks) {
            const seedScore = (sc as any).__seedFileScore ?? 3.0;
            if (!combinedScores.has(sc.id)) {
                combinedScores.set(sc.id, { chunk: sc, score: 0 });
            }
            combinedScores.get(sc.id)!.score += seedScore;
        }

        // For PageRank, apply the file's RRF score to ALL chunks from that file that were found by BM25 or Vector.
        Array.from(combinedScores.values()).forEach(item => {
            const fileRank = prResults.indexOf(item.chunk.filePath);
            if (fileRank !== -1) {
                addScore(item.chunk, fileRank + 1, config.pagerankWeight);
            }
        });

        const importGraphChunks: CodeChunk[] = [];
        if (this.importGraphSearcher && classified.intent === 'location') {
            const impactPatterns = [
                'what imports', 'what uses', 'what depends on',
                'what calls', 'what breaks if', 'impact of changing',
                'who uses', 'dependencies of', 'what would break',
                'would break if', 'break if i change', 'break if i modify',
                'break if you change', 'affected by changing',
                'affected if', 'depend on', 'who depends'
            ];
            const lowerQuestion = question.toLowerCase();
            if (impactPatterns.some(p => lowerQuestion.includes(p))) {
                let primaryFile = '';
                
                const keys = this.importGraphSearcher.getAllFiles();
                let match = '';
                if (pe) {
                    match = keys.find(k => k.toLowerCase().endsWith(pe.toLowerCase())) || keys.find(k => k.toLowerCase().includes(pe)) || '';
                }
                if (!match) {
                    for (const kw of queryTerms) {
                        const kwMatch = keys.find(k => k.toLowerCase().endsWith(kw.toLowerCase()));
                        if (kwMatch) { match = kwMatch; break; }
                    }
                }
                if (match) primaryFile = match;

                if (primaryFile) {
                    const dependents = this.importGraphSearcher.getBlastRadius(primaryFile);
                    if (dependents.length > 0) {
                        for (const dep of dependents.slice(0, 3)) {
                            const depChunks = await this.store.getChunksByFile(dep);
                            for (const dc of depChunks.slice(0, 2)) {
                                if (!combinedScores.has(dc.id)) {
                                    combinedScores.set(dc.id, { chunk: dc, score: 0 });
                                }
                                combinedScores.get(dc.id)!.score += 1.5;
                            }
                        }
                    }
                }
            }
        }

        // Apply test file penalty to the final score to ensure explicit matches are penalized
        if (!mentionsTest) {
            for (const item of combinedScores.values()) {
                if (isTestPath(item.chunk.filePath)) {
                    item.score *= 0.1;
                }
            }
        }

        // Sort by combined score
        let fusedChunks = Array.from(combinedScores.values())
            .sort((a, b) => b.score - a.score);

        if ((global as any).__phase54Capture) {
            (global as any).__phase54Capture(question, {
                bm25Results: [...bm25Results],
                vectorResults: [...vectorResults],
                prResults: [...prResults],
                fusedChunks: [...fusedChunks],
                combinedScores: new Map(combinedScores)
            });
        }

        if (classified.intent === 'location') {
            const bestPerFile = new Map<string, { chunk: CodeChunk, score: number }>();
            for (const sc of fusedChunks) {
                const existing = bestPerFile.get(sc.chunk.filePath);
                if (!existing || sc.score > existing.score) {
                    bestPerFile.set(sc.chunk.filePath, sc);
                }
            }
            fusedChunks = Array.from(bestPerFile.values()).sort((a, b) => b.score - a.score);
        }

        const rankedChunks = fusedChunks.map((item, idx) => ({ ...item, rank: idx + 1 }));

        let targetChunks = routedStrategy.maxChunks;
        if (['symbol_lookup', 'configuration_lookup', 'targeted_extraction'].includes(routedStrategy.strategy)) {
            targetChunks = routedStrategy.minChunks;
        }

        const trimmedChunks = trimToTokenBudget(
            rankedChunks,
            undefined, // use profile budget
            targetChunks, // max chunks
            classified.intent
        );

        this.context.logger.info(`[HybridRetrieval] Fused down to ${trimmedChunks.length} chunks.`);

        // 4. CONTEXT ASSEMBLY
        const topChunks = trimmedChunks.slice(0, targetChunks).map((chunk, idx) => {
            const original = rankedChunks.find(c => c.chunk.id === chunk.id);
            return {
                chunk,
                score: original?.score ?? 0,
                rank: original?.rank ?? idx + 1
            };
        });
        
        // Include annotations for unique files
        const uniqueFiles = Array.from(new Set(topChunks.map(c => c.chunk.filePath)));
        const annotations: FileAnnotation[] = [];
        for (const file of uniqueFiles) {
            const annotation = await this.fileAnnotationEngine.loadAnnotationByPath(file);
            if (annotation) {
                annotations.push(annotation);
            }
        }

        // Include community summaries
        const communities: CommunitySummary[] = [];
        const communityFile = path.join(this.repoguideDir, 'community_summaries.json');
        if (fs.existsSync(communityFile)) {
            try {
                const data: CommunityClusteringOutput = JSON.parse(await fs.promises.readFile(communityFile, 'utf8'));
                for (const file of uniqueFiles) {
                    const matchedComm = data.communities.find(c => c.files.includes(file));
                    if (matchedComm && !communities.some(c => c.id === matchedComm.id)) {
                        communities.push(matchedComm);
                    }
                }
            } catch (e) {
                this.context.logger.info(`[HybridRetrieval] Failed to load communities: ${e}`);
            }
        }

        const degradedChannels = computeDegradedChannels(this.channelErrors, config);

        return {
            chunks: topChunks,
            annotations,
            communities,
            degradedChannels
        };
    }

    async getChunksForEvidenceFile(filePath: string): Promise<CodeChunk[]> {
        const resolved = path.isAbsolute(filePath) ? filePath : path.join(this.workspaceRoot, filePath);
        let chunks = await this.store.getChunksByFile(resolved);
        if (chunks.length === 0) {
            const allFiles = await this.store.getAllFilePaths();
            const normalizedNeedle = normalizePath(filePath).replace(/^\.\//, '');
            const matched = allFiles.find(candidate => {
                const normalized = normalizePath(candidate);
                return normalized === normalizedNeedle ||
                    normalized.endsWith('/' + normalizedNeedle) ||
                    normalized.endsWith('/' + path.basename(normalizedNeedle));
            });
            if (matched) {
                chunks = await this.store.getChunksByFile(matched);
            }
        }
        return chunks;
    }

    async searchBm25Evidence(query: string, topK = 8): Promise<CodeChunk[]> {
        const results = await this.bm25Store.search(query, topK);
        const chunks: CodeChunk[] = [];
        const seen = new Set<string>();
        for (const result of results) {
            const fileChunks = await this.store.getChunksByFile(result.filePath);
            const matched = fileChunks.find(chunk => chunk.id === result.id) ?? fileChunks[0];
            if (matched && !seen.has(matched.id)) {
                seen.add(matched.id);
                chunks.push(matched);
            }
        }
        return chunks;
    }

    lookupSymbolEvidence(symbol: string): SymbolEntry[] {
        return this.symbolIndex?.lookupFuzzy(symbol) ?? [];
    }

    async findPackageOrConfigFiles(anchor: string): Promise<string[]> {
        const allFiles = await this.store.getAllFilePaths();
        const lowerAnchor = anchor ? anchor.toLowerCase() : '';
        const configNames = new Set(['package.json', 'tsconfig.json', 'jsconfig.json', '.yarnrc.yml', '.npmrc', 'readme.md']);
        
        // Find config files and sort by depth to prioritize root files
        const matches = allFiles.filter(filePath => {
            const normalized = normalizePath(filePath);
            const base = path.basename(normalized).toLowerCase();
            
            if (configNames.has(base)) return true;
            if (lowerAnchor) {
                if (normalized.includes(lowerAnchor)) return true;
                if (lowerAnchor.startsWith('@') && normalized.includes(lowerAnchor.split('/').pop() ?? lowerAnchor)) return true;
            }
            return false;
        });
        
        return matches.sort((a, b) => a.split(/[/\\]/).length - b.split(/[/\\]/).length).slice(0, 12);
    }

    async getIndexedFilePathsForAnalysis(): Promise<string[]> {
        return this.store.getAllFilePaths();
    }

    /** Resolves raw Bm25Result rows to real CodeChunks with real line numbers,
     * shared by both the primary (raw-question) and supplemental (keyword-only)
     * BM25 passes in searchBm25(). */
    private async resolveBm25Chunks(results: import('../store/bm25Store').Bm25Result[]): Promise<CodeChunk[]> {
        const resolved: CodeChunk[] = [];
        for (const r of results) {
            // Try to find the actual indexed chunk with matching id
            const storeChunks = await this.store.getChunksByFile(r.filePath);
            const matching = storeChunks.find(sc => sc.id === r.id);
            if (matching) {
                resolved.push(matching);
            } else {
                // Best-effort: find a chunk whose text overlaps
                const textMatch = storeChunks.find(sc =>
                    sc.text && r.text && (
                        sc.text.includes(r.text.substring(0, 80)) ||
                        r.text.includes(sc.text.substring(0, 80))
                    )
                );
                if (textMatch) {
                    resolved.push(textMatch);
                } else {
                    resolved.push({
                        id: r.id,
                        filePath: r.filePath,
                        language: 'unknown',
                        startLine: 0,
                        endLine: 0,
                        text: r.text,
                        vector: [],
                        hash: ''
                    });
                }
            }
        }
        return resolved;
    }

    /**
     * Primary BM25 pass is the raw question text, unchanged from before --
     * every existing question keeps the exact same top-ranked BM25 hits it had.
     *
     * Bm25Store's tokenizer has no stopword handling and MiniSearch's
     * `combineWith: 'OR'` sums a score contribution per matched token, so a raw
     * natural-language question ("Does this codebase have Kubernetes deployment
     * configuration, or does it deploy some other way?") scores documents partly
     * on how many of ITS OWN filler words ("does", "have", "way") they happen to
     * contain -- which structurally favors long prose docs (README.md,
     * PROJECT_TECHNICAL_DOCUMENTATION.md) over short, topically-precise files
     * (a Dockerfile, a *.yaml config) that match only the load-bearing terms.
     * Confirmed live against CraftConnect: the real Dockerfile/
     * deployment/cloud_run_config.yaml ranked #1 for isolated keyword queries
     * ("kubernetes deployment") but fell entirely outside the raw question's
     * top 50 results.
     *
     * queryTerms (extractKeywords() + classified.concepts, already computed by
     * the caller for symbol-index injection) is reused here for a second,
     * supplemental keyword-only MiniSearch pass -- deliberately additive, not a
     * replacement: only chunks NOT already found by the primary pass are
     * appended, at the tail, in the order MiniSearch returns them for the
     * keyword query. This can add new candidates the raw-question search missed
     * outright; it can never remove, reorder, or displace an existing
     * raw-question hit, since those are collected first and never revisited.
     */
    private async searchBm25(question: string, queryTerms: string[] = []): Promise<CodeChunk[]> {
        let resolved: CodeChunk[];
        try {
            const results = await this.bm25Store.search(question, 50);
            resolved = await this.resolveBm25Chunks(results);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.context.logger.info(`[HybridRetrieval] BM25 search failed: ${message}`);
            this.channelErrors.push({ channel: 'bm25', error: message });
            return [];
        }

        if (queryTerms.length > 0) {
            try {
                const keywordQuery = queryTerms.join(' ');
                const keywordResults = await this.bm25Store.search(keywordQuery, 50);
                const seenIds = new Set(resolved.map(c => c.id));
                const supplemental = (await this.resolveBm25Chunks(keywordResults))
                    .filter(c => !seenIds.has(c.id));
                if (supplemental.length > 0) {
                    this.context.logger.info(`[HybridRetrieval] Keyword-only BM25 pass added ${supplemental.length} chunks the raw-question search missed`);
                    resolved = resolved.concat(supplemental);
                }
            } catch (e) {
                // Best-effort supplemental pass -- the primary, raw-question
                // results above are already valid and already returned either way.
                const message = e instanceof Error ? e.message : String(e);
                this.context.logger.info(`[HybridRetrieval] Keyword-only BM25 pass failed (non-fatal): ${message}`);
            }
        }

        return resolved;
    }

    private async searchVector(question: string): Promise<CodeChunk[]> {
        try {
            const vector = await embedText(this.context, question);
            const rawResults = await this.store.queryByVector(vector, 15);
            return rawResults.filter(chunk =>
                chunk.id !== 'dummy' &&
                chunk.text &&
                chunk.text.trim().length > 0 &&
                chunk.filePath &&
                chunk.filePath !== 'dummy'
            );
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.context.logger.info(`[HybridRetrieval] Vector search failed: ${message}`);
            this.channelErrors.push({ channel: 'vector', error: message });
            if (isLanceCorruptionError(message)) {
                this.notifyLanceCorruptionOnce();
            }
            return [];
        }
    }

    /** Debounced per-instance (not per-query) so a burst of failing queries in
     * one session surfaces this once, not once per question. */
    private lanceCorruptionNotified = false;
    private notifyLanceCorruptionOnce(): void {
        if (this.lanceCorruptionNotified) {
            return;
        }
        this.lanceCorruptionNotified = true;
        void this.context.notifyWarning(
            "RepoGuide: the code-search index appears corrupted (a referenced data fragment is missing on disk) -- code-search results may be incomplete for this session. Run 'RepoGuide: Re-sync Index' to repair it."
        );
    }

    private async searchPageRank(seedFiles: string[]): Promise<string[]> {
        const graphPath = path.join(this.repoguideDir, 'pagerank_graph.json');
        if (!fs.existsSync(graphPath)) return [];
        try {
            const graph: PageRankGraph = JSON.parse(await fs.promises.readFile(graphPath, 'utf8'));

            const scores = new Map<string, number>();
            for (const [file, node] of Object.entries(graph.nodes)) {
                let score = node.pagerank_score;
                if (seedFiles.length > 0) {
                    let isReferenced = false;
                    for (const edge of graph.edges) {
                        if (seedFiles.includes(edge.from) && edge.to === file) {
                            isReferenced = true;
                            break;
                        }
                    }
                    if (isReferenced) {
                        score *= 10;
                    }
                }
                scores.set(file, score);
            }

            return Array.from(scores.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(e => e[0]);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.context.logger.info(`[HybridRetrieval] PageRank search failed: ${message}`);
            this.channelErrors.push({ channel: 'pagerank', error: message });
            return [];
        }
    }

    private async findAnnotationSignalSeedChunks(
        question: string,
        queryTerms: string[],
        preferredSignals: string[]
    ): Promise<CodeChunk[]> {
        if (preferredSignals.length === 0) {
            return [];
        }

        const preferred = new Set(preferredSignals);
        const annotations = (await this.fileAnnotationEngine.getAllAnnotations())
            .filter(annotation =>
                typeof annotation.file === 'string' &&
                Array.isArray(annotation.signals) &&
                annotation.signals.some(signal => preferred.has(signal))
            );

        if (annotations.length === 0) {
            return [];
        }

        const lowerQuestion = question.toLowerCase();
        const scored = annotations.map(annotation => {
            const haystack = [
                annotation.file,
                annotation.what,
                ...(annotation.key_symbols ?? []),
                ...(annotation.depends_on ?? [])
            ].join(' ').toLowerCase();
            const queryHits = queryTerms.filter(term => haystack.includes(term.toLowerCase())).length;
            const signalHits = annotation.signals.filter(signal => preferred.has(signal)).length;
            const literalHit = lowerQuestion.includes(path.basename(annotation.file).toLowerCase()) ? 2 : 0;
            return {
                annotation,
                score: signalHits * 2 + queryHits + literalHit
            };
        })
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 8);

        const chunks: CodeChunk[] = [];
        for (const item of scored) {
            const annotationPath = path.isAbsolute(item.annotation.file)
                ? item.annotation.file
                : path.join(this.workspaceRoot, item.annotation.file);
            const fileChunks = await this.store.getChunksByFile(annotationPath);
            for (const chunk of fileChunks.slice(0, 2)) {
                (chunk as any).__preFusionScore = ((chunk as any).__preFusionScore || 0) + item.score;
                chunks.push(chunk);
            }
        }

        return chunks;
    }

    private logAnswerMetadata(metadata: AnswerMetadata): void {
        this.context.logger.info(
            `[PhaseA] Answer metadata (${metadata.mode}): ${JSON.stringify({
                file_references: metadata.file_references.slice(0, 5),
                onboarding: metadata.onboarding
            })}`
        );
    }

    private async injectExplicitPathChunks(
        terms: string[],
        upsertChunk: (chunk: CodeChunk) => void
    ): Promise<void> {
        const pathTerms = Array.from(new Set(terms
            .map(term => term.toLowerCase().replace(/\\/g, '/').replace(/^\.\//, ''))
            .filter(term => term.includes('/') && /\.[cm]?[jt]sx?$/.test(term))));

        if (pathTerms.length === 0) {
            return;
        }

        const allPaths = await this.store.getAllFilePaths();
        const matchedPaths = new Set<string>();

        for (const term of pathTerms) {
            const match = allPaths.find(filePath => {
                const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');
                return normalizedPath.endsWith('/' + term) || normalizedPath.includes('/' + term);
            });

            if (!match || matchedPaths.has(match)) {
                continue;
            }
            matchedPaths.add(match);

            const indexedChunks = await this.store.getChunksByFile(match);
            if (indexedChunks.length > 0) {
                for (const chunk of indexedChunks.slice(0, 3)) {
                    upsertChunk(chunk);
                }
                this.context.logger.info(`[Info] Injected explicit path chunk for ${term}`);
                continue;
            }

            try {
                const fs = require('fs');
                const content = await fs.promises.readFile(match, 'utf-8');
                const lines = content.split(/\r?\n/);
                upsertChunk({
                    id: `path_fallback_${match}_0`,
                    filePath: match,
                    language: 'unknown',
                    startLine: 0,
                    endLine: Math.min(lines.length - 1, 30),
                    text: lines.slice(0, 31).join('\n'),
                    vector: [],
                    hash: ''
                } as any);
                this.context.logger.info(`[Info] Injected synthetic path chunk for ${term}`);
            } catch (e) {
                this.context.logger.info(`[Warn] Failed to read explicit path chunk from disk for ${match}`);
            }
        }
    }

    private extractKeywords(question: string): string[] {
        const keywords = new Set<string>();

        // Preserve ALL_CAPS constants
        const allCapsMatches = question.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [];
        for (const m of allCapsMatches) keywords.add(m);

        // Preserve snake_case
        const snakeMatches = question.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
        for (const m of snakeMatches) keywords.add(m);

        // Preserve PascalCase
        const pascalMatches = question.match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g) || [];
        for (const m of pascalMatches) keywords.add(m);

        // Preserve camelCase
        const camelMatches = question.match(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g) || [];
        for (const m of camelMatches) keywords.add(m);

        const STOP_WORDS = new Set([
            'what', 'how', 'why', 'where', 'when', 'who', 'which', 'explain', 'describe',
            'find', 'show', 'tell', 'about', 'this', 'that', 'these', 'those', 'the', 'and', 'with', 'for'
        ]);

        const words = question
            .toLowerCase()
            .replace(/[^a-z0-9_\s]/g, ' ') // KEEP underscores
            .split(/\s+/)
            .filter(w => w.length > 4 && !STOP_WORDS.has(w));
        for (const w of words) keywords.add(w);

        return Array.from(keywords).filter(k => k.length > 2);
    }
}

/**
 * Tiered definition bonus matching the old pipeline's scoring logic.
 * class definition > named public function > private helper
 */
function getDefinitionBonus(text: string, terms: string[], primaryEntity: string): number {
    let bestBonus = 0;
    const pe = primaryEntity.toLowerCase().replace(/_/g, '');
    for (const term of terms) {
        const lower = term.toLowerCase();
        if (lower.length < 4) continue;
        if (GENERIC_PLANNER_TERMS.has(lower)) continue;
        const patternTerm = escapeRegExp(lower);

        // Class definition matching primary entity → highest bonus
        if (new RegExp(`\\bclass\\s+\\w*${patternTerm}\\w*`, 'i').test(text)) {
            const bonus = (pe && lower.includes(pe)) ? 2.5 : 2.0;
            bestBonus = Math.max(bestBonus, bonus);
        }
        // Named public function/def matching primary entity → high bonus
        if (
            new RegExp(`\\bdef\\s+(?!_)\\w*${patternTerm}\\w*`, 'i').test(text) ||
            new RegExp(`\\bfunction\\s+(?!_)\\w*${patternTerm}\\w*`, 'i').test(text) ||
            new RegExp(`\\basync\\s+def\\s+(?!_)\\w*${patternTerm}\\w*`, 'i').test(text) ||
            new RegExp(`\\bexport\\s+(?:default\\s+)?(?:class|function|const)\\s+\\w*${patternTerm}\\w*`, 'i').test(text)
        ) {
            const bonus = (pe && lower.includes(pe)) ? 1.8 : 1.5;
            bestBonus = Math.max(bestBonus, bonus);
        }
        // Private/helper function (prefixed with _) → small bonus
        if (
            new RegExp(`\\bdef\\s+_\\w*${patternTerm}\\w*`, 'i').test(text) ||
            new RegExp(`\\bfunction\\s+_\\w*${patternTerm}\\w*`, 'i').test(text)
        ) {
            bestBonus = Math.max(bestBonus, 0.5);
        }
    }
    return bestBonus;
}

