import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PACK_DIR = path.join(ROOT, 'packs');
const INDEX_PATH = path.join(ROOT, 'pack-index.json');
const REPORT_PATH = path.join(ROOT, 'media', 'external-promotion-report.json');
const CONTROLLED_PREFIX = 'https://raw.githubusercontent.com/ignorethese4words-cloud/remnant-content/main/media/';

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const m = pathname.match(/\.(jpg|jpeg|png|webp|gif|tif|tiff)$/i);
    if (m) return m[1] === 'jpeg' ? 'jpg' : m[1];
  } catch {}
  return 'jpg';
}

function liveUri(image) {
  return String(image?.remoteUri || image?.source?.uri || image?.uri || '').trim();
}

function isExternal(uri) {
  return /^https?:\/\//i.test(uri) && !uri.startsWith(CONTROLLED_PREFIX);
}

async function fetchBytes(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'RemnantControlledMedia/2.0 (historical preservation app; media ingestion)',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get('content-type') || '';
  if (!type.startsWith('image/') && type !== 'application/octet-stream') {
    throw new Error(`unexpected content-type ${type || 'unknown'}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1000) throw new Error(`suspiciously small file (${bytes.length} bytes)`);
  return bytes;
}

const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  promoted: [],
  skipped: [],
};
const changedCounties = new Set();

for (const filename of fs.readdirSync(PACK_DIR).filter((f) => f.endsWith('.json')).sort()) {
  const packPath = path.join(PACK_DIR, filename);
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  let packChanged = false;

  for (const site of pack.exploreSites || []) {
    const images = Array.isArray(site.displayImages) ? site.displayImages : [];
    for (let i = 0; i < images.length; i += 1) {
      const image = images[i];
      const uri = liveUri(image);
      if (!isExternal(uri)) continue;

      const imageId = String(image?.id || `image-${i + 1}`);
      const ext = extFromUrl(uri);
      const countySlug = slug(String(pack.county || filename).replace(/ county$/i, ''));
      const relPath = `media/${countySlug}/${slug(site.id)}/${slug(imageId)}.${ext}`;
      const destPath = path.join(ROOT, relPath);

      try {
        const bytes = await fetchBytes(uri);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, bytes);
        const controlledUrl = `https://raw.githubusercontent.com/ignorethese4words-cloud/remnant-content/main/${relPath}`;
        images[i] = {
          ...image,
          source: { ...(typeof image.source === 'object' && image.source ? image.source : {}), uri: controlledUrl },
          remoteUri: controlledUrl,
          originalSourceUrl: image.originalSourceUrl || uri,
        };
        report.promoted.push({ county: pack.county, siteId: site.id, imageId, from: uri, to: controlledUrl, bytes: bytes.length });
        packChanged = true;
      } catch (error) {
        report.skipped.push({ county: pack.county, siteId: site.id, imageId, uri, reason: String(error?.message || error) });
      }
    }
  }

  if (packChanged) {
    fs.writeFileSync(packPath, JSON.stringify(pack, null, 2) + '\n');
    changedCounties.add(pack.county);
  }
}

for (const county of changedCounties) {
  const entry = (index.packs || []).find((p) => p.county === county);
  if (!entry) continue;
  entry.version = Number(entry.version || 0) + 1;
  entry.packId = String(entry.packId || '').replace(/-v\d+$/i, '') + `-v${entry.version}`;
}

if (changedCounties.size) {
  index.updatedAt = new Date().toISOString();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n');
}

fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');

console.log(`GLOBAL EXTERNAL MEDIA PROMOTION — promoted ${report.promoted.length}; skipped ${report.skipped.length}; changed ${changedCounties.size} county pack(s).`);
for (const item of report.skipped) console.log(`SKIPPED ${item.county} / ${item.siteId} / ${item.imageId}: ${item.reason}`);
