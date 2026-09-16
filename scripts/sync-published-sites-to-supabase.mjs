// Dashboard sync for verified public Remnant receipts.
import fs from 'node:fs/promises';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const RECEIPTS_DIR = path.resolve('verified-sites');
const TABLE = 'published_sites';

if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required');
if (!SUPABASE_SECRET_KEY) throw new Error('SUPABASE_SECRET_KEY is required');

const headers = {
  apikey: SUPABASE_SECRET_KEY,
  'Content-Type': 'application/json',
};

function resolveTier(site) {
  if (site?.tier === 'EXPLORE' || site?.tier === 'ID ONLY') return site.tier;
  // Legacy verified receipts predate the explicit tier field. Their published
  // flags are authoritative enough to recover the same public tier.
  if (site?.appReady === true && site?.betaVisible === true) return 'EXPLORE';
  if (site?.appReady === false && site?.betaVisible === false) return 'ID ONLY';
  return null;
}

function toPublishedRow(receipt, receiptPath) {
  const site = receipt.site;
  const manifest = receipt.manifest ?? {};
  const tier = resolveTier(site);
  const county = site?.county ?? manifest.county ?? null;

  if (!site?.id || !site?.name || !county || !tier) {
    throw new Error(`Malformed upsert receipt: ${receiptPath}`);
  }

  return {
    site_id: site.id,
    location_name: site.name,
    county,
    state: manifest.state ?? 'Colorado',
    category: site.category ?? null,
    component_type: site.componentType ?? null,
    tier,
    latitude: site.coordinates?.latitude ?? null,
    longitude: site.coordinates?.longitude ?? null,
    app_ready: tier === 'EXPLORE',
    beta_visible: tier === 'EXPLORE',
    media_search_status: site.mediaSearchStatus ?? null,
    media_count: Array.isArray(site.displayImages) ? site.displayImages.length : 0,
    content_updated_at: site.contentUpdatedAt ?? null,
    published_verified_at: receipt.verifiedAt ?? null,
    county_slug: receipt.countySlug ?? null,
    county_pack: receipt.countyPack ?? null,
    pack_version: receipt.packVersion ?? null,
    pack_generated_at: receipt.packGeneratedAt ?? null,
    manifest_site_count: manifest.siteCount ?? null,
    manifest_explore_count: manifest.exploreSiteCount ?? null,
    manifest_id_only_count: manifest.idOnlySiteCount ?? null,
    source_receipt_path: receiptPath.replaceAll('\\', '/'),
    raw_site: site,
    raw_receipt: receipt,
    synced_at: new Date().toISOString(),
  };
}

async function supabaseFetch(relativeUrl, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${relativeUrl}`, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase ${response.status} ${response.statusText}: ${body}`);
  }
  return response;
}

async function upsertRows(rows) {
  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await supabaseFetch(`/rest/v1/${TABLE}?on_conflict=site_id`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
  }
}

async function deleteRows(siteIds) {
  for (const siteId of siteIds) {
    await supabaseFetch(`/rest/v1/${TABLE}?site_id=${encodeURIComponent(`eq.${siteId}`)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
  }
}

const files = (await fs.readdir(RECEIPTS_DIR))
  .filter((name) => name.endsWith('.json'))
  .sort();

const upserts = [];
const deletes = [];
let ignored = 0;

for (const file of files) {
  const receiptPath = path.join('verified-sites', file);
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));

  if (receipt.operation === 'upsert' && receipt.site) {
    upserts.push(toPublishedRow(receipt, receiptPath));
  } else if (receipt.operation === 'delete' && receipt.siteId) {
    deletes.push(receipt.siteId);
  } else {
    ignored += 1;
  }
}

await upsertRows(upserts);
await deleteRows(deletes);

console.log(`Supabase dashboard sync complete: ${upserts.length} upserted, ${deletes.length} deleted, ${ignored} ignored.`);
