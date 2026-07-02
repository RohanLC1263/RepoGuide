import * as fs from 'fs';
import * as path from 'path';
import { ConceptEntry, ConceptMap } from './types';
import { wrapArtifact, unwrapArtifact } from './schema-versions';

export function buildInvertedIndex(map: ConceptMap): Map<string, ConceptEntry[]> {
    const index = new Map<string, ConceptEntry[]>();

    for (const entry of map.concepts) {
        addToIndex(index, entry.concept, entry);
        for (const synonym of entry.synonyms) {
            addToIndex(index, synonym, entry);
        }
    }

    return index;
}

export async function saveConceptMap(map: ConceptMap, dir: string): Promise<void> {
    await fs.promises.mkdir(dir, { recursive: true });
    const envelope = wrapArtifact('concept_map.json', map);
    await fs.promises.writeFile(
        path.join(dir, 'concept_map.json'),
        JSON.stringify(envelope, null, 2),
        'utf8'
    );
}

export async function loadConceptMap(dir: string): Promise<ConceptMap | null> {
    const filePath = path.join(dir, 'concept_map.json');
    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        return unwrapArtifact<ConceptMap>(JSON.parse(raw));
    } catch {
        return null;
    }
}

function addToIndex(index: Map<string, ConceptEntry[]>, key: string, entry: ConceptEntry): void {
    const normalizedKey = key.toLowerCase().trim();
    if (!normalizedKey) {
        return;
    }

    const existing = index.get(normalizedKey) ?? [];
    if (!existing.includes(entry)) {
        existing.push(entry);
    }
    index.set(normalizedKey, existing);
}
