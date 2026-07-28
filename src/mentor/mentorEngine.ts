import { 
    MentorContext, 
    MentorRecommendation, 
    ArchitectureRecommendation, 
    ChangeRecommendation, 
    OnboardingRecommendation, 
    RefactoringRecommendation, 
    MentorExplanationContext,
    RiskLevel 
} from './mentorTypes';

/**
 * Retrieval signals that represent a TRUE INBOUND DEPENDENT -- something that
 * calls/reads/imports/instantiates the subject, i.e. code that could break if the
 * subject changes. This is the only set that belongs in a blast-radius count.
 *
 * The DEPENDENCY evidence category is much broader than this: it also carries the
 * subject's OUTBOUND dependencies (`graph_callee_dependency`,
 * `graph_callee_expansion`, `*_target_dependency`), the subject's own anchor node
 * (`graph_symbol_node`), and its structural edges (`graph_contains`, ...). Counting
 * that whole bucket as "dependents" -- which this previously did -- inflated the
 * reported blast radius several-fold (verified on CraftConnect: ArtifactManager
 * reported "37 dependents across 23 files, CRITICAL" against a real graph-confirmed
 * count of 4) and pinned essentially every symbol at CRITICAL risk. A wrong number
 * presented as a computed risk score is more damaging than vague prose, so this
 * counts only what it can actually justify.
 */
const INBOUND_DEPENDENT_SIGNALS = new Set([
    // ProgramGraphProvider: inbound edges to the subject.
    'graph_caller_dependency',
    'graph_reader_dependency',
    'graph_import_dependency',
    'graph_instantiation_dependency',
    'graph_fallback_dependency',
    // EvidencePacketBuilder graph expansion: callers of a seed unit.
    'graph_caller_expansion',
    'graph_dependent_expansion'
]);

/**
 * SemanticImpactEngine signals: files judged TRANSITIVELY impacted by a change to
 * the subject. Real and useful, but a fundamentally different quantity from a
 * direct dependent -- e.g. for CraftConnect's `ArtifactManager` the graph has 4
 * direct dependents while the transitive set is 23 files (essentially every agent,
 * since they all inherit a base class that uses it). Folding those into the
 * headline "N dependents" number is what pinned nearly every symbol at CRITICAL.
 * They are counted and reported SEPARATELY, under their own honest label, rather
 * than discarded.
 */
const TRANSITIVE_IMPACT_SIGNALS = new Set([
    'semantic_impact_actionable',
    'semantic_impact_safe'
]);

export class MentorEngine {
    
    public process(context: MentorContext): MentorExplanationContext {
        let recommendation: MentorRecommendation;
        const reasoningFactors: string[] = [];

        switch (context.capability) {
            case 'architecture_mentor':
                recommendation = this.buildArchitectureRecommendation(context, reasoningFactors);
                break;
            case 'change_mentor':
                recommendation = this.buildChangeRecommendation(context, reasoningFactors);
                break;
            case 'onboarding_mentor':
                recommendation = this.buildOnboardingRecommendation(context, reasoningFactors);
                break;
            case 'refactoring_mentor':
                recommendation = this.buildRefactoringRecommendation(context, reasoningFactors);
                break;
            default:
                recommendation = this.buildArchitectureRecommendation(context, reasoningFactors);
        }

        return {
            recommendation,
            supportingEvidence: [...context.communityEvidence, ...context.architecturalEvidence, ...context.dependencyEvidence],
            reasoningFactors
        };
    }

    private buildArchitectureRecommendation(context: MentorContext, reasoningFactors: string[]): ArchitectureRecommendation {
        const majorComponents: string[] = [];
        const importantFiles: string[] = [];
        
        // Build frequency map
        const frequencyMap = new Map<string, number>();
        const addFreq = (key: string | undefined) => {
            if (key) {
                frequencyMap.set(key, (frequencyMap.get(key) || 0) + 1);
            }
        };

        context.communityEvidence.forEach(c => { addFreq(c.file); addFreq(c.symbol); });
        context.architecturalEvidence.forEach(a => { addFreq(a.file); addFreq(a.symbol); });
        context.dependencyEvidence.forEach(d => { addFreq(d.file); addFreq(d.symbol); });

        // Extract components from community summaries
        for (const comm of context.communityEvidence) {
            if (comm.symbol) {
                majorComponents.push(comm.symbol);
            } else {
                majorComponents.push(comm.content.substring(0, 50) + "...");
            }
        }

        // Extract files from annotations
        for (const ann of context.architecturalEvidence) {
            if (ann.file) {
                importantFiles.push(ann.file);
            }
        }

        const uniqueComponents = Array.from(new Set(majorComponents));
        const uniqueFiles = Array.from(new Set(importantFiles));

        // Sort descending by frequency score
        uniqueComponents.sort((a, b) => (frequencyMap.get(b) || 0) - (frequencyMap.get(a) || 0));
        uniqueFiles.sort((a, b) => (frequencyMap.get(b) || 0) - (frequencyMap.get(a) || 0));

        reasoningFactors.push(`Sorted ${uniqueComponents.length} components and ${uniqueFiles.length} files by structural importance metrics derived from community and annotation occurrences.`);

        // Determine reading order based on sorted files
        const readingOrder = uniqueFiles.slice(0, Math.min(5, uniqueFiles.length));

        return {
            type: 'architecture',
            majorComponents: uniqueComponents,
            importantFiles: uniqueFiles,
            suggestedReadingOrder: readingOrder,
            architectureSummary: `Architecture revolves around ${uniqueComponents[0] || 'core components'}, prioritizing ${readingOrder.length} files as structural entry points.`
        };
    }

