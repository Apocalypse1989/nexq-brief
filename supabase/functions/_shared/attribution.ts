/** First-touch Google Ads / UTM fields accepted from the brief form. */
export const ATTRIBUTION_KEYS = [
  'gclid',
  'gbraid',
  'wbraid',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

export type AttributionKey = typeof ATTRIBUTION_KEYS[number];

export type Attribution = {
  [K in AttributionKey]: string | null;
} & {
  gclid_captured_at: string | null;
};

function sanitizeAttr(value: unknown, max = 255): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim().slice(0, max);
  if (!s || /[\u0000-\u001F\u007F]/.test(s)) return null;
  return s;
}

export function pickAttribution(data: Record<string, unknown>): Attribution {
  const attr = {} as Attribution;
  for (const key of ATTRIBUTION_KEYS) {
    attr[key] = sanitizeAttr(data[key]);
  }

  let captured: string | null = null;
  if (typeof data.gclid_captured_at === 'string') {
    const d = new Date(data.gclid_captured_at);
    if (!Number.isNaN(d.getTime())) captured = d.toISOString();
  }
  if (attr.gclid && !captured) captured = new Date().toISOString();
  attr.gclid_captured_at = attr.gclid ? captured : null;
  return withClickIdUtmFallback(attr);
}

/**
 * Auto-tagged Google clicks often arrive with gclid/gbraid/wbraid and no UTMs.
 * A click id with a blank source/medium is google/cpc. Never overwrite a
 * source that was actually on the URL.
 */
export function withClickIdUtmFallback(attr: Attribution): Attribution {
  const hasClick = Boolean(attr.gclid || attr.gbraid || attr.wbraid);
  if (!hasClick) return attr;
  if (!attr.utm_source) attr.utm_source = 'google';
  if (!attr.utm_medium && attr.utm_source === 'google') attr.utm_medium = 'cpc';
  return attr;
}

/** Omit empty keys so inserts/updates stay valid if a column is missing. */
export function compactAttribution(attr: Attribution): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attr)) {
    if (value) out[key] = value;
  }
  return out;
}

/**
 * First-touch merge: keep existing DB values; fill only blanks from this request.
 */
export function firstTouchAttribution(
  incoming: Attribution,
  existing: Partial<Attribution> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ATTRIBUTION_KEYS) {
    if (!existing?.[key] && incoming[key]) out[key] = incoming[key]!;
  }
  const gclid = out.gclid || existing?.gclid || null;
  if (gclid && !existing?.gclid_captured_at) {
    out.gclid_captured_at = incoming.gclid_captured_at || new Date().toISOString();
  }
  return out;
}
