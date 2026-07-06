import { EvidencePlan } from './evidencePlanTypes';
import { EvidencePacket, EvidenceItem, SemanticCategory } from './evidencePacket';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { FactStore } from '../store/factStore';
import { LogicalUnitBm25Store } from '../store/logicalUnitBm25Store';
import { FactRecord, FactType } from '../indexing/factTypes';
import { LogicalUnit, LogicalUnitRole } from '../indexing/logicalUnitTypes';
import { CodeChunk } from '../store/storeTypes';
import { expandConstantsAndFacts } from './factExpansion';
import { IndexManifestStore } from '../indexing/indexManifest';
import * as fs from 'fs';
import * as path from 'path';
import { ProgramGraphStore } from '../store/programGraphStore';
import { FileAnnotationEngine } from '../comprehension/fileAnnotationEngine';
import { CommunityClusteringOutput } from '../comprehension/communityClustering';
import { SemanticImpactEngine } from './semanticImpactEngine';
import { UsageHeuristicEvaluator } from './usageHeuristicEvaluator';
import { RetrievalOrchestrationResult } from './retrievalOrchestrator';
import { loadMeta } from '../store/indexMeta';

const KNOWN_FACT_TYPES = new Set<FactType>([
    'constant',
    'numeric_threshold',
    'list_literal',
    'list_count',
    'dict_literal',
    'string_literal',
    'prompt_template',
    'config_value',
    'environment_variable',
    'fallback_chain',
    'guard_clause',
    'dependency_injection',
    'instantiation',
    'import',
    'exported_symbol',
    'call_site',
    'calls_method',
    'implements_interface',
    'assignment'
]);
export interface EvidencePacketBuilderStores {
    unitStore: LogicalUnitStore;
    factStore: FactStore;
    bm25Store: LogicalUnitBm25Store;
    manifestStore?: IndexManifestStore;
    programGraphStore?: ProgramGraphStore;
    annotationStore?: FileAnnotationEngine;
    communityStore?: string;
}

export class EvidencePacketBuilder {
    constructor(private stores: EvidencePacketBuilderStores, private workspaceRoot: string) {}

