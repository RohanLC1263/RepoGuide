import * as fs from 'fs';
import * as path from 'path';

export class ADRDiscoveryEngine {
    constructor(private workspaceRoot: string) {}

    /**
     * Finds all ADRs in standard paths.
     */
    public async discover(): Promise<string[]> {
        const adrPaths: string[] = [];
        
        // Typical ADR directories relative to root
        const searchDirs = [
            'docs/adr',
            'docs/adrs',
            'adr',
            'adrs',
            'architecture/decisions'
        ];

        for (const dir of searchDirs) {
            const absoluteDir = path.join(this.workspaceRoot, dir);
            if (fs.existsSync(absoluteDir)) {
                const files = await fs.promises.readdir(absoluteDir);
                for (const file of files) {
                    if (file.toLowerCase().endsWith('.md')) {
                        adrPaths.push(path.join(absoluteDir, file));
                    }
                }
            }
        }

        return adrPaths;
    }

    public isAdrFile(absolutePath: string): boolean {
        const relPath = path.relative(this.workspaceRoot, absolutePath).replace(/\\/g, '/');
        return /^(docs\/adrs?|adrs?|architecture\/decisions)\/[^\/]+\.md$/i.test(relPath);
    }
}
