const ALLOWED_ORIGINS = [
  'https://nexq.co.uk',
  'https://www.nexq.co.uk',
  'https://app.nexq.co.uk',
  // crm.nexq.co.uk (Cloudflare Pages, separate project from Studio) was
  // missing here entirely — every request from the deployed CRM to any
  // verify_jwt=true function, including documenso-send/gocardless-send
  // themselves, would have had its real Origin silently swapped for
  // app.nexq.co.uk below and rejected by the browser's CORS check. Added
  // while wiring the first CRM-UI callers of those two functions.
  'https://crm.nexq.co.uk',
  'https://app.gayn.co.uk',
  'https://gayn.co.uk',
  'https://hq.nexq.co.uk',
  'https://form.nexq.co.uk',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:8080',
];

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[2];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  };
}
