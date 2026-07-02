const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('Building better-sqlite3 for Electron...');
try {
  execSync('npx @electron/rebuild -f -w better-sqlite3', { stdio: 'inherit' });
} catch (e) {
  console.warn('Failed to rebuild for Electron with electron-rebuild. Trying prebuild-install...');
  execSync('node scripts/rebuild-better-sqlite3.js', { stdio: 'inherit' });
}

const buildDir = path.join(__dirname, '../node_modules/better-sqlite3/build');
const releaseDir = path.join(buildDir, 'Release');
const releaseElectronDir = path.join(buildDir, 'Release-electron');
const releaseFile = path.join(releaseDir, 'better_sqlite3.node');
const releaseElectronFile = path.join(releaseElectronDir, 'better_sqlite3.node');

if (fs.existsSync(releaseElectronFile)) {
  const eStat = fs.statSync(releaseElectronFile);
  const nStat = fs.statSync(releaseFile);
  
  console.log('Node binary size:', nStat.size);
  console.log('Electron binary size:', eStat.size);
  console.log('Node timestamp:', nStat.mtimeMs);
  console.log('Electron timestamp:', eStat.mtimeMs);

  if (eStat.size === nStat.size && eStat.mtimeMs === nStat.mtimeMs) {
    console.error('ERROR: Electron rebuild failed. Release-electron is identical to Release.');
    process.exit(1);
  }
}

fs.mkdirSync(releaseElectronDir, { recursive: true });
fs.copyFileSync(releaseFile, releaseElectronFile);

console.log('Restoring terminal Node build...');
execSync('npm rebuild better-sqlite3', { stdio: 'inherit' });

console.log('Dual binary setup verified successfully.');
