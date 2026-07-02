import * as ts from 'typescript';

export class LocationMapper {
    public map(node: ts.Node, sourceFile: ts.SourceFile): { startLine: number, endLine: number } {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
        
        return {
            startLine: start.line + 1,
            endLine: end.line + 1
        };
    }
}
