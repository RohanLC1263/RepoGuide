import { RepositoryContext } from '../context/repositoryContext';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { streamChat } from '../ollama/inferencer';

// ── Types ──────────────────────────────────────────────────────────────────

export type AnnotationRole =
    | 'entry_point' | 'route_handler' | 'service' | 'model'
    | 'middleware' | 'repository' | 'utility' | 'configuration'
    | 'interface' | 'test' | 'event_handler' | 'worker' | 'other';

export type AnnotationSignal =
    | 'mutates_state' | 'external_call' | 'async_pattern'
    | 'error_boundary' | 'security_sensitive' | 'side_effects'
    | 'performance_critical' | 'configuration';

export type AnnotationConfidence = 'high' | 'medium' | 'low';

export interface FileAnnotation {
    file: string;
    hash: string;
    generated_at: string;
    confidence: AnnotationConfidence;
    what: string;
    role: AnnotationRole;
    key_symbols: string[];
    depends_on: string[];
    signals: AnnotationSignal[];
}

// ── Valid enums ────────────────────────────────────────────────────────────

const VALID_ROLES = new Set<string>([
    'entry_point', 'route_handler', 'service', 'model',
    'middleware', 'repository', 'utility', 'configuration',
    'interface', 'test', 'event_handler', 'worker', 'other'
]);

const VALID_SIGNALS = new Set<string>([
    'mutates_state', 'external_call', 'async_pattern',
    'error_boundary', 'security_sensitive', 'side_effects',
    'performance_critical', 'configuration'
]);

const VALID_CONFIDENCES = new Set<string>(['high', 'medium', 'low']);

// ── Engine ─────────────────────────────────────────────────────────────────

export class FileAnnotationEngine {
    private annotationsDir: string;

    constructor(
        private readonly repoguideDir: string,
        private readonly workspaceRoot: string,
        private readonly context?: RepositoryContext
    ) {
        this.annotationsDir = path.join(repoguideDir, 'annotations');
    }

    /**
     * Truncate file content for the LLM prompt:
     * - If over 200 lines: first 150 lines + last 20 lines
     * - Otherwise: full content
     */
    private truncateContent(content: string): string {
        const lines = content.split('\n');
        if (lines.length <= 200) {
            return content;
        }
        const head = lines.slice(0, 150).join('\n');
        const tail = lines.slice(-20).join('\n');
        return `${head}\n\n... (${lines.length - 170} lines omitted) ...\n\n${tail}`;
    }

