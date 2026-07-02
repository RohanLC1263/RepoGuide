import * as ts from 'typescript';

export class DeclarationClassifier {
    public classify(node: ts.Node): 'class' | 'interface' | 'function' | 'method' | 'variable' | 'enum' | 'namespace' | 'type_alias' | null {
        if (ts.isClassDeclaration(node)) return 'class';
        if (ts.isInterfaceDeclaration(node)) return 'interface';
        if (ts.isFunctionDeclaration(node)) return 'function';
        if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method';
        if (ts.isVariableDeclaration(node)) return 'variable';
        if (ts.isEnumDeclaration(node)) return 'enum';
        if (ts.isModuleDeclaration(node)) return 'namespace';
        if (ts.isTypeAliasDeclaration(node)) return 'type_alias';
        return null;
    }
}
