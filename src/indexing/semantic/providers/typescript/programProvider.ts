import * as ts from 'typescript';
import { ProgramHandle, ProgramProvider } from './internalModels';

export class DefaultProgramProvider implements ProgramProvider {
    public getProgramHandle(filePath: string, content: string): ProgramHandle {
        // We create a single-file program for testing/fallback
        // In a real environment, this would retrieve from a language service or cache.
        const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
        
        const compilerHost: ts.CompilerHost = {
            getSourceFile: (name) => name === filePath ? sourceFile : undefined,
            getDefaultLibFileName: () => 'lib.d.ts',
            writeFile: () => {},
            getCurrentDirectory: () => '',
            getDirectories: () => [],
            getCanonicalFileName: (name) => name,
            useCaseSensitiveFileNames: () => true,
            getNewLine: () => '\n',
            fileExists: (name) => name === filePath,
            readFile: (name) => name === filePath ? content : undefined,
        };

        const program = ts.createProgram([filePath], {}, compilerHost);
        const typeChecker = program.getTypeChecker();
        const resolutionCache = new Map();

        return {
            program,
            sourceFile,
            typeChecker,
            resolutionCache
        };
    }
}
