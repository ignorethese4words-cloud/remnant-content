import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MANIFEST = path.join(ROOT, 'media', 'controlled-media-manifest.json');
const INDEX = path.join(ROOT, 'pack-index.json');

function packFileForCounty(county) {
  return county.toLowerCase().replace(/ county$/i, '').replace(/[^a-z0-9]+/g, '-') + '-county.json';
}

function controlledUrl(relPath) {
  return `https://raw.githubusercontent.com/ignorethese4words-cloud/remnant-content/main/${relPath.replace(/\\/g, '/')}`;
}

async function download(url, destination) {
  const res = await fetch(url, { headers: { 'User-Agent': 'RemnantControlledMedia/1.0' } });
  if (!res.ok) throw new Error(`Media download failed ${res.status}: ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000) throw new Error(`Media download suspiciously small (${bytes.length} bytes): ${url}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const changedCounties = new Set();

for (const item of manifest.items || []) {
  const destination = path.join(ROOT, item.controlledPath);
  await download(item.sourceUrl, destination);

  const packPath = path.join(ROOT, 'packs', packFileForCounty(item.county));
  if (!fs.existsSync(packPath)) throw new Error(`Pack not found for ${item.county}: ${packPath}`);
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  const site = (pack.exploreSites || []).find((s) => s.id === item.siteId);
  if (!site) throw new Error(`Explore site not found: ${item.siteId}`);

  const url = controlledUrl(item.controlledPath);
  const image = {
    id: item.imageId,
    title: item.title,
    label: item.label || '',
    source: { uri: url },
    remoteUri: url,
    sourceNote: item.sourceNote,
  };

  const existing = Array.isArray(site.displayImages) ? site.displayImages : [];
  const withoutSame = existing.filter((img) => img?.id !== item.imageId);
  site.displayImages = [image, ...withoutSame];
  delete site.mediaNotice;
  fs.writeFileSync(packPath, JSON.stringify(pack, null, 2) + '\n');
  changedCounties.add(item.county);
}

for (const county of changedCounties) {
  const entry = (index.packs || []).find((p) => p.county === county);
  if (!entry) throw new Error(`Pack index entry not found: ${county}`);
  entry.version = Number(entry.version || 0) + 1;
  entry.packId = String(entry.packId || '').replace(/-v\d+$/i, '') + `-v${entry.version}`;
}
index.updatedAt = new Date().toISOString();
fs.writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n');

// Global invariant for approved app media: no external live dependency.
for (const item of manifest.items || []) {
  const expected = controlledUrl(item.controlledPath);
  if (!expected.includes('/remnant-content/main/media/')) throw new Error(`Controlled media URL invariant failed: ${expected}`);
}

console.log(`CONTROLLED MEDIA PROMOTION COMPLETE — ${manifest.items?.length || 0} images; ${changedCounties.size} county pack(s) bumped.`);
