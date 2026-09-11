import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PACK_DIR = path.join(ROOT, 'packs', 'canonical');
const MANIFEST_PATH = path.join(ROOT, 'pack-index.json');
const OUT_DIR = path.join(ROOT, 'audit');
const OUT_PATH = path.join(OUT_DIR, 'public-pack-audit.json');
const QUEUE_TSV_PATH = path.join(OUT_DIR, 'public-pack-queue.tsv');

const internalTextRe = /\b(first deep pass|queued for app update|package verification|work queue|worker\s*[12]?|research queue|staging|debug|G(?:10|[1-9])\s+(?:PASS|INCOMPLETE|BLOCKED|package|gate))\b/i;
const stableIdRe = /^CO-[A-Z0-9-]+$/;

function text(v) { return typeof v === 'string' ? v.trim() : ''; }
function finite(n) { return Number.isFinite(Number(n)); }
function issue(site, county, severity, code, message, file) {
  return { severity, code, siteId: text(site?.id) || null, siteName: text(site?.name) || null, county, file, message };
}
function allStrings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) allStrings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) allStrings(x, out);
  return out;
}
function repoMediaPathFromUri(uri) {
  const prefix = 'https://raw.githubusercontent.com/ignorethese4words-cloud/remnant-content/main/';
  return typeof uri === 'string' && uri.startsWith(prefix) ? uri.slice(prefix.length) : null;
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const descriptors = new Map((manifest.packs || []).map(p => [p.id, p]));
const files = fs.readdirSync(PACK_DIR).filter(f => f.endsWith('.json')).sort();
const findings = [];
const globalIds = new Map();
const packSummaries = [];

for (const file of files) {
  const filePath = path.join(PACK_DIR, file);
  let pack;
  try { pack = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (e) {
    findings.push({ severity: 'CRITICAL', code: 'INVALID_JSON', siteId: null, siteName: null, county: null, file: `packs/canonical/${file}`, message: String(e.message || e) });
    continue;
  }
  const county = text(pack.county);
  const packId = text(pack.id);
  const sites = Array.isArray(pack.sites) ? pack.sites : [];
  let explore = 0, idOnly = 0;

  if (!packId || !county) findings.push({ severity: 'CRITICAL', code: 'PACK_IDENTITY', siteId: null, siteName: null, county, file: `packs/canonical/${file}`, message: 'County pack is missing stable id/county metadata.' });

  for (const site of sites) {
    const id = text(site.id);
    const name = text(site.name);
    const siteCounty = text(site.county);
    const appReady = site.appReady === true;
    const betaVisible = site.betaVisible === true;
    const isExplore = appReady && betaVisible;
    const hasCoords = finite(site?.coordinates?.latitude) && finite(site?.coordinates?.longitude);
    if (isExplore) explore++; else if (hasCoords) idOnly++;

    if (!id || !stableIdRe.test(id)) findings.push(issue(site, county, 'HIGH', 'LEGACY_OR_INVALID_SITE_ID', `Published Site ID '${id || '(blank)'}' does not use the permanent CO-... convention.`, `packs/canonical/${file}`));
    if (!name) findings.push(issue(site, county, 'HIGH', 'MISSING_NAME', 'Published record has no location name.', `packs/canonical/${file}`));
    if (!siteCounty || siteCounty.replace(/\s+County$/i,'').toLowerCase() !== county.replace(/\s+County$/i,'').toLowerCase()) findings.push(issue(site, county, 'HIGH', 'COUNTY_MISMATCH', `Site county '${siteCounty}' does not match pack county '${county}'.`, `packs/canonical/${file}`));
    if (!hasCoords) findings.push(issue(site, county, 'HIGH', 'MISSING_OR_BAD_COORDINATES', 'Published site lacks finite identification coordinates.', `packs/canonical/${file}`));
    else {
      const lat = Number(site.coordinates.latitude), lon = Number(site.coordinates.longitude);
      if (lat < 36 || lat > 42 || lon < -110 || lon > -101) findings.push(issue(site, county, 'HIGH', 'COORDINATES_OUTSIDE_COLORADO', `Coordinates ${lat}, ${lon} fall outside the broad Colorado bounds.`, `packs/canonical/${file}`));
    }

    if (appReady !== betaVisible) findings.push(issue(site, county, 'CRITICAL', 'TIER_FLAG_SPLIT', `appReady=${site.appReady} and betaVisible=${site.betaVisible}; current app semantics require both true for Explore and both false for ID-only.`, `packs/canonical/${file}`));
    if (text(site.tier).toUpperCase() === 'ID ONLY' && isExplore) findings.push(issue(site, county, 'CRITICAL', 'ID_ONLY_EXPOSED_AS_EXPLORE', 'tier says ID ONLY but appReady=true and betaVisible=true exposes it as Explore.', `packs/canonical/${file}`));
    if (text(site.tier).toUpperCase() === 'EXPLORE' && !isExplore) findings.push(issue(site, county, 'CRITICAL', 'EXPLORE_NOT_VISIBLE', 'tier says EXPLORE but Explore flags are not both true.', `packs/canonical/${file}`));

    if (!text(site.contentUpdatedAt)) findings.push(issue(site, county, 'MEDIUM', 'MISSING_CONTENT_UPDATED_AT', 'Published site has no site-level contentUpdatedAt freshness marker.', `packs/canonical/${file}`));

    const overview = Array.isArray(site.overview) ? site.overview.filter(x => text(x)) : [];
    const timeline = Array.isArray(site.timeline) ? site.timeline : [];
    const more = Array.isArray(site.moreHistory) ? site.moreHistory.filter(x => text(x)) : [];
    if (!overview.length) findings.push(issue(site, county, 'HIGH', 'MISSING_OVERVIEW', 'Published site has no visitor-facing overview.', `packs/canonical/${file}`));
    if (isExplore && overview.length + timeline.length + more.length < 3) findings.push(issue(site, county, 'HIGH', 'THIN_EXPLORE_CONTENT', 'Explore record is too thin for the current Full Explore standard.', `packs/canonical/${file}`));

    if (allStrings(site).some(s => internalTextRe.test(s))) findings.push(issue(site, county, 'HIGH', 'INTERNAL_PIPELINE_LANGUAGE', 'Published record contains internal workflow/gate/package language.', `packs/canonical/${file}`));

    const images = Array.isArray(site.displayImages) ? site.displayImages : [];
    if (images.length) {
      if (text(site.mediaSearchStatus) !== 'FOUND_USABLE_MEDIA') findings.push(issue(site, county, 'HIGH', 'MEDIA_STATUS_INCOMPLETE', 'Record has displayImages but mediaSearchStatus is not FOUND_USABLE_MEDIA.', `packs/canonical/${file}`));
      for (const img of images) {
        const uri = text(img?.source?.uri || img?.remoteUri);
        if (!uri) findings.push(issue(site, county, 'HIGH', 'MEDIA_URI_MISSING', `Image '${text(img?.id) || '(unnamed)'}' has no direct media URI.`, `packs/canonical/${file}`));
        if (!text(img?.sourcePage)) findings.push(issue(site, county, 'HIGH', 'MEDIA_SOURCE_PAGE_MISSING', `Image '${text(img?.id) || '(unnamed)'}' has no sourcePage.`, `packs/canonical/${file}`));
        if (!text(img?.sourceNote)) findings.push(issue(site, county, 'HIGH', 'MEDIA_CREDIT_MISSING', `Image '${text(img?.id) || '(unnamed)'}' has no sourceNote/credit.`, `packs/canonical/${file}`));
        if (!text(img?.rights)) findings.push(issue(site, county, 'HIGH', 'MEDIA_RIGHTS_MISSING', `Image '${text(img?.id) || '(unnamed)'}' has no explicit rights/use statement.`, `packs/canonical/${file}`));
        if (text(img?.mediaStatus) !== 'PACKAGED') findings.push(issue(site, county, 'HIGH', 'MEDIA_PACKAGED_STATUS_MISSING', `Image '${text(img?.id) || '(unnamed)'}' is not explicitly mediaStatus=PACKAGED.`, `packs/canonical/${file}`));
        const local = repoMediaPathFromUri(uri);
        if (local && !fs.existsSync(path.join(ROOT, local))) findings.push(issue(site, county, 'CRITICAL', 'CONTROLLED_MEDIA_FILE_MISSING', `Remnant-controlled media URI points to missing repository file '${local}'.`, `packs/canonical/${file}`));
      }
    } else {
      if (text(site.mediaNotice) !== 'Historic image not available' || text(site.mediaSearchStatus) !== 'SEARCH_EXHAUSTED') findings.push(issue(site, county, 'HIGH', 'PLACEHOLDER_CONTRACT_INCOMPLETE', 'No displayImages are packaged, but the required Historic image not available + SEARCH_EXHAUSTED state is incomplete.', `packs/canonical/${file}`));
    }

    if (id) {
      if (globalIds.has(id)) findings.push(issue(site, county, 'CRITICAL', 'DUPLICATE_SITE_ID_ACROSS_PACKS', `Site ID is also published in ${globalIds.get(id)}.`, `packs/canonical/${file}`));
      else globalIds.set(id, `packs/canonical/${file}`);
    }
  }

  const desc = descriptors.get(packId);
  if (!desc) findings.push({ severity: 'HIGH', code: 'MANIFEST_ENTRY_MISSING', siteId: null, siteName: null, county, file: `packs/canonical/${file}`, message: `No pack-index descriptor found for ${packId}.` });
  else {
    if (Number(desc.siteCount) !== explore + idOnly || Number(desc.exploreSiteCount) !== explore || Number(desc.idOnlySiteCount) !== idOnly) findings.push({ severity: 'CRITICAL', code: 'MANIFEST_COUNT_MISMATCH', siteId: null, siteName: null, county, file: `packs/canonical/${file}`, message: `Actual usable counts ${explore + idOnly}/${explore}/${idOnly} do not match manifest ${desc.siteCount}/${desc.exploreSiteCount}/${desc.idOnlySiteCount}.` });
    const expected = `https://raw.githubusercontent.com/ignorethese4words-cloud/remnant-content/main/packs/canonical/${file}`;
    if (text(desc.url) !== expected) findings.push({ severity: 'HIGH', code: 'MANIFEST_URL_MISMATCH', siteId: null, siteName: null, county, file: `packs/canonical/${file}`, message: `Manifest URL does not point to this canonical pack.` });
  }
  packSummaries.push({ file, packId, county, sites: sites.length, explore, idOnly });
}

for (const [id, d] of descriptors) {
  const expectedFile = `${id}.json`;
  if (!files.includes(expectedFile)) findings.push({ severity: 'HIGH', code: 'MANIFEST_POINTS_TO_MISSING_CANONICAL_PACK', siteId: null, siteName: null, county: text(d.county), file: 'pack-index.json', message: `Manifest descriptor ${id} has no packs/canonical/${expectedFile}.` });
}

const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
findings.sort((a,b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || String(a.county).localeCompare(String(b.county)) || String(a.siteId).localeCompare(String(b.siteId)) || a.code.localeCompare(b.code));
const affectedSiteIds = [...new Set(findings.map(f => f.siteId).filter(Boolean))];
const report = {
  generatedAt: new Date().toISOString(),
  standard: 'Remnant public delivery production standard — permanent Site ID, tier semantics, coordinates, visitor content, media/rights or SEARCH_EXHAUSTED, manifest consistency, no internal language',
  packsChecked: packSummaries.length,
  publishedSitesChecked: packSummaries.reduce((n,p) => n + p.sites, 0),
  affectedPublishedSites: affectedSiteIds.length,
  findingCounts: findings.reduce((m,f) => (m[f.severity]=(m[f.severity]||0)+1,m), {}),
  packSummaries,
  affectedSiteIds,
  findings
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + '\n');

const bySite = new Map();
for (const f of findings) {
  if (!f.siteId) continue;
  const row = bySite.get(f.siteId) || { siteId: f.siteId, siteName: f.siteName || '', county: f.county || '', codes: new Set(), severities: new Set() };
  if (!row.siteName && f.siteName) row.siteName = f.siteName;
  if (!row.county && f.county) row.county = f.county;
  row.codes.add(f.code);
  row.severities.add(f.severity);
  bySite.set(f.siteId, row);
}
const tsvLines = ['Site ID\tLocation Name\tCounty\tIssue Codes\tPriority'];
for (const row of [...bySite.values()].sort((a,b) => a.county.localeCompare(b.county) || a.siteName.localeCompare(b.siteName) || a.siteId.localeCompare(b.siteId))) {
  const priority = row.severities.has('CRITICAL') ? 'HIGH' : row.severities.has('HIGH') ? 'HIGH' : 'MEDIUM';
  tsvLines.push([row.siteId, row.siteName.replace(/[\t\r\n]+/g,' '), row.county.replace(/ County$/i,''), [...row.codes].sort().join(','), priority].join('\t'));
}
fs.writeFileSync(QUEUE_TSV_PATH, tsvLines.join('\n') + '\n');

console.log(`PUBLIC PACK AUDIT — ${report.packsChecked} packs / ${report.publishedSitesChecked} sites / ${report.affectedPublishedSites} affected sites / ${findings.length} findings`);
for (const [sev,count] of Object.entries(report.findingCounts)) console.log(`${sev}: ${count}`);
console.log(`QUEUE EXPORT — ${bySite.size} unique published Site IDs`);
