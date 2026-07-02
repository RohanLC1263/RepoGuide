import * as ts from 'typescript';

export class ModifierMapper {
    public map(node: ts.Node): { modifiers: string[], visibility: 'public' | 'private' | 'protected' | 'internal' } {
        const modifiers: string[] = [];
        let visibility: 'public' | 'private' | 'protected' | 'internal' = 'public'; // Default
        
        if (ts.canHaveModifiers(node)) {
            const mods = ts.getModifiers(node) || [];
            for (const mod of mods) {
                switch (mod.kind) {
                    case ts.SyntaxKind.PublicKeyword:
                        visibility = 'public';
                        break;
                    case ts.SyntaxKind.PrivateKeyword:
                        visibility = 'private';
                        break;
                    case ts.SyntaxKind.ProtectedKeyword:
                        visibility = 'protected';
                        break;
                    case ts.SyntaxKind.ExportKeyword:
                        modifiers.push('export');
                        break;
                    case ts.SyntaxKind.DefaultKeyword:
                        modifiers.push('default');
                        break;
                    case ts.SyntaxKind.StaticKeyword:
                        modifiers.push('static');
                        break;
                    case ts.SyntaxKind.AbstractKeyword:
                        modifiers.push('abstract');
                        break;
                    case ts.SyntaxKind.AsyncKeyword:
                        modifiers.push('async');
                        break;
                    case ts.SyntaxKind.ConstKeyword:
                        modifiers.push('const');
                        break;
                    case ts.SyntaxKind.ReadonlyKeyword:
                        modifiers.push('readonly');
                        break;
                }
            }
        }
        
        return { modifiers, visibility };
    }
}
