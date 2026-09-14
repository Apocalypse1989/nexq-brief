-- First-touch Google Ads / UTM attribution on CRM leads.
-- Written by capture-lead (step-1 silent capture) and submit-brief (final submit).
-- Nullable, additive — existing rows stay NULL. Used for Phase 2 offline conversion upload.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS gclid text,
  ADD COLUMN IF NOT EXISTS gbraid text,
  ADD COLUMN IF NOT EXISTS wbraid text,
  ADD COLUMN IF NOT EXISTS utm_source text,
  ADD COLUMN IF NOT EXISTS utm_medium text,
  ADD COLUMN IF NOT EXISTS utm_campaign text,
  ADD COLUMN IF NOT EXISTS utm_content text,
  ADD COLUMN IF NOT EXISTS utm_term text,
  ADD COLUMN IF NOT EXISTS gclid_captured_at timestamptz;

COMMENT ON COLUMN public.leads.gclid IS
  'Google Ads click ID (first-touch). Required for offline conversion upload.';
COMMENT ON COLUMN public.leads.gbraid IS
  'Google Ads iOS app-to-web click ID (first-touch).';
COMMENT ON COLUMN public.leads.wbraid IS
  'Google Ads web-to-app click ID (first-touch).';
COMMENT ON COLUMN public.leads.utm_source IS
  'First-touch utm_source from the brief form landing URL.';
COMMENT ON COLUMN public.leads.utm_medium IS
  'First-touch utm_medium from the brief form landing URL.';
COMMENT ON COLUMN public.leads.utm_campaign IS
  'First-touch utm_campaign from the brief form landing URL.';
COMMENT ON COLUMN public.leads.utm_content IS
  'First-touch utm_content from the brief form landing URL.';
COMMENT ON COLUMN public.leads.utm_term IS
  'First-touch utm_term from the brief form landing URL.';
COMMENT ON COLUMN public.leads.gclid_captured_at IS
  'When gclid was first captured on the brief form (not the conversion time).';

CREATE INDEX IF NOT EXISTS leads_gclid_idx
  ON public.leads (gclid)
  WHERE gclid IS NOT NULL;
