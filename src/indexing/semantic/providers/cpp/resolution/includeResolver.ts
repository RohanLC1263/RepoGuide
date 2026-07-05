import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves a quoted `#include "..."` to a real file path. Unlike every
 * previous provider's import resolver, C++'s `#include` is a preprocessor
 * directive resolved via compiler include-path search order
 * (build-system-specific `-I` flags), not fully derivable from the file
 * alone -- this is a disclosed approximation, checking the including
 * file's own directory first (the standard quoted-include search order),
 * then a small set of conventional include roots (`<workspaceRoot>`,
 * `<workspaceRoot>/include`, `<workspaceRoot>/src`) as a best-effort stand-in
 * for a real `-I` path. Confirmed against real cpr code: `cpr/cookies.cpp`
 * includes `"cpr/cookies.h"`, which only resolves via the
 * `<workspaceRoot>/include` candidate root, not same-directory-relative --
 * this is real, not an edge case, since it's cpr's actual, consistent
 * layout convention (headers under `include/<lib>/`, sources under
 * `<lib>/`, tied together by a CMake `-I include` the parser can't see).
 */
export class CppIncludeResolver {
    public static resolveQuotedInclude(includePath: string, fromFilePath: string, workspaceRoot: string): string | null {
        const relCandidate = path.join(path.dirname(fromFilePath), includePath);
        if (fs.existsSync(relCandidate)) {
            return relCandidate;
        }
        const candidateRoots = [workspaceRoot, path.join(workspaceRoot, 'include'), path.join(workspaceRoot, 'src')];
        for (const root of candidateRoots) {
            const candidate = path.join(root, includePath);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * The first quoted `#include` in a .cpp/.cc/.cxx file's own source text --
     * confirmed via direct testing against the real cpr corpus that 100% of
     * its .cpp files include their own paired header first (matching the
     * documented Google C++ Style Guide convention), a far more reliable
     * pairing signal than directory-guessing the header's location from the
     * .cpp file's own path.
     */
    public static firstQuotedInclude(sourceText: string): string | null {
        const match = sourceText.match(/^\s*#include\s*"([^"]+)"/m);
        return match ? match[1] : null;
    }
}
