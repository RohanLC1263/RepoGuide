import * as path from 'path';
import * as fs from 'fs';
import { BehavioralPathIndex, BehavioralPath, ConceptMap } from './types';

export interface BehavioralSearchResult {
    path: BehavioralPath;
    score: number;
    matchReasons: string[];
}

export class BehavioralPathSearcher {
    private index: BehavioralPathIndex | null = null;
    private conceptMap: ConceptMap | null = null;

    load(repoguideDir: string): void {
        const indexPath = path.join(repoguideDir, 'understanding', 'behavioral_paths.json');
        if (fs.existsSync(indexPath)) {
            this.index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        }
        const conceptPath = path.join(repoguideDir, 'understanding', 'concept_map.json');
        if (fs.existsSync(conceptPath)) {
            this.conceptMap = JSON.parse(fs.readFileSync(conceptPath, 'utf8'));
        }
    }

    isLoaded(): boolean { return this.index !== null; }

    private stem(word: string): string {
        const w = word.toLowerCase();
        if (w.endsWith('ing')) return w.slice(0, -3);
        if (w.endsWith('ion')) return w.slice(0, -3);
        if (w.endsWith('ed')) return w.slice(0, -2);
        if (w.endsWith('er')) return w.slice(0, -2);
        if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
        return w;
    }

    private tokenize(text: string): string[] {
        return text.split(/[^a-zA-Z0-9]+/).filter(w => w.length > 2);
    }

    search(query: string, topK: number = 3): BehavioralSearchResult[] {
        if (!this.index) return [];

        const queryTokens = this.tokenize(query);
        const queryStems = new Set(queryTokens.map(t => this.stem(t)));
        const queryLower = query.toLowerCase();

        return this.index.paths
            .map(p => {
                let score = 0;
                const matchReasons: string[] = [];

                // 1. ENTRY POINT NAME MATCH (weight 0.35)
                const epTokens = this.tokenize(p.entryPointSymbol);
                const epStems = new Set(epTokens.map(t => this.stem(t)));
                const epIntersection = [...queryStems].filter(s => epStems.has(s)).length;
                const epUnion = new Set([...queryStems, ...epStems]).size;
                const jaccard = epUnion > 0 ? epIntersection / epUnion : 0;
                if (jaccard > 0) {
                    score += jaccard * 0.35;
                    matchReasons.push(`Entry point '${p.entryPointSymbol}' matches query tokens`);
                }

                // 2. CONCEPT MATCH (weight 0.25)
                if (this.conceptMap) {
                    const conceptsArray = Array.isArray(this.conceptMap.concepts) 
                        ? this.conceptMap.concepts 
                        : Object.values(this.conceptMap.concepts);
                    
                    const matchedConcepts = conceptsArray.filter((c: any) => {
                        const name = c.canonicalName || c.concept || '';
                        return queryLower.includes(name.toLowerCase()) || 
                               (c.synonyms || []).some((s: string) => queryLower.includes(s.toLowerCase()));
                    });
                    
                    if (matchedConcepts.length > 0) {
                        let linkedSteps = 0;
                        for (const concept of matchedConcepts as any[]) {
                            const hasLink = (concept.locations || []).some((loc: any) => 
                                p.happyPath.some(step => step.relativePath === loc.filePath || step.relativePath === loc.relativePath || (loc.symbolName && step.symbol === loc.symbolName) || (loc.symbol && step.symbol === loc.symbol))
                            );
                            if (hasLink) linkedSteps++;
                        }
                        const proportion = linkedSteps / matchedConcepts.length;
                        score += proportion * 0.25;
                        if (proportion > 0) {
                            matchReasons.push(`Concept match linked to ${linkedSteps} path steps`);
                        }
                    }
                }

                // 3. KEYWORD MATCH IN STEPS (weight 0.20)
                const stepTokens = new Set<string>();
                for (const step of p.happyPath) {
                    this.tokenize(step.description).forEach(t => stepTokens.add(t.toLowerCase()));
                }
                const queryTokensLower = queryTokens.map(t => t.toLowerCase());
                const stepIntersection = queryTokensLower.filter(t => stepTokens.has(t)).length;
                const stepProportion = queryTokensLower.length > 0 ? stepIntersection / queryTokensLower.length : 0;
                if (stepProportion > 0) {
                    score += stepProportion * 0.20;
                    matchReasons.push(`Step descriptions matched query tokens`);
                }

                // 4. MODULE ROLE MATCH (weight 0.10)
                const moduleKeywords = ['mission', 'auth', 'upload', 'database', 'orchestrator', 'service'];
                const queryModuleWords = moduleKeywords.filter(kw => queryLower.includes(kw));
                if (queryModuleWords.length > 0) {
                    const pathFilesStr = p.happyPath.map(s => s.relativePath).join(' ').toLowerCase();
                    const moduleMatches = queryModuleWords.filter(kw => pathFilesStr.includes(kw)).length;
                    const modProportion = moduleMatches / queryModuleWords.length;
                    if (modProportion > 0) {
                        score += modProportion * 0.10;
                        matchReasons.push(`Module roles matched query`);
                    }
                }

                // 5. ENTRY POINT TYPE MATCH (weight 0.10)
                let typeMatch = false;
                const epFileStr = p.entryPointFile.toLowerCase();
                const epSymStr = p.entryPointSymbol.toLowerCase();
                
                if ((queryLower.includes('api') || queryLower.includes('endpoint') || queryLower.includes('route')) && 
                    (epFileStr.includes('route') || epSymStr.includes('route'))) {
                    typeMatch = true;
                } else if ((queryLower.includes('background') || queryLower.includes('worker') || queryLower.includes('task')) && 
                           (epFileStr.includes('worker') || epFileStr.includes('task') || epSymStr.includes('task'))) {
                    typeMatch = true;
                } else if ((queryLower.includes('start') || queryLower.includes('launch') || queryLower.includes('run')) && 
                           (epSymStr.includes('start') || epSymStr.includes('run') || epSymStr.includes('launch') || epSymStr.includes('execute'))) {
                    typeMatch = true;
                }
                
                if (typeMatch) {
                    score += 0.10;
                    matchReasons.push(`Entry point type matched query intent`);
                }

                return { path: p, score, matchReasons };
            })
            .filter(r => r.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }
}