    private buildChangeRecommendation(context: MentorContext, reasoningFactors: string[]): ChangeRecommendation {
        const blastRadius: string[] = [];
        const affectedFiles: string[] = [];
        const affectedSymbols: string[] = [];
        const symbolFreqMap = new Map<string, number>();

        // Only TRUE INBOUND dependents belong in a blast radius -- see
        // INBOUND_DEPENDENT_SIGNALS. Items with no retrievalSignal are kept so
        // non-graph dependency evidence (and any provider that predates signal
        // tagging) still contributes rather than silently vanishing.
        const inboundDependents = context.dependencyEvidence.filter(
            dep => dep.retrievalSignal === undefined || INBOUND_DEPENDENT_SIGNALS.has(dep.retrievalSignal)
        );

        for (const dep of inboundDependents) {
            blastRadius.push(dep.content);

            if (dep.file) affectedFiles.push(dep.file);
            if (dep.symbol) {
                affectedSymbols.push(dep.symbol);
                symbolFreqMap.set(dep.symbol, (symbolFreqMap.get(dep.symbol) || 0) + 1);
            }
        }

        // Graceful fallback to behavioral evidence if dependencies are missing or sparse
        if (inboundDependents.length === 0) {
            for (const beh of context.behavioralEvidence) {
                blastRadius.push(beh.content);
                if (beh.file) affectedFiles.push(beh.file);
                if (beh.symbol) {
                    affectedSymbols.push(beh.symbol);
                    symbolFreqMap.set(beh.symbol, (symbolFreqMap.get(beh.symbol) || 0) + 1);
                }
            }
        }

        const uniqueFiles = Array.from(new Set(affectedFiles));
        const uniqueSymbols = Array.from(new Set(affectedSymbols));
        
        const dependentCount = inboundDependents.length;
        const fileSpread = uniqueFiles.length;
        
        // Find max symbol frequency as a proxy for how heavily a specific symbol is relied upon
        let maxSymbolFrequency = 1;
        for (const freq of symbolFreqMap.values()) {
            if (freq > maxSymbolFrequency) maxSymbolFrequency = freq;
        }

        const riskScore = dependentCount * maxSymbolFrequency * fileSpread;

        let riskLevel: RiskLevel = 'LOW';
        if (riskScore >= 200) {
            riskLevel = 'CRITICAL';
        } else if (riskScore >= 50) {
            riskLevel = 'HIGH';
        } else if (riskScore >= 10) {
            riskLevel = 'MEDIUM';
        }

        // Transitively-impacted files, reported separately from the direct-dependent
        // count so the headline number stays honest (see TRANSITIVE_IMPACT_SIGNALS).
        const transitiveFiles = new Set(
            context.dependencyEvidence
                .filter(dep => dep.retrievalSignal !== undefined && TRANSITIVE_IMPACT_SIGNALS.has(dep.retrievalSignal))
                .map(dep => dep.file)
                .filter(Boolean)
        );

        reasoningFactors.push(`Risk Level: ${riskLevel}`);
        reasoningFactors.push(`Computed Risk Score: ${riskScore} (Thresholds: <10 LOW, <50 MEDIUM, <200 HIGH, >=200 CRITICAL)`);
        reasoningFactors.push(`Reasoning: Change affects ${dependentCount} direct dependents across ${fileSpread} unique files. Peak symbol usage frequency is ${maxSymbolFrequency}.`);
        if (transitiveFiles.size > 0) {
            reasoningFactors.push(`Additionally, ${transitiveFiles.size} file(s) are transitively impacted (indirect -- reached through intermediate dependencies, not direct references to this symbol).`);
        }
        if (riskLevel === 'CRITICAL') {
            reasoningFactors.push('CRITICAL Risk: This appears to be a core orchestrator or central routing component with massive downstream impact.');
        } else if (riskLevel === 'LOW') {
            reasoningFactors.push('LOW Risk: This appears to be a leaf utility with limited blast radius.');
        }

        return {
            type: 'change',
            blastRadius,
            affectedFiles: uniqueFiles,
            affectedSymbols: uniqueSymbols,
            riskLevel
        };
    }

