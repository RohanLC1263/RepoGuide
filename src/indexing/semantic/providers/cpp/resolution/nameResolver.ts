import Parser = require('node-tree-sitter');
import { findEnclosingClass, functionDeclaratorName, isInsideFunctionBody, isOutOfClassDefinition, unwrapDeclarator, unwrapTypeReference } from '../astHelpers';

/**
 * Scope-based name lookup replacing a real compiler. Unlike every prior
 * provider, this resolver spans up to TWO parsed trees: this file's own,
 * and -- if this file is a .cpp with a resolved paired header -- that
 * header's tree too, since a class's own body (and its in-class method
 * prototypes) commonly live in a different file than the out-of-class
 * definitions that give those methods their real bodies. Overload-shaped
 * ambiguity (C++ genuinely supports overloading) is handled the same
 * defensive way established since the Java overload-collision fix:
 * candidates are tracked as lists, resolved only when unambiguous.
 */
export class CppNameResolver {
    private classesInThisFile = new Map<string, Parser.SyntaxNode>();
    private classesInPairedHeader = new Map<string, Parser.SyntaxNode>();
    private inClassMembersByClass = new Map<string, Map<string, Parser.SyntaxNode[]>>();
    private outOfClassMethodsByClass = new Map<string, Map<string, Parser.SyntaxNode[]>>();
    private freeFunctions = new Map<string, Parser.SyntaxNode[]>();

    constructor(root: Parser.SyntaxNode, pairedHeaderRoot: Parser.SyntaxNode | null) {
        this.indexTree(root, this.classesInThisFile, true);
        if (pairedHeaderRoot) {
            this.indexTree(pairedHeaderRoot, this.classesInPairedHeader, false);
        }
    }

    private indexTree(root: Parser.SyntaxNode, classesMap: Map<string, Parser.SyntaxNode>, includeOutOfClassAndFree: boolean): void {
        const visit = (node: Parser.SyntaxNode) => {
            if ((node.type === 'class_specifier' || node.type === 'struct_specifier') && !isInsideFunctionBody(node)) {
                this.indexClass(node, classesMap);
            } else if (includeOutOfClassAndFree && node.type === 'function_definition' && !isInsideFunctionBody(node)) {
                this.indexTopLevelFunction(node);
            }
            for (const child of node.namedChildren) {
                visit(child);
            }
        };
        for (const child of root.namedChildren) {
            visit(child);
        }
    }

    private indexClass(classNode: Parser.SyntaxNode, classesMap: Map<string, Parser.SyntaxNode>): void {
        const name = classNode.childForFieldName('name')?.text;
        const body = classNode.childForFieldName('body');
        if (!name || !body) {
            return;
        }
        classesMap.set(name, classNode);
        let members = this.inClassMembersByClass.get(name);
        if (!members) {
            members = new Map();
            this.inClassMembersByClass.set(name, members);
        }
        for (const member of body.namedChildren) {
            if (member.type !== 'function_definition' && member.type !== 'field_declaration' && member.type !== 'declaration') {
                continue;
            }
            const functionDeclarator = unwrapDeclarator(member.childForFieldName('declarator'));
            if (functionDeclarator?.type !== 'function_declarator') {
                continue;
            }
            const memberName = functionDeclaratorName(functionDeclarator);
            if (memberName) {
                this.addCandidate(members, memberName, member);
            }
        }
    }

    private indexTopLevelFunction(node: Parser.SyntaxNode): void {
        const functionDeclarator = unwrapDeclarator(node.childForFieldName('declarator'));
        if (functionDeclarator?.type !== 'function_declarator') {
            return;
        }
        if (isOutOfClassDefinition(functionDeclarator)) {
            const nameField = functionDeclarator.childForFieldName('declarator');
            const scopeNode = nameField?.childForFieldName('scope');
            const className = scopeNode ? unwrapTypeReference(scopeNode).text : null;
            const methodName = functionDeclaratorName(functionDeclarator);
            if (className && methodName) {
                let methods = this.outOfClassMethodsByClass.get(className);
                if (!methods) {
                    methods = new Map();
                    this.outOfClassMethodsByClass.set(className, methods);
                }
                this.addCandidate(methods, methodName, node);
            }
        } else if (!findEnclosingClass(node)) {
            const name = functionDeclaratorName(functionDeclarator);
            if (name) {
                this.addCandidate(this.freeFunctions, name, node);
            }
        }
    }

    private addCandidate(map: Map<string, Parser.SyntaxNode[]>, name: string, node: Parser.SyntaxNode): void {
        const existing = map.get(name);
        if (existing) {
            existing.push(node);
        } else {
            map.set(name, [node]);
        }
    }

    /** Resolves a bare class/struct name -- this file's own declaration first, then the paired header's (if any). */
    public resolveClass(name: string): Parser.SyntaxNode | null {
        return this.classesInThisFile.get(name) ?? this.classesInPairedHeader.get(name) ?? null;
    }

    /** True if `name` was found in the paired header specifically (vs. this file's own declarations) -- used to decide whether a cross-file KnownUnknown is warranted. */
    public isClassFromPairedHeader(name: string): boolean {
        return !this.classesInThisFile.has(name) && this.classesInPairedHeader.has(name);
    }

    /**
     * Resolves `ClassName::method`/`obj.method()` to a real declaration
     * (unambiguous only). Out-of-class .cpp definitions (which carry a real
     * body) are preferred over in-class prototypes (which may be
     * bodyless) when both exist for the same name.
     */
    public resolveMethodOnClass(className: string, methodName: string): Parser.SyntaxNode | null {
        const outOfClass = this.outOfClassMethodsByClass.get(className)?.get(methodName);
        if (outOfClass && outOfClass.length === 1) {
            return outOfClass[0];
        }
        const inClass = this.inClassMembersByClass.get(className)?.get(methodName);
        return inClass && inClass.length === 1 ? inClass[0] : null;
    }

    /** Resolves a bare call to a free function declared in this file (unambiguous only). */
    public resolveFreeFunction(name: string): Parser.SyntaxNode | null {
        const candidates = this.freeFunctions.get(name);
        return candidates && candidates.length === 1 ? candidates[0] : null;
    }
}
