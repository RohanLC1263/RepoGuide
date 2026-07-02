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

        for (const dep of context.dependencyEvidence) {
            blastRadius.push(dep.content);
            
            if (dep.file) affectedFiles.push(dep.file);
            if (dep.symbol) {
                affectedSymbols.push(dep.symbol);
                symbolFreqMap.set(dep.symbol, (symbolFreqMap.get(dep.symbol) || 0) + 1);
            }
        }

        // Graceful fallback to behavioral evidence if dependencies are missing or sparse
        if (context.dependencyEvidence.length === 0) {
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
        
        const dependentCount = context.dependencyEvidence.length;
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

        reasoningFactors.push(`Risk Level: ${riskLevel}`);
        reasoningFactors.push(`Computed Risk Score: ${riskScore} (Thresholds: <10 LOW, <50 MEDIUM, <200 HIGH, >=200 CRITICAL)`);
        reasoningFactors.push(`Reasoning: Change affects ${dependentCount} dependents across ${fileSpread} unique files. Peak symbol usage frequency is ${maxSymbolFrequency}.`);
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
                        warnings.push(`Module ${dep.file} exceeds 500 lines (${lines} lines). Consider refactoring.`);
                    }
                }
            }
        }

        // Identify hotspots based on file occurrence frequency
        for (const [file, freq] of fileFreqMap.entries()) {
            if (freq >= 10) {
                hotspots.push(file);
                warnings.push(`Hotspot detected: ${file} is heavily referenced (${freq} dependency edges). Consider splitting responsibilities.`);
                reasoningFactors.push(`Identified ${file} as an Architectural Hotspot due to high structural reference frequency (${freq}).`);
            }
        }

        reasoningFactors.push(`Analyzed ${context.dependencyEvidence.length} dependencies to find large modules (>500 lines) and structural hotspots (frequency >= 10).`);

        return {
            type: 'refactoring',
            dependencyRisks,
            largeModules,
            warnings,
            hotspots
        };
    }
}