    private buildOnboardingRecommendation(context: MentorContext, reasoningFactors: string[]): OnboardingRecommendation {
        const modules: string[] = [];
        const files: string[] = [];

        for (const comm of context.communityEvidence) {
            if (comm.symbol) modules.push(comm.symbol);
            if (comm.file) files.push(comm.file);
        }
        for (const ann of context.architecturalEvidence) {
            if (ann.file) files.push(ann.file);
        }

        // Fallback to behavioral evidence if strict architectural/community records are missing
        if (context.communityEvidence.length === 0 && context.architecturalEvidence.length === 0) {
            for (const beh of context.behavioralEvidence) {
                if (beh.symbol) modules.push(beh.symbol);
                if (beh.file) files.push(beh.file);
            }
        }

        const uniqueModules = Array.from(new Set(modules));
        const uniqueFiles = Array.from(new Set(files));

        const entryPoints: string[] = [];
        const coreRouting: string[] = [];
        const domainLogic: string[] = [];
        const specialized: string[] = [];

        for (const file of uniqueFiles) {
            const lowerFile = file.toLowerCase();
            if (lowerFile.includes('main') || lowerFile.includes('index') || lowerFile.includes('app') || lowerFile.includes('server')) {
                entryPoints.push(file);
            } else if (lowerFile.includes('router') || lowerFile.includes('controller') || lowerFile.includes('api')) {
                coreRouting.push(file);
            } else if (lowerFile.includes('service') || lowerFile.includes('agent') || lowerFile.includes('core')) {
                domainLogic.push(file);
            } else {
                specialized.push(file);
            }
        }

        const learningPath: string[] = [];
        if (entryPoints.length > 0) learningPath.push(...entryPoints.slice(0, 2));
        if (coreRouting.length > 0) learningPath.push(...coreRouting.slice(0, 2));
        if (domainLogic.length > 0) learningPath.push(...domainLogic.slice(0, 2));
        if (specialized.length > 0 && learningPath.length < 5) learningPath.push(...specialized.slice(0, 2));

        reasoningFactors.push(`Categorized ${uniqueFiles.length} annotated files using heuristic naming tiers: Entry Points (${entryPoints.length}), Core Routing (${coreRouting.length}), Domain Logic (${domainLogic.length}), Specialized (${specialized.length}).`);

        return {
            type: 'onboarding',
            modules: uniqueModules,
            learningPath: Array.from(new Set(learningPath)),
            firstFiles: entryPoints.length > 0 ? entryPoints : uniqueFiles.slice(0, 3)
        };
    }

    private buildRefactoringRecommendation(context: MentorContext, reasoningFactors: string[]): RefactoringRecommendation {
        const dependencyRisks: string[] = [];
        const largeModules: string[] = [];
        const warnings: string[] = [];
        const hotspots: string[] = [];
        
        const fileFreqMap = new Map<string, number>();

        for (const dep of context.dependencyEvidence) {
            dependencyRisks.push(dep.content);

            if (dep.file) {
                fileFreqMap.set(dep.file, (fileFreqMap.get(dep.file) || 0) + 1);

                if (dep.startLine !== undefined && dep.endLine !== undefined) {
                    const lines = dep.endLine - dep.startLine;
                    if (lines > 500 && !largeModules.includes(dep.file)) {
                        largeModules.push(dep.file);
                        // Describes the retrieved UNIT's span, which is what is actually
                        // measured here -- not the file's length. Reporting it as the file's
                        // line count was wrong twice over: it omits everything before the
                        // unit's start line, and a class body is not a file (it claimed
                        // story_generation_agent.py "exceeds 500 lines (599 lines)" from a
                        // 25-624 span of a 624-line file). MentorEngine has no filesystem
                        // access to get the real total, so it states only what it can.
                        warnings.push(`${dep.file} contains a single unit spanning ${lines} lines. Consider refactoring.`);
                    }
                }
            }
        }

        // Identify hotspots by how often a file appears in the RETRIEVED EVIDENCE.
        // fileFreqMap counts evidence items, which is not the same quantity as graph
        // dependency edges -- calling it "N dependency edges" reported 25 for
        // output_validator.py when exactly 2 files in the repo reference it. That is a
        // coupling claim the data cannot support, so the wording now states the
        // measured quantity (evidence-item frequency, a relevance signal) and the
        // suggestion is framed as something to check rather than a finding.
        for (const [file, freq] of fileFreqMap.entries()) {
            if (freq >= 10) {
                hotspots.push(file);
                warnings.push(`${file} appears in ${freq} retrieved evidence items for this question -- it may be carrying several responsibilities. Check its real dependents (get_dependents) before acting on this.`);
                reasoningFactors.push(`Flagged ${file} as a possible hotspot from evidence-item frequency (${freq}); this is a retrieval signal, not a measured dependency count.`);
            }
        }

        reasoningFactors.push(`Analyzed ${context.dependencyEvidence.length} evidence items to find large units (>500 lines) and possible hotspots (frequency >= 10).`);

        return {
            type: 'refactoring',
            dependencyRisks,
            largeModules,
            warnings,
            hotspots
        };
    }
}
