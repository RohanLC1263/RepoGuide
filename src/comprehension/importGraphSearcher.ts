import * as fs from 'fs';
import * as path from 'path';
import { ImportGraph, ImportEdge } from './types';

export class ImportGraphSearcher {
    private graph: ImportGraph | null = null;
    private projectRoot = '';

    load(repoguideDir: string): void {
        this.projectRoot = path.dirname(repoguideDir);
        const graphPath = path.join(
            repoguideDir, 'understanding', 'import_graph.json'
        );
        if (fs.existsSync(graphPath)) {
            this.graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
        }
    }

    // What files import from the given file?
    getImporters(filePath: string): string[] {
        if (!this.graph) return [];
        const key = this.toGraphKey(filePath);
        return unique(
            this.graph.edges
                .filter(edge => edge.type !== 'external' && normalizeKey(edge.to) === key)
                .map(edge => this.toAbsolute(edge.from))
        );
    }

    // What files does the given file import from?
    getImports(filePath: string): ImportEdge[] {
        if (!this.graph) return [];
        const key = this.toGraphKey(filePath);
        return this.graph.edges.filter(e => normalizeKey(e.from) === key);
    }

    // What is the blast radius if file X changes?
    // Returns all files that directly import X
    getBlastRadius(filePath: string): string[] {
        return this.getImporters(filePath);
    }

    // Does fileA depend on fileB (directly)?
    dependsOn(fileA: string, fileB: string): boolean {
        const imports = this.getImports(fileA);
        const key = this.toGraphKey(fileB);
        return imports.some(e => normalizeKey(e.to) === key);
    }

    getAllFiles(): string[] {
        if (!this.graph) return [];
        return Object.entries(this.graph.nodes)
            .filter(([, node]) => !node.isExternal)
            .map(([filePath]) => this.toAbsolute(filePath));
    }

    private toAbsolute(filePath: string): string {
        if (path.isAbsolute(filePath) || !this.projectRoot) {
            return filePath;
        }
        return path.join(this.projectRoot, filePath);
    }

    private toGraphKey(filePath: string): string {
        if (path.isAbsolute(filePath) && this.projectRoot) {
            return normalizeKey(path.relative(this.projectRoot, filePath));
        }
        return normalizeKey(filePath);
    }
}

function normalizeKey(filePath: string): string {
    return path.normalize(filePath).replace(/\\/g, '/');
}

function unique(values: string[]): string[] {
    return Array.from(new Set(values));
}