    /**
     * Detect a simple project type from workspace root heuristics.
     */
    private detectProjectType(): string {
        try {
            const pkgPath = path.join(this.workspaceRoot, 'package.json');
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                if (pkg.dependencies?.next || pkg.devDependencies?.next) return 'Next.js application';
                if (pkg.dependencies?.express || pkg.devDependencies?.express) return 'Express.js application';
                if (pkg.dependencies?.react || pkg.devDependencies?.react) return 'React application';
                if (pkg.dependencies?.vue || pkg.devDependencies?.vue) return 'Vue.js application';
                if (pkg.main || pkg.exports) return 'Node.js library';
                return 'Node.js project';
            }
            if (fs.existsSync(path.join(this.workspaceRoot, 'setup.py')) ||
                fs.existsSync(path.join(this.workspaceRoot, 'pyproject.toml'))) {
                return 'Python project';
            }
            if (fs.existsSync(path.join(this.workspaceRoot, 'Cargo.toml'))) return 'Rust project';
            if (fs.existsSync(path.join(this.workspaceRoot, 'go.mod'))) return 'Go project';
        } catch { /* ignore */ }
        return 'software project';
    }

    /**
     * Build the LLM prompt for annotation.
     */
    private buildPrompt(filePath: string, content: string): Array<{ role: string; content: string }> {
        const relPath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
        const projectType = this.detectProjectType();
        const truncated = this.truncateContent(content);

        const systemPrompt = `You are analyzing a source code file to produce a structured annotation. You must respond with ONLY a JSON object. No text before or after. No markdown. No explanation. Start your response with { and end it with }.`;

        const userPrompt = `File path: ${relPath}
Project type: ${projectType}

File content:
${truncated}

Produce this exact JSON:
{
  "what": "one sentence max 120 chars describing what this file does in project context",
  "role": "choose exactly one from: entry_point, route_handler, service, model, middleware, repository, utility, configuration, interface, test, event_handler, worker, other",
  "key_symbols": ["up to 8 names defined here that other files would import"],
  "depends_on": ["up to 12 names this file uses from other project files"],
  "signals": ["applicable signals only from: mutates_state, external_call, async_pattern, error_boundary, security_sensitive, side_effects, performance_critical, configuration"],
  "confidence": "high if clear, medium if uncertain, low if short or generated"
}

Rules:
- what must describe purpose not syntax
- key_symbols must be names not descriptions
- depends_on must be names not import paths
- signals must only use the listed values, plus configuration when the file primarily configures tools, packages, or runtime behavior
- role must be exactly one listed value
- test files always get role test
- files under 10 lines always get confidence low`;

        return [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];
    }

    /**
     * Call the LLM and collect the full response.
     */
    private async callLLM(messages: Array<{ role: string; content: string }>): Promise<string> {
        let result = '';
        for await (const chunk of streamChat(this.context!, messages)) {
            result += chunk;
        }
        return result.trim();
    }

    /**
     * Parse a JSON response from the LLM, with retry on failure.
     */
    private async parseWithRetry(
        messages: Array<{ role: string; content: string }>,
        relPath: string
    ): Promise<Record<string, any> | null> {
        console.log(`[DEBUG] Prompt for ${relPath}:`);
        console.log(JSON.stringify(messages, null, 2));

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                let raw = await this.callLLM(messages);
                console.log(`[DEBUG] Raw LLM response (attempt ${attempt + 1}):`);
                console.log(raw);

                // Strip markdown code fences if present
                raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

                // Strip any text before the first { character and after the last } character
                const firstBrace = raw.indexOf('{');
                const lastBrace = raw.lastIndexOf('}');
                
                if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
                    raw = raw.substring(firstBrace, lastBrace + 1);
                }

                const parsed = JSON.parse(raw);
                if (typeof parsed === 'object' && parsed !== null) {
                    console.log(`[DEBUG] JSON parsing succeeded.`);
                    return parsed;
                }
            } catch (e) {
                console.log(`[DEBUG] LLM call or parse failed: ${e}`);
                if (attempt === 0) {
                    this.context?.logger.warn(`[Warn] Annotation JSON parse failed, retrying...`);
                }
            }
        }
        return null;
    }

    /**
     * Validate and sanitize the parsed LLM response into a proper annotation.
     */
    private validate(
        parsed: Record<string, any>,
        relPath: string,
        hash: string,
        lineCount: number
    ): FileAnnotation {
        let failedFields = 0;

        // what
        let what = '';
        if (typeof parsed.what === 'string' && parsed.what.length > 0) {
            what = parsed.what.slice(0, 120);
        } else {
            what = `Source file: ${path.basename(relPath)}`;
            failedFields++;
        }

        // role
        let role: AnnotationRole = 'other';
        if (typeof parsed.role === 'string' && VALID_ROLES.has(parsed.role)) {
            role = parsed.role as AnnotationRole;
        } else {
            failedFields++;
        }

        // Force test role for test files
        const lower = relPath.toLowerCase();
        if (lower.includes('.test.') || lower.includes('.spec.') ||
            lower.includes('__tests__') || lower.includes('/test/') || lower.includes('/tests/')) {
            role = 'test';
        }

        // key_symbols
        let key_symbols: string[] = [];
        if (Array.isArray(parsed.key_symbols)) {
            key_symbols = parsed.key_symbols
                .filter((s: any) => typeof s === 'string' && s.length > 0 && s.length < 100)
                .slice(0, 8);
        } else {
            failedFields++;
        }

        // depends_on
        let depends_on: string[] = [];
        if (Array.isArray(parsed.depends_on)) {
            depends_on = parsed.depends_on
                .filter((s: any) => typeof s === 'string' && s.length > 0 && s.length < 100)
                .slice(0, 12);
        } else {
            failedFields++;
        }

        // signals
        let signals: AnnotationSignal[] = [];
        if (Array.isArray(parsed.signals)) {
            signals = parsed.signals
                .filter((s: any) => typeof s === 'string' && VALID_SIGNALS.has(s)) as AnnotationSignal[];
        } else {
            failedFields++;
        }

        // confidence
        let confidence: AnnotationConfidence = 'medium';
        if (typeof parsed.confidence === 'string' && VALID_CONFIDENCES.has(parsed.confidence)) {
            confidence = parsed.confidence as AnnotationConfidence;
        } else {
            failedFields++;
        }

        // Files under 10 lines always get confidence low
        if (lineCount < 10) {
            confidence = 'low';
        }

        // If more than 2 fields failed validation, set confidence to low
        if (failedFields > 2) {
            console.log(`[DEBUG] Validation failed: ${failedFields} fields failed validation. Confidence set to low.`);
            confidence = 'low';
        } else {
            console.log(`[DEBUG] Validation passed. Failed fields: ${failedFields}.`);
        }

        return {
            file: relPath,
            hash,
            generated_at: new Date().toISOString(),
            confidence,
            what,
            role,
            key_symbols,
            depends_on,
            signals
        };
    }

    /**
     * Annotate a single file. Returns the annotation object.
     */
    async annotateFile(filePath: string, content: string): Promise<FileAnnotation> {
        const relPath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        const lineCount = content.split('\n').length;

        const messages = this.buildPrompt(filePath, content);
        const parsed = await this.parseWithRetry(messages, relPath);

        let annotation: FileAnnotation;
        if (parsed) {
            annotation = this.validate(parsed, relPath, hash, lineCount);
            console.log(`[DEBUG] Produced validated annotation.`);
        } else {
            // LLM completely failed — produce a minimal low-confidence annotation
            console.log(`[DEBUG] Fallback triggered because parseWithRetry returned null.`);
            this.context?.logger.warn(`[Warn] Annotation LLM failed for ${relPath}, producing minimal annotation`);
            annotation = {
                file: relPath,
                hash,
                generated_at: new Date().toISOString(),
                confidence: 'low',
                what: `Source file: ${path.basename(relPath)}`,
                role: 'other',
                key_symbols: [],
                depends_on: [],
                signals: []
            };
        }

        // Persist to disk
        await this.saveAnnotation(annotation);
        return annotation;
    }

    /**
     * Save an annotation to .repoguide/annotations/{file_hash}.json
     */
    private async saveAnnotation(annotation: FileAnnotation): Promise<void> {
        await fs.promises.mkdir(this.annotationsDir, { recursive: true });
        const filename = `${annotation.hash}.json`;
        const filePath = path.join(this.annotationsDir, filename);
        await fs.promises.writeFile(filePath, JSON.stringify(annotation, null, 2), 'utf8');
    }

    /**
     * Load an annotation by file content hash.
     */
    async loadAnnotation(hash: string): Promise<FileAnnotation | null> {
        const filePath = path.join(this.annotationsDir, `${hash}.json`);
        if (!fs.existsSync(filePath)) return null;
        try {
            const raw = await fs.promises.readFile(filePath, 'utf8');
            return JSON.parse(raw) as FileAnnotation;
        } catch {
            return null;
        }
    }

    /**
     * Load an annotation by file relative path (scans all annotation files).
     */
    async loadAnnotationByPath(relPath: string): Promise<FileAnnotation | null> {
        if (!fs.existsSync(this.annotationsDir)) return null;
        const requested = relPath.replace(/\\/g, '/').toLowerCase();
        try {
            const files = await fs.promises.readdir(this.annotationsDir);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const raw = await fs.promises.readFile(path.join(this.annotationsDir, file), 'utf8');
                    const annotation = JSON.parse(raw) as FileAnnotation;
                    if (typeof annotation.file !== 'string') continue;
                    const annotated = annotation.file.replace(/\\/g, '/').toLowerCase();
                    if (
                        annotated === requested ||
                        requested.endsWith('/' + annotated) ||
                        requested.includes('/' + annotated)
                    ) {
                        return annotation;
                    }
                } catch { /* skip malformed */ }
            }
        } catch { /* ignore */ }
        return null;
    }

    /**
     * Get all annotations from disk.
     */
    async getAllAnnotations(): Promise<FileAnnotation[]> {
        if (!fs.existsSync(this.annotationsDir)) return [];
        const results: FileAnnotation[] = [];
        try {
            const files = await fs.promises.readdir(this.annotationsDir);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const raw = await fs.promises.readFile(path.join(this.annotationsDir, file), 'utf8');
                    results.push(JSON.parse(raw) as FileAnnotation);
                } catch { /* skip malformed */ }
            }
        } catch { /* ignore */ }
        return results;
    }

    /**
     * Delete annotation for a file by its hash.
     */
    async deleteAnnotation(hash: string): Promise<void> {
        const filePath = path.join(this.annotationsDir, `${hash}.json`);
        if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
        }
    }

    /**
     * Clear all annotations.
     */
    async clearAll(): Promise<void> {
        if (fs.existsSync(this.annotationsDir)) {
            const files = await fs.promises.readdir(this.annotationsDir);
            for (const file of files) {
                await fs.promises.unlink(path.join(this.annotationsDir, file));
            }
        }
    }

    /**
     * Annotate multiple files with concurrency control.
     * Limits concurrent LLM calls to avoid overloading Ollama.
     */
    async annotateFiles(
        files: Array<{ filePath: string; content: string }>,
        concurrency: number = 3
    ): Promise<FileAnnotation[]> {
        const results: FileAnnotation[] = [];
        let index = 0;

        const worker = async () => {
            while (index < files.length) {
                const current = index++;
                const { filePath, content } = files[current];
                try {
                    const annotation = await this.annotateFile(filePath, content);
                    results.push(annotation);
                    this.context?.logger.info(
                        `[Info] Annotated (${current + 1}/${files.length}): ${annotation.file} [${annotation.role}] [${annotation.confidence}]`
                    );
                } catch (e) {
                    this.context?.logger.error(`[Error] Annotation failed for ${filePath}: ${e}`);
                }
            }
        };

        const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
        await Promise.all(workers);
        return results;
    }
}
