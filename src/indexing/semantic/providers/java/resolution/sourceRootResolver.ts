import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves Java's package-based identity and import targets. Unlike
 * Python's moduleResolver (which must infer a namespace by walking for
 * __init__.py markers, with a confidence flag since it can be wrong), Java's
 * `package` declaration is explicit and authoritative: reading a file's own
 * package_declaration plus its own file path is enough to derive the
 * project's source root directly, with no ambiguity.
 */
export class JavaSourceRootResolver {
    /**
     * Given a file's own declared package (e.g. "com.example.demo") and its
     * path (e.g. ".../src/main/java/com/example/demo/Foo.java"), returns the
     * source root directory (".../src/main/java") such that
     * `sourceRoot/<dotted-to-slash path>.java` reconstructs any class in the
     * same source tree. Returns the file's own directory if there's no
     * package (default/unnamed package) or the path doesn't actually end
     * with the package's directory segments (unusual layout -- resolved
     * conservatively rather than guessed).
     */
    public static findSourceRoot(filePath: string, packageName: string): string {
        const fileDir = path.dirname(filePath);
        if (!packageName) {
            return fileDir;
        }
        const segments = packageName.split('.');
        // Walk up one directory per package segment (deepest segment last),
        // verifying each ancestor directory's name matches, so the walk
        // never has to reconstruct an absolute path (and risk mangling a
        // Windows drive letter) from split string segments.
        let dir = fileDir;
        for (let i = segments.length - 1; i >= 0; i--) {
            if (path.basename(dir) !== segments[i]) {
                return fileDir; // layout doesn't match the declared package -- don't guess
            }
            dir = path.dirname(dir);
        }
        return dir;
    }

    /**
     * Resolves a fully-qualified import (e.g. "com.example.util.Helper", or
     * "com.example.util.Helper.CONST" for a static import) to a real file
     * under `sourceRoot`, trying progressively shorter prefixes so a static
     * member import (whose last segment is a method/field, not a class)
     * still resolves to its containing class's file.
     */
    public static resolveImport(sourceRoot: string, fullyQualifiedName: string): string | null {
        const segments = fullyQualifiedName.split('.');
        for (let len = segments.length; len >= 1; len--) {
            const candidate = path.join(sourceRoot, ...segments.slice(0, len)) + '.java';
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return null;
    }
}
