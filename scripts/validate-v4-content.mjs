import fs from 'node:fs';
import path from 'node:path';

const forbidden = ['packs','verified-sites','media','dashboard','pack-index.json'];
for (const p of forbidden) if (fs.existsSync(p)) throw new Error('Legacy publication path still present: '+p);
const docs = fs.existsSync('docs') ? fs.readdirSync('docs') : [];
if (docs.some(filename => filename !== 'index.md')) throw new Error('Unexpected legacy documentation in docs/');

const manifest = JSON.parse(fs.readFileSync('v4/pack-index.json','utf8'));
if (!Array.isArray(manifest.packs) || !manifest.packs.length) throw new Error('Missing V4 manifest');
const prefix='https://raw.githubusercontent.com/ignorethese4words-cloud/remnant-content/main/v4/packs/';
const listed = new Set();
const siteIds = new Set();
let total = 0;
for(const descriptor of manifest.packs){
  if (!descriptor.url?.startsWith(prefix) || !descriptor.url.endsWith('.json')) throw new Error('Unsafe V4 URL: '+descriptor.id);
  const filename = decodeURIComponent(descriptor.url.slice(prefix.length));
  if (!/^[a-z0-9-]+\.json$/.test(filename)) throw new Error('Unsafe file name: '+filename);
  if(listed.has(filename)) throw new Error('Duplicate county pack: '+filename);
  listed.add(filename);
  const pack = JSON.parse(fs.readFileSync(path.join('v4/packs',filename),'utf8'));
  if(pack.id!==descriptor.id || pack.county!==descriptor.county || pack.state!==descriptor.state) throw new Error('County metadata mismatch: '+filename);
  if(!Array.isArray(pack.sites)) throw new Error('No V4 sites for '+filename);
  let explore=0, idOnly=0;
  for(const site of pack.sites){
    if(typeof site.id!=='string' || !site.id.trim()) throw new Error('Blank V4 ID in '+filename);
    if(siteIds.has(site.id)) throw new Error('Duplicate V4 site ID: '+site.id);
    siteIds.add(site.id);
    if(/County\s+County/i.test(site.county||'')) throw new Error('Malformed county label: '+site.id);
    if(site.appReady===true && site.betaVisible===true) explore++;
    else if(Number.isFinite(site?.coordinates?.latitude)&&Number.isFinite(site?.coordinates?.longitude)) idOnly++;
  }
  if(pack.sites.length!==Number(descriptor.siteCount) || explore!==Number(descriptor.exploreSiteCount) || idOnly!==Number(descriptor.idOnlySiteCount)) throw new Error('Manifest counts mismatch: '+filename);
  total+=pack.sites.length;
}
const actual=fs.readdirSync('v4/packs').filter(x=>x.endsWith('.json'));
for(const filename of actual) if(!listed.has(filename)) throw new Error('Orphan V4 pack not in approved manifest: '+filename);
const retired=JSON.parse(fs.readFileSync('audit/legacy-retired-site-ids.json','utf8'));
if(!Array.isArray(retired.retiredSiteIds) || retired.retiredSiteIds.length!==retired.retiredCount) throw new Error('Invalid retirement inventory');
for(const id of retired.retiredSiteIds) if(siteIds.has(id)) throw new Error('Current V4 site mistakenly tombstoned: '+id);
console.log('V4 publication OK: '+manifest.packs.length+' counties, '+total+' sites, '+retired.retiredCount+' retired legacy IDs');
