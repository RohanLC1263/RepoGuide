import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves C#'s namespace-based identity and `using` targets. Like Java's
 * sourceRootResolver, C#'s `namespace` declaration is explicit and
 * authoritative -- no confidence flag needed to derive a namespace, unlike
 * Python's best-effort __init__.py walk.
 *
 * Disclosed difference from Java: Java's compiler *enforces* one public
 * class per file matching the file name. C# has no such enforcement --
 * multiple types can live in one file, or a type's name can differ from
 * its file name. The directory-mirrors-namespace convention this resolver
 * assumes (matching Visual Studio/dotnet tooling defaults) is a strong
 * convention in most real projects, but not a guarantee, so `resolveImport`
 * will have a higher honest miss rate than Java's equivalent for imports
 * that exist in-project but aren't laid out 1-class-1-matching-file.
 */
export class CSharpNamespaceResolver {
    /**
     * Given a file's own declared namespace (e.g. "RestSharp.Authenticators")
     * and its path, returns the source root directory such that
     * `sourceRoot/<dotted-to-slash path>.cs` reconstructs any type in the
     * same source tree. Returns the file's own directory if there's no
     * namespace (global namespace) or the path doesn't actually end with
     * the namespace's directory segments (unusual layout -- resolved
     * conservatively rather than guessed).
     */
    public static findSourceRoot(filePath: string, namespaceName: string): string {
        const fileDir = path.dirname(filePath);
        if (!namespaceName) {
            return fileDir;
        }
        const segments = namespaceName.split('.');
        let dir = fileDir;
        for (let i = segments.length - 1; i >= 0; i--) {
            if (path.basename(dir) !== segments[i]) {
                return fileDir; // layout doesn't match the declared namespace -- don't guess
            }
            dir = path.dirname(dir);
        }
        return dir;
    }

    /**
     * Resolves a fully-qualified `using` target to a real file or directory
     * under `sourceRoot`. Real C# code overwhelmingly `using`s a *namespace*
     * (e.g. "using RestSharp.Authenticators;", matching a directory), not a
     * specific type -- confirmed empirically: an earlier version of this
     * resolver only checked for a matching .cs *file* and resolved zero
     * imports across a full 110-file corpus, since directory-shaped
     * namespace usings never matched. Checking for a matching directory
     * first (the common case) fixes that; the .cs file check remains for
     * the less common but valid "using a specific type" form. Tries
     * progressively shorter prefixes so a deeply-qualified using still
     * resolves to its nearest existing ancestor namespace/type.
     */
    public static resolveImport(sourceRoot: string, fullyQualifiedName: string): { resolvedPath: string; isNamespace: boolean } | null {
        const segments = fullyQualifiedName.split('.');
        for (let len = segments.length; len >= 1; len--) {
            const candidateBase = path.join(sourceRoot, ...segments.slice(0, len));
            if (fs.existsSync(candidateBase) && fs.statSync(candidateBase).isDirectory()) {
                return { resolvedPath: candidateBase, isNamespace: true };
            }
            const candidateFile = candidateBase + '.cs';
            if (fs.existsSync(candidateFile)) {
                return { resolvedPath: candidateFile, isNamespace: false };
            }
        }
        return null;
    }
}
