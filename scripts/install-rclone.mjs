import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import AdmZip from 'adm-zip';

const binDir = path.resolve('.bin');
const binPath = path.join(binDir, 'rclone');

if (fs.existsSync(binPath)) {
  console.log('rclone already installed in .bin');
  process.exit(0);
}

const archMap = { x64: 'amd64', arm64: 'arm64' };
const arch = archMap[process.arch];
if (!arch) throw new Error(`Unsupported architecture: ${process.arch}`);

const version = process.env.RCLONE_VERSION?.trim() || 'current';
const base = version === 'current'
  ? 'https://downloads.rclone.org/rclone-current-linux'
  : `https://downloads.rclone.org/${version}/rclone-${version}-linux`;
const url = `${base}-${arch}.zip`;

console.log(`Downloading rclone (${version}, ${arch})...`);
const response = await fetch(url);
if (!response.ok) throw new Error(`rclone download failed: ${response.status} ${response.statusText}`);

const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
const entry = zip.getEntries().find((item) => /\/rclone$/.test(item.entryName));
if (!entry) throw new Error('rclone binary was not found in downloaded archive');

fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(binPath, entry.getData(), { mode: 0o755 });
fs.chmodSync(binPath, 0o755);
console.log(`Installed rclone at ${binPath}`);
