import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PATCH_DIR = path.join(ROOT, 'patches', 'pending');
const PACK_DIR = path.join(ROOT, 'packs', 'canonical');
const INDEX_PATH = path.join(ROOT, 'pack-index.json');

function fail(message) {
  console.error(`PUBLIC SITE PATCH MERGE FAILED — ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`cannot parse ${path.relative(ROOT, file)}: ${error.message}`);
  }
}

function isoTime(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function publicText(site) {
  const parts = [];
  if (Array.isArray(site.overview)) parts.push(...site.overview);
  if (Array.isArray(site.timeline)) parts.push(...site.timeline.map((item) => item?.text));
  if (Array.isArray(site.moreHistory)) parts.push(...site.moreHistory);
  return parts.filter((value) => typeof value === 'string').join('\n');
}

function validateSite(site, patchName) {
  if (!site || typeof site !== 'object' || Array.isArray(site)) fail(`${patchName}: site must be an object`);
  if (!site.id || typeof site.id !== 'string' || !site.id.startsWith('CO-')) fail(`${patchName}: invalid Colorado site.id`);
  if (!site.name || typeof site.name !== 'string') fail(`${patchName}: missing site.name`);
  if (!site.county || typeof site.county !== 'string') fail(`${patchName}: missing site.county`);
  if (site.tier !== 'ID ONLY' && site.tier !== 'EXPLORE') fail(`${patchName}: tier must be ID ONLY or EXPLORE for ${site.id}`);

  if (site.tier === 'ID ONLY' && (site.appReady !== false || site.betaVisible !== false)) {
    fail(`${patchName}: ID ONLY requires appReady=false and betaVisible=false for ${site.id}`);
  }
  if (site.tier === 'EXPLORE' && (site.appReady !== true || site.betaVisible !== true)) {
    fail(`${patchName}: EXPLORE requires appReady=true and betaVisible=true for ${site.id}`);
  }

  const lat = site.coordinates?.latitude;
  const lon = site.coordinates?.longitude;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    fail(`${patchName}: invalid coordinates for ${site.id}`);
  }

  if (!Array.isArray(site.overview) || !site.overview.some((value) => typeof value === 'string' && value.trim())) {
    fail(`${patchName}: public overview is required for ${site.id}`);
  }
  if (site.tier === 'EXPLORE') {
    const hasTimeline = Array.isArray(site.timeline) && site.timeline.some((item) => typeof item?.text === 'string' && item.text.trim());
    const hasMoreHistory = Array.isArray(site.moreHistory) && site.moreHistory.some((value) => typeof value === 'string' && value.trim());
    if (!hasTimeline && !hasMoreHistory) fail(`${patchName}: EXPLORE requires meaningful historical content for ${site.id}`);
  }

  const forbidden = /\b(?:G(?:10|[1-9])|work queue|queue status|worker(?: 1| 2)?|staging|debug|package management|scan anchor|for remnant identification|remnant identification|queued for app update)\b/i;
  if (forbidden.test(publicText(site))) fail(`${patchName}: public-facing content contains internal workflow language for ${site.id}`);

  if (!Array.isArray(site.displayImages)) fail(`${patchName}: displayImages must be an array`);
  if (site.displayImages.length === 0) {
    if (site.mediaSearchStatus !== 'SEARCH_EXHAUSTED' || site.mediaNotice !== 'Historic image not available') {
      fail(`${patchName}: empty media requires approved SEARCH_EXHAUSTED placeholder state for ${site.id}`);
    }
  } else {
    if (site.mediaSearchStatus !== 'FOUND_USABLE_MEDIA') fail(`${patchName}: packaged media requires FOUND_USABLE_MEDIA for ${site.id}`);
    for (const image of site.displayImages) {
      const uri = image?.remoteUri ?? image?.source?.uri;
      if (!image?.id || !image?.title || !uri || !image?.sourcePage || !image?.sourceNote || !image?.rights || image?.mediaStatus !== 'PACKAGED') {
        fail(`${patchName}: incomplete media contract for ${site.id}`);
      }
    }
  }

  if (!site.contentUpdatedAt || isoTime(site.contentUpdatedAt) === null) fail(`${patchName}: missing/invalid contentUpdatedAt for ${site.id}`);
}

function counts(pack) {
  let exploreSiteCount = 0;
  let idOnlySiteCount = 0;
  for (const site of pack.sites) {
    if (site?.appReady === true && site?.betaVisible === true) exploreSiteCount += 1;
    else if (Number.isFinite(site?.coordinates?.latitude) && Number.isFinite(site?.coordinates?.longitude)) idOnlySiteCount += 1;
  }
  return { siteCount: pack.sites.length, exploreSiteCount, idOnlySiteCount };
}

if (!fs.existsSync(PATCH_DIR)) {
  console.log('PUBLIC SITE PATCH MERGE — no pending patch directory');
  process.exit(0);
}

const patchFiles = fs.readdirSync(PATCH_DIR).filter((name) => name.endsWith('.json')).sort();
if (patchFiles.length === 0) {
  console.log('PUBLIC SITE PATCH MERGE — no pending patches');
  process.exit(0);
}

if (!fs.existsSync(INDEX_PATH)) fail('pack-index.json is missing');
const index = readJson(INDEX_PATH);
if (!Array.isArray(index.packs)) fail('pack-index.json has no packs array');

let merged = 0;
const touched = [];

for (const patchName of patchFiles) {
  const patchPath = path.join(PATCH_DIR, patchName);
  const patch = readJson(patchPath);
  const countySlug = patch?.countySlug;
  const site = patch?.site;
  if (!countySlug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(countySlug)) fail(`${patchName}: invalid countySlug`);
  validateSite(site, patchName);

  const countyLabel = site.county.endsWith(' County') ? site.county : `${site.county} County`;
  const packPath = path.join(PACK_DIR, `colorado-${countySlug}.json`);
  let pack;
  if (fs.existsSync(packPath)) {
    pack = readJson(packPath);
    if (!Array.isArray(pack.sites)) fail(`${patchName}: ${countySlug} public pack has no sites array`);
  } else {
    pack = {
      schemaVersion: 1,
      id: `colorado-${countySlug}`,
      county: countyLabel,
      state: 'Colorado',
      version: '0',
      generatedAt: new Date().toISOString(),
      sites: []
    };
  }

  const matching = pack.sites.map((s, i) => s?.id === site.id ? i : -1).filter((i) => i >= 0);
  if (matching.length > 1) fail(`${patchName}: duplicate public Site ID ${site.id} in ${countySlug} pack`);

  if (matching.length === 1) {
    const existing = pack.sites[matching[0]];
    const incomingTs = isoTime(site.contentUpdatedAt);
    const existingTs = isoTime(existing?.contentUpdatedAt);
    if (existingTs !== null && incomingTs !== null && incomingTs < existingTs) {
      fail(`${patchName}: incoming ${site.id} is older than existing public content`);
    }
    pack.sites[matching[0]] = site;
  } else {
    pack.sites.push(site);
  }

  if (pack.sites.filter((s) => s?.id === site.id).length !== 1) fail(`${patchName}: post-merge uniqueness check failed for ${site.id}`);

  const oldVersion = Number.parseInt(String(pack.version ?? '0'), 10);
  pack.version = String(Number.isFinite(oldVersion) ? oldVersion + 1 : 1);
  const now = new Date().toISOString();
  pack.generatedAt = now;
  fs.mkdirSync(PACK_DIR, { recursive: true });
  fs.writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');

  const verifyPack = readJson(packPath);
  if (verifyPack.sites.filter((s) => s?.id === site.id).length !== 1) fail(`${patchName}: reread verification failed for ${site.id}`);
  const verifiedSite = verifyPack.sites.find((s) => s?.id === site.id);
  validateSite(verifiedSite, `${patchName} reread`);

  const c = counts(verifyPack);
  let entry = index.packs.find((p) => p?.id === `colorado-${countySlug}`);
  if (!entry) {
    entry = { id: `colorado-${countySlug}` };
    index.packs.push(entry);
  }
  entry.county = countyLabel;
  entry.state = 'Colorado';
  entry.version = String(verifyPack.version);
  entry.url = `https://raw.githubusercontent.com/ignorethese4words-cloud/remnant-content/main/packs/canonical/colorado-${countySlug}.json`;
  entry.exploreSiteCount = c.exploreSiteCount;
  entry.idOnlySiteCount = c.idOnlySiteCount;
  entry.siteCount = c.siteCount;
  index.generatedAt = now;
  index.contentVersion = now;

  fs.unlinkSync(patchPath);
  merged += 1;
  touched.push(`${site.id} -> packs/canonical/colorado-${countySlug}.json`);
}

fs.writeFileSync(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
const verifyIndex = readJson(INDEX_PATH);
for (const item of touched) {
  const slug = item.match(/colorado-([a-z0-9-]+)\.json$/)?.[1];
  if (!slug) continue;
  const pack = readJson(path.join(PACK_DIR, `colorado-${slug}.json`));
  const c = counts(pack);
  const entry = verifyIndex.packs.find((p) => p?.id === `colorado-${slug}`);
  if (!entry || entry.siteCount !== c.siteCount || entry.exploreSiteCount !== c.exploreSiteCount || entry.idOnlySiteCount !== c.idOnlySiteCount) {
    fail(`manifest verification failed for colorado-${slug}`);
  }
}

console.log(`PUBLIC SITE PATCH MERGE — ${merged} merged; ${touched.join('; ')}`);
