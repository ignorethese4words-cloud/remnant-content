import fs from 'node:fs';
import path from 'node:path';

const roots = JSON.parse(process.env.LEGACY_ROOTS || '[]');
const v4ManifestUrl = 'https://raw.githubusercontent.com/ignorethese4words-cloud/remnant-content/main/v4/pack-index.json';
const rawUrlPrefix = 'https://raw.githubusercontent.com/ignorethese4words-cloud/remnant-content/main/v4/packs/';

const manifestResponse = await fetch(v4ManifestUrl);
if (!manifestResponse.ok) throw new Error('V4 manifest unavailable; retirement inventory aborted');
const manifest = await manifestResponse.json();
if (!Array.isArray(manifest.packs) || manifest.packs.length < 1) throw new Error('Invalid V4 manifest');
const active = new Set();
for (const descriptor of manifest.packs) {
  if (!descriptor.url?.startsWith(rawUrlPrefix)) throw new Error('Unexpected V4 pack URL');
  const response = await fetch(descriptor.url);
  if (!response.ok) throw new Error('V4 pack unavailable: ' + descriptor.id);
  const pack = await response.json();
  if (!Array.isArray(pack.sites)) throw new Error('Invalid V4 sites for ' + descriptor.id);
  for (const item of pack.sites) {
    if (typeof item.id === 'string' && item.id.trim()) active.add(item.id.trim());
  }
}
function allJson(root) {
  if (!fs.existsSync(root)) return [];
  if (fs.statSync(root).isFile()) return root.endsWith('.json') ? [root] : [];
  return fs.readdirSync(root,{withFileTypes:true}).flatMap(entry => allJson(path.join(root, entry.name)));
}
const old = new Set();
const inspected = [];
for(const file of [...new Set(roots.flatMap(allJson))].sort()) {
  const data = JSON.parse(fs.readFileSync(file,'utf8'));
  let count = 0;
  function capture(value) {
    if (!value || typeof value !== 'object') return;
    const id = value.id;
    if (typeof id === 'string' && id.trim() && (value.name || value.site_id || value.county || value.coordinates)) {
      old.add(id.trim());
      count++;
    }
    if (typeof value.site_id === 'string' && value.site_id.trim() && value.name) old.add(value.site_id.trim());
    for (const key of ['sites','exploreSites','identificationSites','site','packs','records','locations']) {
      const next = value[key];
      if (Array.isArray(next)) next.forEach(capture);
      else if (next && typeof next === 'object') capture(next);
    }
  }
  if (Array.isArray(data)) data.forEach(capture);
  else capture(data);
  if (/\/(verified-sites|pending)\//.test(file)) old.add(path.basename(file,'.json'));
  inspected.push({file:file.replaceAll('\\','/'),siteCandidates:count});
}
if(inspected.length < 10 || old.size < 10) throw new Error('Refusing incomplete legacy inventory');
const overlap = [...old].filter(id=>active.has(id)).sort();
const retired = [...old].filter(id=>!active.has(id)).sort();
const output = {
  type:'LEGACY_SITE_TOMBSTONE_INVENTORY',
  policy:'Never import these retired legacy IDs into V4; active V4 site IDs are excluded.',
  generatedAt:new Date().toISOString(),
  filesInspected:inspected.length,
  totalLegacyIds:old.size,
  preservedV4Overlaps:overlap.length,
  retiredCount:retired.length,
  retiredSiteIds:retired
};
fs.mkdirSync('audit',{recursive:true});
fs.writeFileSync('audit/legacy-retired-site-ids.json',JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({files:inspected.length,old:old.size,v4:active.size,overlap:overlap.length,retired:retired.length}));
