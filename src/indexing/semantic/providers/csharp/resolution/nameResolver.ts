import Parser = require('node-tree-sitter');
import { findEnclosingTypeDeclaration } from '../astHelpers';

/**
 * Scope-based name lookup replacing a real type checker -- C# has no
 * embeddable equivalent, so resolution here is confined to same-file
 * declarations only: top-level types (for `new Foo()` / base-list entries)
 * and methods declared directly in a given type (for bare/`this.`/`this(...)`
 * calls). Method/constructor names are indexed as lists, not single nodes
 * -- a name with more than one declaration (overloaded methods, or any
 * constructor name once a class has 2+ constructors) resolves to null
 * rather than guessing which overload was meant, the same overload-safety
 * fix made for Java's resolver after finding it silently collided on
 * overloaded names. No inherited-member resolution, no cross-file
 * resolution -- an unresolved lookup returns null, which callers turn
 * into a KnownUnknown, not a guess.
 */
export class CSharpNameResolver {
    private topLevelTypes = new Map<string, Parser.SyntaxNode>();
    private methodsByType = new Map<string, Map<string, Parser.SyntaxNode[]>>();

    constructor(root: Parser.SyntaxNode) {
        for (const child of root.namedChildren) {
            this.indexTopLevel(child);
        }
    }

    private indexTopLevel(node: Parser.SyntaxNode): void {
        if (node.type === 'namespace_declaration' || node.type === 'file_scoped_namespace_declaration') {
            const body = node.childForFieldName('body');
            if (body) {
                for (const child of body.namedChildren) {
                    this.indexTopLevel(child);
                }
            }
            return;
        }
        if (this.isTypeDeclaration(node)) {
            this.indexType(node);
        }
    }

    private isTypeDeclaration(node: Parser.SyntaxNode): boolean {
        return node.type === 'class_declaration' || node.type === 'struct_declaration' || node.type === 'interface_declaration' || node.type === 'record_declaration' || node.type === 'enum_declaration';
    }

    private indexType(typeNode: Parser.SyntaxNode): void {
        const name = typeNode.childForFieldName('name')?.text;
        if (!name) {
            return;
        }
        this.topLevelTypes.set(name, typeNode);

        const body = typeNode.childForFieldName('body');
        if (!body) {
            return;
        }
        const methods = new Map<string, Parser.SyntaxNode[]>();
        for (const member of body.namedChildren) {
            if (member.type === 'method_declaration' || member.type === 'constructor_declaration') {
                const methodName = member.childForFieldName('name')?.text;
                if (methodName) {
                    const existing = methods.get(methodName);
                    if (existing) {
                        existing.push(member);
                    } else {
                        methods.set(methodName, [member]);
                    }
                }
            } else if (this.isTypeDeclaration(member)) {
                // Nested types are indexed for their own members too, but not
                // registered under topLevelTypes -- resolving `new Inner()`
                // from outside its enclosing type is out of scope (same
                // same-file-only, no-nesting-aware-lookup tier as Java).
                this.indexType(member);
            }
        }
        this.methodsByType.set(name, methods);
    }

    /** Resolves a bare type name to a top-level class/struct/interface/record/enum declaration in this file. */
    public resolveTopLevelType(name: string): Parser.SyntaxNode | null {
        return this.topLevelTypes.get(name) ?? null;
    }

    /**
     * Resolves a bare/`this.`/`this(...)` call to the method/constructor
     * declared directly in the enclosing type -- only when `methodName` is
     * unambiguous (exactly one declaration with that name) in that type.
     */
    public resolveMethodOnEnclosingType(callSiteNode: Parser.SyntaxNode, methodName: string): Parser.SyntaxNode | null {
        const enclosingType = findEnclosingTypeDeclaration(callSiteNode);
        if (!enclosingType) {
            return null;
        }
        const typeName = enclosingType.childForFieldName('name')?.text;
        if (!typeName) {
            return null;
        }
        const candidates = this.methodsByType.get(typeName)?.get(methodName);
        return candidates && candidates.length === 1 ? candidates[0] : null;
    }
}
