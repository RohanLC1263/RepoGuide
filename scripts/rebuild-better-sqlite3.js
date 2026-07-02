const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const workspaceRoot = process.cwd();
const betterSqliteDir = path.join(workspaceRoot, 'node_modules', 'better-sqlite3');

if (!fs.existsSync(betterSqliteDir)) {
    console.log('[Info] better-sqlite3 is not installed. Skipping native rebuild.');
    process.exit(0);
}

const electronVersion = process.env.REPOGUIDE_ELECTRON_VERSION || detectElectronVersion() || '39.8.7';
const prebuildInstallBin = resolvePrebuildInstallBin(betterSqliteDir);

if (!prebuildInstallBin) {
    console.warn('[Warn] Could not resolve prebuild-install for better-sqlite3. Run "npm install" and then "npm run rebuild:native".');
    process.exit(0);
}

console.log(`[Info] Rebuilding better-sqlite3 for Electron ${electronVersion}`);

const result = spawnSync(
    process.execPath,
    [prebuildInstallBin, '--force', '-r', 'electron', '-t', electronVersion],
    {
        cwd: betterSqliteDir,
        stdio: 'inherit',
        env: process.env
    }
);

if (result.status !== 0) {
    console.warn('[Warn] better-sqlite3 Electron rebuild failed. RepoGuide will disable the Q&A cache until you rerun "npm run rebuild:native".');
    process.exit(0);
}

console.log('[Info] better-sqlite3 Electron prebuild installed successfully.');

function resolvePrebuildInstallBin(baseDir) {
    try {
        return require.resolve('prebuild-install/bin.js', { paths: [baseDir, workspaceRoot] });
    } catch {
        return null;
    }
}

function detectElectronVersion() {
    const candidates = [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code'),
        path.join(process.env['ProgramFiles'] || '', 'Microsoft VS Code'),
        path.join('/', 'Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'package.json'),
        path.join('/', 'usr', 'share', 'code', 'resources', 'app', 'package.json')
    ];

    for (const candidate of candidates) {
        const packageJsonPath = resolveVsCodePackageJson(candidate);
        if (!packageJsonPath) {
            continue;
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            const version = parsed?.devDependencies?.electron;
            if (typeof version === 'string' && version.trim()) {
                return version.trim();
            }
        } catch {
            // Ignore broken installs and continue searching.
        }
    }

    return null;
}

function resolveVsCodePackageJson(candidate) {
    if (!candidate) {
        return null;
    }

    if (candidate.endsWith('package.json') && fs.existsSync(candidate)) {
        return candidate;
    }

    if (!fs.existsSync(candidate)) {
        return null;
    }

    const directPackage = path.join(candidate, 'resources', 'app', 'package.json');
    if (fs.existsSync(directPackage)) {
        return directPackage;
    }

    const entries = fs.readdirSync(candidate, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const nestedPackage = path.join(candidate, entry.name, 'resources', 'app', 'package.json');
        if (fs.existsSync(nestedPackage)) {
            return nestedPackage;
        }
    }

    return null;
}
