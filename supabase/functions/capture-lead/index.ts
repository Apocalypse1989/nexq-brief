import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

import { compactAttribution, pickAttribution } from '../_shared/attribution.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

interface LeadPayload {
  // Structured fields (CRM-direct callers)
  first_name?: string;
  last_name?: string;
  // Single-name field (website form)
  name?: string;
  email?: string;
  phone?: string;
  company_name?: string;
  job_title?: string;
  message?: string;
  // Website-form extras
  website?: string;
  challenge?: string;
  source_detail?: string;
  // First-touch Ads / UTM attribution (brief form + any other caller)
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  gclid_captured_at?: string;
}

// Simple email validation
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Trims/caps only — does NOT HTML-escape. notify-new-lead has its own he()
// that escapes at the point of HTML interpolation; escaping here as well
// corrupted plain-text DB storage (e.g. "SEO & Marketing" saved as
// "SEO &amp; Marketing") and double-escaped the notification email.
function sanitize(input: string | undefined): string | null {
  if (!input) return null;
  return input
    .trim()
    .slice(0, 500);
}

function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString().slice(0, 500);
  } catch { return null; }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const payload: LeadPayload = await req.json();

    // Support single `name` field from website form
    if (payload.name && !payload.first_name) {
      const parts = payload.name.trim().split(/\s+/);
      payload.first_name = parts[0];
      payload.last_name  = parts.length > 1 ? parts.slice(1).join(' ') : '';
    }
    // Map website-form `challenge` to `message`
    if (payload.challenge && !payload.message) payload.message = payload.challenge;

    // Validate required fields
    if (!payload.first_name) {
      return new Response(
        JSON.stringify({ error: 'Name is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate email if provided
    if (payload.email && !isValidEmail(payload.email)) {
      return new Response(
        JSON.stringify({ error: 'Invalid email format' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create Supabase client with service role for inserting
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get the default user (first admin) to assign the lead to
    // In production, you might want to configure this differently
    const { data: adminRole } = await supabase
      .from('user_roles')
      .select('user_id')
      .eq('role', 'admin')
      .limit(1)
      .single();

    if (!adminRole) {
      console.error('No admin user found to assign lead');
      return new Response(
        JSON.stringify({ error: 'System configuration error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Build notes — include website URL if provided
    let notes = sanitize(payload.message);
    const safeWebsite = safeUrl(payload.website);
    if (safeWebsite) {
      const websiteLine = `Current website: ${safeWebsite}`;
      notes = notes ? `${notes}\n\n${websiteLine}` : websiteLine;
    }

    const attribution = compactAttribution(pickAttribution(payload as Record<string, unknown>));

    // Prepare lead data
    const leadData = {
      user_id: adminRole.user_id,
      first_name: sanitize(payload.first_name)!,
      last_name: sanitize(payload.last_name ?? '') ?? '',
      email: sanitize(payload.email),
      phone: sanitize(payload.phone),
      company_name: sanitize(payload.company_name),
      job_title: sanitize(payload.job_title),
      notes,
      source: 'website' as const,
      source_detail: sanitize(payload.source_detail) || 'NexQ.co.uk',
      status: 'new' as const,
      lead_score: 0,
      ...attribution,
    };

    console.log('Creating lead from source:', leadData.source_detail);

    // Insert lead
    const { data: lead, error } = await supabase
      .from('leads')
      .insert(leadData)
      .select('id')
      .single();

    if (error) {
      console.error('Error creating lead:', error);
      return new Response(
        JSON.stringify({ error: 'Failed to create lead' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Lead created successfully:', lead.id);

    // Send email notification (fire-and-forget)
    try {
      const notifyUrl = `${supabaseUrl}/functions/v1/notify-new-lead`;
      fetch(notifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({
          lead_id: lead.id,
          first_name: leadData.first_name,
          last_name: leadData.last_name,
          email: leadData.email,
          phone: leadData.phone,
          website: safeUrl(payload.website) || undefined,
          company_name: leadData.company_name,
          job_title: leadData.job_title,
          source: leadData.source,
          source_detail: leadData.source_detail,
          notes: leadData.notes,
        }),
      }).catch((err) => console.error('Failed to trigger notification:', err));
    } catch (notifyErr) {
      console.error('Notification trigger error:', notifyErr);
    }

    // Return success
    return new Response(
      JSON.stringify({
        success: true,
        message: 'Thank you for your enquiry. We will be in touch soon.',
        lead_id: lead.id
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Unexpected error:', error);
    return new Response(
      JSON.stringify({ error: 'An unexpected error occurred' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
