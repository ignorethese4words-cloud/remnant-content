# Remnant V4 Media Workflow v2 — one ChatGPT slot

## Design goal
One hourly ChatGPT media-research worker; no second ChatGPT automation. Deterministic processing stays in existing GitHub Actions + authenticated Supabase Edge Function. Only a durable APPROVED row plus verified image bytes in Supabase Storage counts as app media.

## Architecture
1. ChatGPT claims **exactly one** SITE_MEDIA work item via private.claim_next_work('SITE_MEDIA','V4 MEDIA WORKER',45). Read exact site identity/aliases, existing APPROVED/DRAFT, prior leads and failed notes. Do not search legacy.
2. Search primary sources and exact-site imagery. Prioritize exact historical photos, then modern, workings plans and narrowly relevant maps. Verify creator/source, exact subject, license permitting commercial redistribution **and offline copies**, and figure-specific exceptions. No inferred rights or generic images.
3. Record actionable but unapproved findings in public.media_leads. Allowed lead_state: RIGHTS_PENDING, PDF_REVIEW, SOURCE_BLOCKED, READY, INGEST_SUBMITTED, STORED, REJECTED. These are leads, NEVER app assets. Store precise identity and rights uncertainty, source and required follow-up.
4. For a **fully verified direct image**, write one unique GitHub `v4/media-requests/*.json` with status READY and full provenance. The existing GitHub workflow authenticates via OIDC and uses the existing v4-media-store Edge Function, which downloads/uploads bytes, validates MIME and SHA256 by readback, and writes public.site_media APPROVED. Record GitHub request path in media_leads after the commit is verified. Do not claim STORED until verified. Repeat at most 3 images TOTAL for the site including approvals.
5. PDF-only lead: if the figure **cannot be visually inspected**, cropped tightly, identified and licensed, record PDF_REVIEW and move on. Do not guess `pdfPageIndex`/`pdfCropBox`. Do not retry HTTP 403 on every hourly run. Only use existing PDF figure preparation workflow after full verification.
6. Close exactly the claimed media research job using private.finish_media_search_v2(work_item_id,'V4 MEDIA WORKER',outcome,notes). Supported outcomes:
  - STORED: at least one current Supabase approved asset is verified;
  - INGEST_SUBMITTED: one durable media_leads INGEST_SUBMITTED request, explicitly NOT stored yet;
  - NEEDS_PERMISSION: at least one durable RIGHTS_PENDING lead;
  - PDF_REVIEW: at least one durable PDF_REVIEW lead;
  - NO_USABLE_MEDIA: genuinely exhausted, no actionable leads;
  - TECHNICAL_HOLD: system failure after bounded attempts, queue moves on.
The closeout function accepts an expired lease ONLY while the job remains CLAIMED by the same worker; it refuses stale owner or completed jobs. On closeout it writes an audit record and a durable result JSON. Never disable schedule for an individual site.
7. AFTER verified storage, the `trg_media_lead_stored` trigger marks matching READY/INGEST_SUBMITTED lead STORED when site_media becomes APPROVED with both verifications and the managed Supabase Storage URL. It NEVER creates approval or changes rights flags.
8. Existing `.github/workflows/v4-deterministic-export.yml` runs a native GitHub schedule and builds county packs from APPROVED site_media via `private.build_v4_export_snapshot()`. A disabled ChatGPT export reminder does not disable the native GitHub schedule. **App offline download/caching requires its own field test; Supabase storage alone is not offline proof.**

## Reconciliation and failure policy
- An image request may be SUBMITTED while ingest continues; no false stored claims. GitHub Actions logs and site_media are definitive receipts.
- Never resubmit an identical failing URL or PDF without changed evidence/method. Preserve a rights/PDF lead and move to next site on the following hour.
- The worker verifies GitHub run/storage receipt if available during its run but must not hold the full hourly research queue hostage to a late workflow.
- Ingest failures remain visible as INGEST_SUBMITTED leads without matching site_media receipt, and GitHub Actions run failure. Review/retry these *specific GitHub requests* manually by workflow_dispatch (no new scheduled ChatGPT worker).
- Avoid marking permission-pending or figure-review cases as exhausted.
- Existing manual APPROVED or DRAFT media is not overwritten or removed by this workflow.
- User-facing reports: only real newly verified STORED images get actual clickable Supabase image URLs; submitted and unverified images get no fake previews.

## Production acceptance criteria
1. Claim and close one media site via private.finish_media_search_v2; verify event/job status.
2. Save a rights-pending/PDF lead and close without approval (tested with California Mine #564 on 2026-10-11).
3. End-to-end licensed direct image: GitHub READY request => successful workflow => SHA256-verified permanent storage => APPROVED site_media => matching lead STORED. This v2 integration still needs a new real-image test.
4. Verify native exporter reflects APPPROVED media in exported JSON, then field-test county pack offline image display. Do not claim offline verified before test.
5. Confirm no other jobs, other sites, old Remnant files, or schedules are modified.
