import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

export class TypeScriptProjectContext {
    private program: ts.Program | null = null;
    private compilerHost: ts.CompilerHost | null = null;
    private parsedCommandLine: ts.ParsedCommandLine | null = null;
    
    // Cache for SourceFiles to speed up incremental compilation
    private sourceFileCache = new Map<string, ts.SourceFile>();
    // Cache for file versions
    private fileVersions = new Map<string, number>();

    private isInitialized = false;
    private isDirty = false;

    constructor(private workspaceRoot: string) {}

    private init(): void {
        if (this.isInitialized) return;

        const configPath = ts.findConfigFile(
            this.workspaceRoot,
            ts.sys.fileExists,
            "tsconfig.json"
        );

        let options: ts.CompilerOptions = {
            allowJs: true,
            target: ts.ScriptTarget.Latest,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
        };

        let fileNames: string[] = [];

        if (configPath) {
            const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
            if (configFile.error) {
                console.error(`Error reading tsconfig.json:`, configFile.error.messageText);
            } else {
                this.parsedCommandLine = ts.parseJsonConfigFileContent(
                    configFile.config,
                    ts.sys,
                    path.dirname(configPath)
                );
                options = this.parsedCommandLine.options;
                fileNames = this.parsedCommandLine.fileNames;
            }
        }

        this.compilerHost = this.createCachingCompilerHost(options);
        this.program = ts.createProgram(fileNames, options, this.compilerHost);
        this.isInitialized = true;
    }

    private createCachingCompilerHost(options: ts.CompilerOptions): ts.CompilerHost {
        const host = ts.createCompilerHost(options);
        const originalGetSourceFile = host.getSourceFile;

        host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
            const normalizedPath = path.resolve(fileName).replace(/\\/g, '/');
            if (this.sourceFileCache.has(normalizedPath)) {
                return this.sourceFileCache.get(normalizedPath);
            }

            const sourceFile = originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
            if (sourceFile) {
                this.sourceFileCache.set(normalizedPath, sourceFile);
            }
            return sourceFile;
        };

        return host;
    }

    /** Returns the underlying ts.Program. Throws if initialization failed. */
    public getProgram(): ts.Program {
        this.init();
        if (this.isDirty) {
            this.rebuildProgram();
        }
        if (!this.program) {
            throw new Error("Failed to initialize ts.Program");
        }
        return this.program;
    }

    private rebuildProgram(): void {
        if (!this.parsedCommandLine || !this.compilerHost) return;
        this.program = ts.createProgram(
            this.parsedCommandLine.fileNames,
            this.parsedCommandLine.options,
            this.compilerHost,
            this.program || undefined // Pass old program to reuse other unmodified ASTs
        );
        this.isDirty = false;
    }

    /** Returns the centralized ts.TypeChecker. */
    public getTypeChecker(): ts.TypeChecker {
        return this.getProgram().getTypeChecker();
    }

    /** Marks a specific file path as dirty, forcing an incremental recompilation. */
    public invalidateFile(filePath: string): void {
        if (!this.isInitialized || !this.program || !this.compilerHost || !this.parsedCommandLine) return;

        const normalizedPath = path.resolve(filePath).replace(/\\/g, '/');
        
        // Remove from cache
        if (this.sourceFileCache.has(normalizedPath)) {
            this.sourceFileCache.delete(normalizedPath);
        }

        // Mark as dirty so it will be lazily rebuilt
        this.isDirty = true;
    }

    /** Forcefully clears all caches and destroys the compiler instance. */
    public dispose(): void {
        this.sourceFileCache.clear();
        this.fileVersions.clear();
        this.program = null;
        this.compilerHost = null;
        this.parsedCommandLine = null;
        this.isInitialized = false;
        this.isDirty = false;
    }

    /** Executes a semantic query safely, ensuring the program is up-to-date. */
    public executeSemanticQuery<T>(query: (checker: ts.TypeChecker) => T): T {
        // Ensure initialized
        this.init();
        // Since Node is single-threaded, we just execute synchronously.
        // Invalidation must happen outside of this synchronous execution.
        return query(this.getTypeChecker());
    }
}
