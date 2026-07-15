/**
 * Resolves the local CraftConnect eval-repo path from the CRAFTCONNECT_PATH
 * environment variable.
 *
 * The eval/probe scripts in this folder run against a real local checkout of
 * the CraftConnect project, which is deliberately NOT part of this repository.
 * There is intentionally no hardcoded fallback path: a machine that hasn't set
 * CRAFTCONNECT_PATH fails loudly here, with instructions, instead of silently
 * pointing at a directory that only ever existed on the original author's
 * machine. See README/CONTRIBUTING for the one-time setup.
 */
export function getCraftConnectPath(): string {
    const value = process.env.CRAFTCONNECT_PATH;
    if (!value || value.trim() === '') {
        throw new Error(
            'CRAFTCONNECT_PATH is not set. This eval/probe script needs a local ' +
            'CraftConnect checkout to run against. Set it first, e.g.:\n' +
            '  PowerShell:    $env:CRAFTCONNECT_PATH = "C:\\path\\to\\CraftConnect"\n' +
            '  cmd.exe:       set CRAFTCONNECT_PATH=C:\\path\\to\\CraftConnect\n' +
            '  macOS/Linux:   export CRAFTCONNECT_PATH=/path/to/CraftConnect'
        );
    }
    return value;
}
