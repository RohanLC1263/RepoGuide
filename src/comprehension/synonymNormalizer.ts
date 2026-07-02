import * as vscode from 'vscode';
import { getProfile } from '../config/performanceConfig';
import { SynonymGroup } from './types';

const synonymCache = new Map<string, string[]>();

export async function normalizeSynonyms(
    concepts: string[],
    ollamaUrl: string,
    outputChannel?: vscode.OutputChannel
): Promise<SynonymGroup[]> {
    const uniqueConcepts = Array.from(new Set(concepts.map(normalizeTerm).filter(Boolean)));
    
    // Batch synonyms fetching
    const batchResults = await getBatchSynonyms(uniqueConcepts, ollamaUrl, outputChannel);
    
    const conceptEntries = uniqueConcepts.map(concept => ({
        concept,
        synonyms: batchResults.get(concept) ?? []
    }));

    const clusters = buildClusters(conceptEntries);

    return clusters.map(cluster => {
        const canonical = chooseCanonical(cluster);
        const synonymSet = new Set<string>();
        const partialMatchSet = new Set<string>();

        for (const entry of cluster) {
            if (entry.concept !== canonical) {
                synonymSet.add(entry.concept);
            }
            for (const synonym of entry.synonyms) {
                if (synonym !== canonical) {
                    synonymSet.add(synonym);
                }
                if (isPartialMatch(canonical, synonym)) {
                    partialMatchSet.add(synonym);
                }
            }
            if (isPartialMatch(canonical, entry.concept)) {
                partialMatchSet.add(entry.concept);
            }
        }

        partialMatchSet.delete(canonical);
        for (const synonym of synonymSet) {
            if (partialMatchSet.has(synonym) && !isPartialMatch(canonical, synonym)) {
                partialMatchSet.delete(synonym);
            }
        }

        return {
            canonical,
            synonyms: Array.from(synonymSet).filter(term => term !== canonical).slice(0, 20),
            partialMatches: Array.from(partialMatchSet).filter(term => term !== canonical).slice(0, 20)
        };
    });
}

async function getBatchSynonyms(
    concepts: string[],
    ollamaUrl: string,
    outputChannel?: vscode.OutputChannel
): Promise<Map<string, string[]>> {
    const BATCH_SIZE = 20;
    const results = new Map<string, string[]>();
    
    // Fill from cache first
    const neededConcepts: string[] = [];
    for (const concept of concepts) {
        const cached = synonymCache.get(concept);
        if (cached) {
            results.set(concept, cached);
        } else {
            neededConcepts.push(concept);
        }
    }

    if (neededConcepts.length === 0) {
        return results;
    }
    
    for (let i = 0; i < neededConcepts.length; i += BATCH_SIZE) {
        const batch = neededConcepts.slice(i, i + BATCH_SIZE);
        const prompt = [
            'For each concept below, list 3-5 developer search synonyms.',
            'Return ONLY a JSON object mapping each concept to its synonyms array:',
            '{"concept1": ["syn1","syn2"], "concept2": ["syn1"]}',
            '',
            ...batch.map(c => `- ${c}`)
        ].join('\n');
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s per batch
        
        try {
            const response = await fetch(`${ollamaUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: getProfile().planningModel,
                    prompt,
                    stream: false,
                    keep_alive: '5m'
                }),
                signal: controller.signal as RequestInit['signal']
            });
            
            clearTimeout(timeoutId);
            if (response.ok) {
                const data = await response.json() as { response?: string };
                const parsed = JSON.parse(
                    (data.response ?? '').replace(/^```json?\s*/gi, '').replace(/\s*```$/g, '').trim()
                );
                for (const [key, syns] of Object.entries(parsed)) {
                    if (Array.isArray(syns)) {
                        const normalizedKey = normalizeTerm(key);
                        const validSyns = syns.filter((s): s is string => typeof s === 'string')
                            .map(normalizeTerm)
                            .filter(Boolean)
                            .filter(s => s !== normalizedKey)
                            .slice(0, 10);
                        results.set(normalizedKey, validSyns);
                        synonymCache.set(normalizedKey, validSyns);
                    }
                }
            } else {
                outputChannel?.appendLine(`[Warn] Synonym batch failed: ${response.statusText}`);
            }
        } catch (error) {
            clearTimeout(timeoutId);
            outputChannel?.appendLine(`[Warn] Synonym batch skipped: ${error}`);
        }
        
        // Cache misses for this batch so we don't retry them if they failed
        for (const concept of batch) {
            if (!synonymCache.has(concept)) {
                synonymCache.set(concept, []);
                results.set(concept, []);
            }
        }
    }
    
    return results;
}



function buildClusters(
    entries: Array<{ concept: string; synonyms: string[] }>
): Array<Array<{ concept: string; synonyms: string[] }>> {
    const clusters: Array<Array<{ concept: string; synonyms: string[] }>> = [];

    for (const entry of entries) {
        const matchingClusters = clusters.filter(cluster =>
            cluster.some(existing => jaccardSimilarity(buildTermSet(existing), buildTermSet(entry)) > 0.5)
        );

        if (matchingClusters.length === 0) {
            clusters.push([entry]);
            continue;
        }

        const mergedCluster = [entry];
        for (const cluster of matchingClusters) {
            mergedCluster.push(...cluster);
        }

        for (const cluster of matchingClusters) {
            const index = clusters.indexOf(cluster);
            if (index >= 0) {
                clusters.splice(index, 1);
            }
        }

        clusters.push(deduplicateCluster(mergedCluster));
    }

    return clusters.map(deduplicateCluster);
}

function deduplicateCluster(
    cluster: Array<{ concept: string; synonyms: string[] }>
): Array<{ concept: string; synonyms: string[] }> {
    const byConcept = new Map<string, { concept: string; synonyms: string[] }>();
    for (const entry of cluster) {
        const existing = byConcept.get(entry.concept);
        if (!existing) {
            byConcept.set(entry.concept, entry);
            continue;
        }
        byConcept.set(entry.concept, {
            concept: entry.concept,
            synonyms: Array.from(new Set([...existing.synonyms, ...entry.synonyms]))
        });
    }
    return Array.from(byConcept.values());
}

function chooseCanonical(cluster: Array<{ concept: string; synonyms: string[] }>): string {
    return [...cluster].sort((a, b) => {
        const synonymDelta = b.synonyms.length - a.synonyms.length;
        if (synonymDelta !== 0) {
            return synonymDelta;
        }
        return a.concept.localeCompare(b.concept);
    })[0]?.concept ?? '';
}

function buildTermSet(entry: { concept: string; synonyms: string[] }): Set<string> {
    return new Set([entry.concept, ...entry.synonyms].map(normalizeTerm).filter(Boolean));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    const intersection = [...a].filter(value => b.has(value)).length;
    const union = new Set([...a, ...b]).size;
    return union === 0 ? 0 : intersection / union;
}

function normalizeTerm(value: string): string {
    return value.trim().toLowerCase();
}

function isPartialMatch(canonical: string, candidate: string): boolean {
    const left = normalizeTerm(canonical);
    const right = normalizeTerm(candidate);
    if (!left || !right || left === right) {
        return false;
    }
    return left.includes(right) || right.includes(left);
}
