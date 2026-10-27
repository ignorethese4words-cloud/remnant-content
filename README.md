# Remnant V4 Content

This repository publishes **V4-only** county packs and legally cleared media for the Remnant app.

## Live files

- `v4/pack-index.json`: the only official app manifest.
- `v4/packs/*.json`: deterministic Supabase V4 site exports.
- `v4/media-requests/*.json`: V4 media ingest requests.
- `.github/workflows/v4-deterministic-export.yml`: approved V4 exporter.
- `.github/workflows/v4-media-ingest.yml`: approved V4 media ingester.

**Source of truth:** Supabase project `Remnant v4`. Never use legacy `packs/`, `verified-sites/`, `pack-index.json`, or the old Supabase registry as publication inputs.

The pre-cleanup GitHub snapshot is retained on the `legacy-final-backup-2026-10-26` branch. `audit/legacy-retired-site-ids.json` documents site IDs retired from the old publication process; those IDs are not site records and are not included in V4 packs.
