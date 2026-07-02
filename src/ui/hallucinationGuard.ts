import * as fs from 'fs';
import { NavigationTarget } from '../comprehension/types';
import { LocationData } from '../query/responseParser';

export async function verifyLocations(locations: LocationData[]): Promise<LocationData[]> {
    try {
        const verified: LocationData[] = [];

        for (const location of locations) {
            try {
                await fs.promises.access(location.filePath);
                verified.push(location);
            } catch {
                console.warn(`[Warn] Hallucination guard: removed non-existent path ${location.filePath}`);
            }
        }

        return verified;
    } catch {
        return [];
    }
}

export async function verifyNavigationTargets(targets: NavigationTarget[]): Promise<NavigationTarget[]> {
    const verified: NavigationTarget[] = [];

    for (const target of targets) {
        try {
            await fs.promises.access(target.filePath, fs.constants.R_OK);
            const content = await fs.promises.readFile(target.filePath, 'utf8');
            const lineCount = content.split(/\r?\n/).length;

            if (target.startLine < 0 || target.endLine < target.startLine || target.startLine >= lineCount) {
                verified.push({
                    ...target,
                    startLine: Math.max(0, Math.min(target.startLine, lineCount - 1)),
                    endLine: Math.max(0, Math.min(target.endLine, lineCount - 1))
                });
            } else {
                verified.push(target);
            }
        } catch {
            console.warn(`[Warn] Hallucination guard: removed invalid navigation target ${target.filePath}`);
        }
    }

    return verified;
}