    /**
     * Canonicalizes an evidence item's file path to one form (workspace-relative,
     * forward-slashed) regardless of which provider produced it. Different stores
     * populate `.file` differently -- symbol-index/hybrid-retrieval-injected items
     * use absolute paths, LogicalUnitStore/FactStore/annotations use workspace-
     * relative ones -- and without this, the same real file can end up cited twice
     * under two different string forms after Set-based dedup in queryDispatcher.ts.
     */
    private normalizeFilePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
        }
        return filePath.replace(/\\/g, '/');
    }

    /**
     * `communityStore` doubles as the repoguideDir path (see queryDispatcher.ts's
     * construction site) -- meta.json lives there too, written by IndexManager
     * with `truncated`/`totalDiscovered` whenever the file-walk budget was hit.
     */
    private async getTruncationGap(): Promise<string | null> {
        if (!this.stores.communityStore) {
            return null;
        }
        try {
            const meta = await loadMeta(this.stores.communityStore);
            if (meta?.truncated) {
                return `Index covers ${meta.fileCount}/${meta.totalDiscovered ?? '?'} files (budget-limited by repoguide.maxIndexedFiles); results may miss relevant code outside the indexed set.`;
            }
        } catch {
            // meta.json missing or unreadable -- no truncation gap to report
        }
        return null;
    }

    async buildPacket(query: string, plan: EvidencePlan, retrievalResult?: RetrievalOrchestrationResult): Promise<EvidencePacket> {
        const itemsMap = new Map<string, EvidenceItem>();
        const excludeRoles = plan.mustExcludeRoles;

        // Step 2 & 3: Retrieve by exact symbol hints concurrently based on retrieval tasks
        const factsMap = new Map<string, EvidenceItem>();
        const seedUnits: LogicalUnit[] = [];

        if (retrievalResult) {
            for (const item of retrievalResult.items) {
                const normalizedItem = { ...item, file: this.normalizeFilePath(item.file) };
                if (this.isFactEvidence(normalizedItem)) {
                    this.addItem(factsMap, normalizedItem, 'RetrievalOrchestrator');
                } else {
                    this.addItem(itemsMap, normalizedItem, 'RetrievalOrchestrator');
                }
            }
        }


        {
            const processHint = async (hint: string, sourceDesc: string) => {
                const units = await this.stores.unitStore.searchBySymbol(hint, { limit: 10 });
                for (const uRef of units) {
                    if (excludeRoles.includes(uRef.role)) continue;
                    const unit = await this.stores.unitStore.getUnit(uRef.id);
                    if (unit) {
                        seedUnits.push(unit);
                        this.addItem(itemsMap, this.unitToItem(unit, 'symbol_hint', 0.9, SemanticCategory.GENERAL), sourceDesc);
                    }
                }

                const facts = await this.stores.factStore.findBySymbol(hint, { excludeRoles });
                for (const f of facts) {
                    this.addItem(factsMap, this.factToItem(f, 'fact_match', 1.0, SemanticCategory.BEHAVIOR), sourceDesc);
                }
            };

            const processHintsList = async (hints: string[], sourceDesc: string) => {
                await Promise.all(hints.map(hint => processHint(hint, sourceDesc)));
            };

            if (plan.retrievalTasks && plan.retrievalTasks.length > 0) {
                await Promise.all(plan.retrievalTasks.map(task => 
                    processHintsList(task.symbolHints, `Task: ${task.id}`)
                ));
            } else {
                await processHintsList(plan.symbolHints, 'Base Plan');
            }

            if ((plan.queryType === 'threshold' || plan.queryType === 'exact_constant') && plan.factTypes.includes('numeric_threshold')) {
                const numericFacts = await this.stores.factStore.findByType('numeric_threshold');
                const thresholdFacts = await this.stores.factStore.findByType('constant');
                const allThresholdFacts = [...numericFacts, ...thresholdFacts].filter(f => !excludeRoles.includes(f.role));

                const dedupedFacts = new Map<string, FactRecord>();
                for (const f of allThresholdFacts) {
                    dedupedFacts.set(f.factId, f);
                }

                const scoredFacts = Array.from(dedupedFacts.values()).map(fact => {
                    let relevanceScore = 0;
                    for (const hint of plan.symbolHints) {
                        const hintLower = hint.toLowerCase();
                        if (fact.symbol && fact.symbol.toLowerCase().includes(hintLower)) relevanceScore += 3;
                        if (fact.filePath && fact.filePath.toLowerCase().includes(hintLower)) relevanceScore += 2;
                        if (fact.sourceText && fact.sourceText.toLowerCase().includes(hintLower)) relevanceScore += 1;
                    }
                    return { fact, relevanceScore };
                });

                scoredFacts.sort((a, b) => b.relevanceScore - a.relevanceScore);
                const top5 = scoredFacts.slice(0, 5);

                for (const scored of top5) {
                    if (scored.relevanceScore > 0) {
                        this.addItem(factsMap, this.factToItem(scored.fact, 'threshold_relevance', 0.95, SemanticCategory.BEHAVIOR));
                    }
                }
            }
        }

        // Step 4: Retrieve by BM25 over unit indexes/content
        {
            if (plan.symbolHints.length > 0 || plan.normalizedQuery.length > 0 || (plan.phrases && plan.phrases.length > 0)) {
                const bm25Query = [
                    ...plan.symbolHints,
                    plan.normalizedQuery,
                    ...(plan.phrases || [])
                ].join(' ');
                const bm25Results = await this.stores.bm25Store.search(bm25Query, 10, {
                    excludeRoles: plan.mustExcludeRoles as LogicalUnitRole[]
                });
                for (const res of bm25Results) {
                    const unit = await this.stores.unitStore.getUnit(res.unitId);
                    if (unit) {
                        if (!seedUnits.some(u => u.id === unit.id)) {
                            seedUnits.push(unit);
                        }
                        this.addItem(itemsMap, this.unitToItem(unit, 'bm25', res.score > 0 ? (res.score > 10 ? 0.9 : 0.7) : 0.6, SemanticCategory.GENERAL));
                    }
                }
            }
        }

        // Step 5: Vector search omitted intentionally (or stubbed) so we do not hit vscode dependency issues
        // in tests. For full production, it would be injected or run via IPC.
        
        // Step 6: Run factExpansion on seed units
        {
            if (seedUnits.length > 0) {
                const expansion = await expandConstantsAndFacts(seedUnits, query, {
                    unitStore: this.stores.unitStore,
                    factStore: this.stores.factStore
                }, 2, 500);
                for (const ef of expansion.expandedFacts) {
                    if (excludeRoles.includes(ef.fact.role)) continue;
                    let score = 0.95;
                    if (plan.factTypes.length > 0 && plan.factTypes.includes(ef.fact.factType)) {
                        score = 0.98; // Boost facts that match requested types
                    }
                    this.addItem(factsMap, this.factToItem(ef.fact, ef.reason, score, SemanticCategory.BEHAVIOR));
                }
            }

            // Calculate a preliminary coverage score to decide on graph expansion
            let preliminaryCoverageScore = 0;
            if (plan.queryType !== 'unknown') {
                const coveredTypes = new Set(Array.from(factsMap.values()).map(f => f.type));
                let matches = 0;
                for (const ft of plan.factTypes) {
                    if (coveredTypes.has(ft)) matches++;
                }
                preliminaryCoverageScore = plan.factTypes.length > 0 ? matches / plan.factTypes.length : 0;
            }

            // Step 6.5: Graph expansion
            if (this.stores.programGraphStore && (preliminaryCoverageScore > 0.5 || plan.retrievalStrategy === 'pagerank_expansion')) {
                const graphStore = this.stores.programGraphStore;
                for (const seed of seedUnits) {
                    let expanded = 0;

                    // Callees
                    const callees = graphStore.getCallees(seed.id);
                    expanded = 0;
                    for (const node of callees) {
                        if (expanded >= 5) break;
                        if (excludeRoles.includes(node.role)) continue;
                        const u = await this.stores.unitStore.getUnit(node.id);
                        if (u) {
                            this.addItem(itemsMap, this.unitToItem(u, 'graph_callee_expansion', 0.7, SemanticCategory.DEPENDENCY));
                            expanded++;
                        }
                    }

                    // Callers
                    if (seed.symbol) {
                        const callers = graphStore.getCallers(seed.symbol);
                        expanded = 0;
                        for (const node of callers) {
                            if (expanded >= 5) break;
                            if (excludeRoles.includes(node.role)) continue;
                            const u = await this.stores.unitStore.getUnit(node.id);
                            if (u) {
                                this.addItem(itemsMap, this.unitToItem(u, 'graph_caller_expansion', 0.65, SemanticCategory.DEPENDENCY));
                                expanded++;
                            }
                        }
                    }

                    // Fallbacks
                    const fallbacks = graphStore.getFallbacks(seed.id);
                    expanded = 0;
                    for (const node of fallbacks) {
                        if (expanded >= 5) break;
                        if (excludeRoles.includes(node.role)) continue;
                        const u = await this.stores.unitStore.getUnit(node.id);
                        if (u) {
                            this.addItem(itemsMap, this.unitToItem(u, 'graph_fallback_expansion', 0.75, SemanticCategory.DEPENDENCY));
                            expanded++;
                        }
                    }

                    // Instantiations
                    if (seed.metadata?.className) {
                        const instantiations = graphStore.getInstantiations(seed.metadata.className);
                        expanded = 0;
                        for (const node of instantiations) {
                            if (expanded >= 5) break;
                            if (excludeRoles.includes(node.role)) continue;
                            const u = await this.stores.unitStore.getUnit(node.id);
                            if (u) {
                                this.addItem(itemsMap, this.unitToItem(u, 'graph_instantiation_expansion', 0.7, SemanticCategory.DEPENDENCY));
                                expanded++;
                            }
                        }
                    }
                }
            }

            // Step 6.6: Impact Analysis Graph Expansion via Semantic Impact Engine
            if (plan.queryType === 'impact_analysis' && this.stores.programGraphStore) {
                const graphStore = this.stores.programGraphStore;
                const evaluator = new UsageHeuristicEvaluator(this.stores.factStore);
                const engine = new SemanticImpactEngine(graphStore, evaluator);
                
                const targetHints = [...plan.symbolHints, ...plan.fileHints];
                let combinedAssessment: any = {
                    actionableFiles: [],
                    safeFiles: [],
                    ignoredFiles: [],
                    reasoning: {},
                    confidence: 'low',
                    evidence: []
                };

                for (const hint of targetHints) {
                    const assessment = await engine.assessImpact(hint, 'UNKNOWN');
                    
                    combinedAssessment.actionableFiles.push(...assessment.actionableFiles);
                    combinedAssessment.safeFiles.push(...assessment.safeFiles);
                    combinedAssessment.ignoredFiles.push(...assessment.ignoredFiles);
                    Object.assign(combinedAssessment.reasoning, assessment.reasoning);
                    
                    if (assessment.confidence === 'high') combinedAssessment.confidence = 'high';

                    // Convert actionable files to EvidenceItems
                    for (const fileStr of assessment.actionableFiles) {
                        const reason = assessment.reasoning[fileStr] || 'Actionable usage found';
                        const item: EvidenceItem = {
                            id: `impact_actionable_${fileStr}`,
                            file: this.normalizeFilePath(fileStr),
                            startLine: 0,
                            endLine: 0,
                            role: 'implementation',
                            type: 'impact_analysis',
                            content: `Actionable Impact Dependency\nFile: ${fileStr}\nReason: ${reason}\nThis file MUST be modified.`,
                            retrieval_signal: 'semantic_impact_actionable',
                            semanticCategory: SemanticCategory.DEPENDENCY,
                            score: 1.0,
                            confidence: 1.0,
                            extractionMethod: 'semantic_impact_engine'
                        };
                        this.addItem(itemsMap, item);
                    }
                    
                    // Convert safe files to EvidenceItems for context
                    for (const fileStr of assessment.safeFiles) {
                        const reason = assessment.reasoning[fileStr] || 'Safe usage found';
                        const item: EvidenceItem = {
                            id: `impact_safe_${fileStr}`,
                            file: this.normalizeFilePath(fileStr),
                            startLine: 0,
                            endLine: 0,
                            role: 'implementation',
                            type: 'impact_analysis',
                            content: `Safe Impact Dependency\nFile: ${fileStr}\nReason: ${reason}\nThis file is structurally connected but safe from modification.`,
                            retrieval_signal: 'semantic_impact_safe',
                            semanticCategory: SemanticCategory.DEPENDENCY,
                            score: 0.5,
                            confidence: 1.0,
                            extractionMethod: 'semantic_impact_engine'
                        };
                        this.addItem(itemsMap, item);
                    }
                }
                
                // Deduplicate lists
                combinedAssessment.actionableFiles = Array.from(new Set(combinedAssessment.actionableFiles));
                combinedAssessment.safeFiles = Array.from(new Set(combinedAssessment.safeFiles));
                combinedAssessment.ignoredFiles = Array.from(new Set(combinedAssessment.ignoredFiles));
                
                // Store in packet for LLM or downstream systems
                (itemsMap as any)._impactAssessment = combinedAssessment;
            }
        }

        // Step 5c: Annotation enrichment
        const annotationQueryTypes = ['flow', 'behavior_explanation', 'architecture_analysis', 'onboarding_analysis', 'dependency_injection'];
        if (this.stores.annotationStore && annotationQueryTypes.includes(plan.queryType)) {
            const currentFiles = new Set<string>();
            for (const item of itemsMap.values()) currentFiles.add(item.file);
            for (const fact of factsMap.values()) currentFiles.add(fact.file);

            for (const file of currentFiles) {
                const annotation = await this.stores.annotationStore.loadAnnotationByPath(file);
                if (annotation) {
                    const item: EvidenceItem = {
                        id: `annotation_${annotation.hash}`,
                        file: this.normalizeFilePath(annotation.file),
                        startLine: 0,
                        endLine: 0,
                        role: annotation.role as LogicalUnitRole,
                        unitId: '',
                        symbol: '',
                        type: 'annotation',
                        content: `Annotation: ${annotation.what}\nKey Symbols: ${(annotation.key_symbols||[]).join(', ')}\nDepends On: ${(annotation.depends_on||[]).join(', ')}`,
                        retrieval_signal: 'annotation_enrichment',
                        semanticCategory: SemanticCategory.ARCHITECTURE,
                        score: 0.8,
                        confidence: 0.9,
                        extractionMethod: 'llm_annotation'
                    };
                    this.addItem(itemsMap, item);
                }
            }
        }

        // Step 5d: Community summary
        const communityQueryTypes = ['architecture_analysis', 'onboarding_analysis', 'general_explanation'];
        if (this.stores.communityStore && communityQueryTypes.includes(plan.queryType)) {
            const communityFile = path.join(this.stores.communityStore, 'community_summaries.json');
            if (fs.existsSync(communityFile)) {
                try {
                    const data: CommunityClusteringOutput = JSON.parse(await fs.promises.readFile(communityFile, 'utf8'));
                    const currentFiles = new Set<string>();
                    for (const item of itemsMap.values()) currentFiles.add(item.file);
                    for (const fact of factsMap.values()) currentFiles.add(fact.file);

                    let bestCommunity = null;
                    let maxOverlap = 0;

                    for (const comm of data.communities) {
                        let overlap = 0;
                        for (const f of comm.files) {
                            if (currentFiles.has(f)) overlap++;
                        }
                        if (overlap > maxOverlap) {
                            maxOverlap = overlap;
                            bestCommunity = comm;
                        }
                    }

                    if (bestCommunity) {
                        const item: EvidenceItem = {
                            id: `community_${bestCommunity.id}`,
                            file: this.normalizeFilePath(bestCommunity.central_file),
                            startLine: 0,
                            endLine: 0,
                            role: 'implementation',
                            unitId: '',
                            symbol: bestCommunity.name,
                            type: 'community_summary',
                            content: `Community ${bestCommunity.name}:\n${bestCommunity.summary}`,
                            retrieval_signal: 'community_summary',
                            semanticCategory: SemanticCategory.COMMUNITY,
                            score: 0.85,
                            confidence: 0.9,
                            extractionMethod: 'community_clustering'
                        };
                        this.addItem(itemsMap, item);
                    }
                } catch (e) {
                    // Ignore parsing errors
                }
            }
        }

        // Step 7: Merge, dedupe, and rank
        const factsList = Array.from(factsMap.values()).sort(this.rankItems);
        const itemsList = Array.from(itemsMap.values()).sort(this.rankItems);

        // Step 8 & 9: Compute coverage against requiredEvidence and produce structured gaps
        const coverage: string[] = [];
        const gaps: string[] = [];
        const matchedEvidenceTypes: string[] = [];
        let matchedRequiredEvidence = 0;
        
        if (plan.queryType === 'unknown') {
            gaps.push('structured gaps');
        } else {
            const coveredTypes = new Set(factsList.map(f => f.type));
            for (const ft of plan.factTypes) {
                if (coveredTypes.has(ft)) {
                    coverage.push(`Found ${ft}`);
                } else {
                    gaps.push(`Missing ${ft}`);
                }
            }
            if (plan.symbolHints.length > 0) {
                let anySymbolFound = false;
                for (const hint of plan.symbolHints) {
                    if (hint === 'value' || hint === 'function' || hint === 'class') continue; // Skip generic words
                    const hintRegex = new RegExp(`\\b${hint}\\b`, 'i');
                    if (factsList.some(f => f.symbol === hint) || itemsList.some(i => i.symbol === hint || hintRegex.test(i.content))) {
                        anySymbolFound = true;
                        break;
                    }
                }
                if (!anySymbolFound && plan.symbolHints.some(h => h !== 'value' && h !== 'function' && h !== 'class')) {
                    gaps.push('structured gap: symbol not found');
                }
            }

            for (const req of plan.requiredEvidence) {
                let isMatched = false;
                if (req === 'fact evidence' && factsList.length > 0) isMatched = true;
                else if (req === 'source span evidence' && itemsList.length > 0) isMatched = true;
                else if (req === 'symbol evidence' && (itemsList.some(i => i.symbol) || factsList.some(f => f.symbol))) isMatched = true;
                else if (req === 'line spans' && itemsList.length > 0) isMatched = true;
                else if (req === 'fallback order facts' && factsList.some(f => f.type === 'fallback_chain')) isMatched = true;
                else if (req === 'instantiation details' && factsList.some(f => f.type === 'instantiation')) isMatched = true;
                else if (req === 'DI parameters' && factsList.some(f => f.type === 'dependency_injection')) isMatched = true;
                else if (req === 'exact prompt string' && factsList.some(f => f.type === 'prompt_template')) isMatched = true;
                else if (req === 'configuration keys' && factsList.some(f => f.type === 'config_value' || f.type === 'environment_variable')) isMatched = true;
                else if (req === 'function/method/class units' && itemsList.some(i => ['function', 'method', 'class'].includes(i.type))) isMatched = true;
                else if (req === 'fallback/guard facts' && factsList.some(f => f.type === 'guard_clause' || f.type === 'fallback_chain')) isMatched = true;
                else if (req === 'annotations' && itemsList.some(i => i.type === 'annotation')) isMatched = true;
                else if (req === 'readme' && itemsList.some(i => i.file.toLowerCase().includes('readme'))) isMatched = true;
                else if (req === 'community summaries' && itemsList.some(i => i.type === 'community_summary')) isMatched = true;
                else if (req === 'test implementations' && itemsList.some(i => i.role === 'test')) isMatched = true;
                else if (req === 'logical_unit' && itemsList.some(i => !['file', 'annotation', 'community_summary'].includes(i.type))) isMatched = true;
                else if (req === 'call_site' && (factsList.some(f => f.type === 'call_site') || itemsList.some(i => i.retrieval_signal === 'graph_dependent_expansion'))) isMatched = true;

                if (isMatched) {
                    matchedRequiredEvidence++;
                    matchedEvidenceTypes.push(req);
                }
            }
        }

        const coverageScore = plan.requiredEvidence.length > 0 ? matchedRequiredEvidence / plan.requiredEvidence.length : 0;

        // NOTE: `gaps`/`coverage` computed above (lines ~416-472) are intentionally
        // NOT threaded into the packet below -- that's pre-existing behavior this
        // change doesn't touch (resurrecting it would alter gap/coverage semantics
        // for every query type, a much larger blast radius than this pass covers).
        // Only two signals are surfaced here: the index-truncation gap, and now the
        // retrieval-provider-reported gaps (e.g. a meaningfully-weighted channel
        // that errored -- see HybridRetrievalProvider's degradedChannelGaps) --
        // both are opt-in signals a provider/builder step explicitly emits, not a
        // resurrection of the broader structural-gap computation above.
        const truncationGap = await this.getTruncationGap();
        const retrievalGaps = (retrievalResult?.gaps ?? []).map(gap => gap.message);

        const packet: EvidencePacket = {
            query,
            plan,
            items: Array.from(itemsMap.values()),
            facts: Array.from(factsMap.values()),
            coverage: [],
            gaps: [...(truncationGap ? [truncationGap] : []), ...retrievalGaps],
            diagnostics: ['Packet built successfully'],
            coverageScore: coverageScore,
            matchedEvidenceTypes: Array.from(matchedEvidenceTypes),
            impactAssessment: (itemsMap as any)._impactAssessment
        };

        return packet;
    }

    /**
     * Builds an EvidencePacket for explain_selection mode. Kept separate from buildPacket()
     * so the symbol/keyword-hint retrieval path used by every other query category is
     * untouched by this one distinct mode.
     */
    async buildExplainSelectionPacket(
        selection: NonNullable<EvidencePacket['selection']>,
        plan: EvidencePlan,
        retrievalResult?: RetrievalOrchestrationResult
    ): Promise<EvidencePacket> {
        const itemsMap = new Map<string, EvidenceItem>();
        const factsMap = new Map<string, EvidenceItem>();

        if (retrievalResult) {
            for (const item of retrievalResult.items) {
                const normalizedItem = { ...item, file: this.normalizeFilePath(item.file) };
                if (this.isFactEvidence(normalizedItem)) {
                    this.addItem(factsMap, normalizedItem, 'RetrievalOrchestrator');
                } else {
                    this.addItem(itemsMap, normalizedItem, 'RetrievalOrchestrator');
                }
            }
        }

        const itemsList = Array.from(itemsMap.values()).sort(this.rankItems);
        const factsList = Array.from(factsMap.values()).sort(this.rankItems);
        const truncationGap = await this.getTruncationGap();
        const retrievalGaps = (retrievalResult?.gaps ?? []).map(gap => gap.message);

        return {
            query: selection.text,
            plan,
            items: itemsList,
            facts: factsList,
            coverage: [],
            gaps: [...(truncationGap ? [truncationGap] : []), ...retrievalGaps],
            diagnostics: ['Explain-selection packet built successfully'],
            coverageScore: itemsList.length > 0 || factsList.length > 0 ? 1 : 0,
            matchedEvidenceTypes: [],
            selection
        };
    }

    private isFactEvidence(item: EvidenceItem): boolean {
        const normalized = item as EvidenceItem & { evidenceType?: string; provenance?: { sourceType?: string } };
        return Boolean(item.factId) ||
            KNOWN_FACT_TYPES.has(item.type as FactType) ||
            KNOWN_FACT_TYPES.has(normalized.evidenceType as FactType) ||
            KNOWN_FACT_TYPES.has(normalized.provenance?.sourceType as FactType);
    }
    private addItem(map: Map<string, EvidenceItem>, item: EvidenceItem, sourceDesc?: string) {
        const existing = map.get(item.id);
        if (existing) {
            console.log(`[Deduplication Trace] Overlapping evidence found for ${item.id} from ${sourceDesc || 'unknown'}. Existing score: ${existing.score}, New score: ${item.score}`);
        }
        if (!existing || existing.score < item.score) {
            if (!this.checkStale(item)) {
                map.set(item.id, item);
            } else {
                item.stale = true;
                map.set(item.id, item);
            }
        }
    }

    private checkStale(item: EvidenceItem): boolean {
        if (!this.stores.manifestStore || !item.file) return false;
        try {
            const absolutePath = path.isAbsolute(item.file) ? item.file : path.join(process.cwd(), item.file);
            const stat = fs.statSync(absolutePath);
            const relPath = path.relative(process.cwd(), absolutePath).replace(/\\/g, '/');
            const entry = this.stores.manifestStore.getEntry(relPath) || this.stores.manifestStore.getEntry(item.file.replace(/\\/g, '/'));
            if (!entry) return true;
            if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
                return true;
            }
            return false;
        } catch {
            return true;
        }
    }

    private unitToItem(unit: LogicalUnit, signal: string, score: number, category: SemanticCategory): EvidenceItem {
        return {
            id: unit.id,
            file: this.normalizeFilePath(unit.filePath),
            startLine: unit.startLine,
            endLine: unit.endLine,
            role: unit.role,
            unitId: unit.id,
            symbol: unit.symbol,
            type: unit.type,
            content: unit.content,
            retrieval_signal: signal,
            semanticCategory: category,
            score,
            confidence: 0.9,
            extractionMethod: unit.extractionMethod
        };
    }

    private factToItem(fact: FactRecord, signal: string, score: number, category: SemanticCategory): EvidenceItem {
        const contentStr = (fact.factType === 'list_count' || fact.factType === 'numeric_threshold')
            ? String(fact.value)
            : (fact.sourceText || String(fact.value));
        return {
            id: fact.factId,
            file: this.normalizeFilePath(fact.filePath),
            startLine: fact.startLine,
            endLine: fact.endLine,
            role: fact.role,
            factId: fact.factId,
            unitId: fact.unitId,
            symbol: fact.symbol,
            type: fact.factType,
            content: contentStr,
            retrieval_signal: signal,
            semanticCategory: category,
            score,
            confidence: fact.confidence,
            extractionMethod: fact.extractionMethod
        };
    }

    private heuristicFileRole(filePath: string): LogicalUnitRole {
        if (/test|spec|mock|fixture/i.test(filePath)) return 'test';
        if (/dist|out|build|generated|node_modules/i.test(filePath)) return 'generated';
        return 'implementation';
    }

    private rankItems = (a: EvidenceItem, b: EvidenceItem): number => {
        // High-confidence AST facts outrank regex facts
        const confMap = { 'high': 3, 'medium': 2, 'low': 1 };
        const confA = typeof a.confidence === 'string' ? (confMap[a.confidence as keyof typeof confMap] || 0) : Number(a.confidence);
        const confB = typeof b.confidence === 'string' ? (confMap[b.confidence as keyof typeof confMap] || 0) : Number(b.confidence);
        if (confA !== confB) {
            return confB - confA;
        }
        // Exact fact match outranks semantic/vector match
        if (a.score !== b.score) {
            return b.score - a.score;
        }
        // Implementation evidence outranks docs
        if (a.role === 'implementation' && b.role !== 'implementation') return -1;
        if (b.role === 'implementation' && a.role !== 'implementation') return 1;
        
        return 0;
    };
}
