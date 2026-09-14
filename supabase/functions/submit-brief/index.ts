import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

import { compactAttribution, firstTouchAttribution, pickAttribution } from '../_shared/attribution.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

// Trims/caps only — does NOT HTML-escape. Values here are stored as plain
// text (leads/contacts/companies/notes columns, rendered as plain React
// text in the CRM) as well as interpolated into the HTML notification
// email via he() below. Escaping here corrupted plain-text storage (e.g.
// "SEO & Marketing" saved as "SEO &amp; Marketing") and double-escaped the
// email output, since he() escapes again at the point of HTML interpolation.
function sanitize(v: unknown, max = 2000): string | null {
  if (!v || typeof v !== 'string') return null;
  return v.trim().slice(0, max) || null;
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function briefToNote(d: Record<string, unknown>): string {
  const lines: string[] = ['=== CLIENT WEBSITE BRIEF ===', ''];

  const add = (label: string, key: string) => {
    const v = sanitize(d[key], 5000);
    if (v) lines.push(`${label}:\n${v}`, '');
  };

  const addCheck = (label: string, key: string) => {
    const val = d[key];
    if (Array.isArray(val) && val.length) lines.push(`${label}:\n${val.join(', ')}`, '');
  };

  add('Company name', 'companyName');
  add('What the business does', 'businessDesc');
  add('Years trading', 'yearsTrading');
  add('Team size', 'teamSize');
  add('Location / coverage', 'location');
  add('Jurisdiction', 'jurisdiction');
  add('Companies House number', 'companyNumber');
  add('Ideal customers', 'idealCustomers');
  add('Target work', 'targetWork');
  add('Typical contract value', 'contractValue');
  add('Competitors', 'competitors');
  add('Differentiators', 'differentiators');
  add('Main services', 'services');
  add('Priority services', 'priorityServices');
  add('Accreditations', 'accreditations');
  add('Awards / memberships', 'awards');
  add('Other sectors', 'otherSectors');

  const checks = d['checkboxes'] as Record<string, string[]> | undefined;
  if (checks) {
    if (checks['sector']?.length) lines.push(`Sectors:\n${checks['sector'].join(', ')}`, '');
    if (checks['features']?.length) lines.push(`Website features needed:\n${checks['features'].join(', ')}`, '');
    if (checks['logo']?.length) lines.push(`Logo status: ${checks['logo'][0]}`, '');
    if (checks['photos']?.length) lines.push(`Photos status: ${checks['photos'][0]}`, '');
    if (checks['content']?.length) lines.push(`Content status: ${checks['content'][0]}`, '');
    if (checks['domain']?.length) lines.push(`Domain status: ${checks['domain'][0]}`, '');
  }

  add('Current website', 'currentSite');
  add('Main CTA', 'cta');
  add('Design references (like)', 'designRefs');
  add('Design avoid', 'designAvoid');
  add('Preferred colours', 'colours');
  add('Style / feel', 'style');
  add('Reviews / testimonials', 'reviews');
  add('Case studies', 'caseStudies');
  add('Domain name', 'domainName');
  add('Registrar', 'registrar');
  add('Preferred new domain', 'preferredDomain');
  add('Notification email', 'notificationEmail');
  add('Best way to contact', 'bestContact');
  add('Company phone', 'companyPhone');
  add('Company email', 'companyEmail');
  add('Registered address', 'companyAddress');
  add('Trading address', 'tradingAddress');
  add('What makes them stand out', 'standout');
  add('What they want to improve', 'improve');
  add('Other notes', 'otherNotes');

  add('Google click ID (gclid)', 'gclid');
  add('Google gbraid', 'gbraid');
  add('Google wbraid', 'wbraid');
  add('utm_source', 'utm_source');
  add('utm_medium', 'utm_medium');
  add('utm_campaign', 'utm_campaign');
  add('utm_content', 'utm_content');
  add('utm_term', 'utm_term');
  add('gclid captured at', 'gclid_captured_at');

  lines.push(`Submitted at: ${sanitize(d['submittedAt']) ?? new Date().toISOString()}`);
  return lines.join('\n');
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const data: Record<string, unknown> = await req.json();

    const contactName = sanitize(data['contactName']);
    const contactEmail = sanitize(data['contactEmail']);
    const contactPhone = sanitize(data['contactPhone']);
    const contactRole  = sanitize(data['contactRole']);
    const companyName  = sanitize(data['companyName']);

    if (!contactName || !contactEmail) {
      return new Response(JSON.stringify({ error: 'Contact name and email are required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl      = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const resendApiKey     = Deno.env.get('RESEND_API_KEY');
    const supabase         = createClient(supabaseUrl, supabaseKey);

    // Resolve admin user to own the records
    const { data: adminRole } = await supabase
      .from('user_roles')
      .select('user_id')
      .eq('role', 'admin')
      .limit(1)
      .single();

    const userId = adminRole?.user_id;
    if (!userId) {
      console.error('No admin user found');
      return new Response(JSON.stringify({ error: 'System configuration error' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { first, last } = splitName(contactName);
    const incomingAttribution = pickAttribution(data);

    // 1. Create or enrich lead.
    // The website form fires an early "ghost" capture via capture-lead
    // (source_detail: 'NexQ Brief Form — step 1') if the visitor stalls
    // after step 1, then this function runs on the true full submission.
    // Without a lookup here, every full submission created a second,
    // duplicate lead row instead of completing the ghost one — find any
    // existing, not-yet-converted lead for this email and enrich it in
    // place so one submission maps to one lead.
    const { data: existingLead } = await (supabase as any)
      .from('leads')
      .select('id, gclid, gbraid, wbraid, utm_source, utm_medium, utm_campaign, utm_content, utm_term, gclid_captured_at')
      .ilike('email', contactEmail)
      .is('converted_to_contact_id', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let lead: { id: string } | null = null;
    let leadError: { message: string; code?: string } | null = null;

    if (existingLead) {
      const { data: updatedLead, error } = await (supabase as any)
        .from('leads')
        .update({
          first_name:   first,
          last_name:    last,
          phone:        contactPhone,
          company_name: companyName,
          job_title:    contactRole,
          source:       'brief_form',
          source_detail:'NexQ Website Brief',
          lead_score:   25,
          notes:        `Brief submitted. See note for full details.`,
          ...firstTouchAttribution(incomingAttribution, existingLead),
        })
        .eq('id', existingLead.id)
        .select('id')
        .single();
      lead = updatedLead;
      leadError = error;
    } else {
      const { data: newLead, error } = await (supabase as any)
        .from('leads')
        .insert({
          user_id:      userId,
          first_name:   first,
          last_name:    last,
          email:        contactEmail,
          phone:        contactPhone,
          company_name: companyName,
          job_title:    contactRole,
          source:       'brief_form',
          source_detail:'NexQ Website Brief',
          status:       'new',
          lead_score:   25,
          notes:        `Brief submitted. See note for full details.`,
          ...compactAttribution(incomingAttribution),
        })
        .select('id')
        .single();
      lead = newLead;
      leadError = error;
    }

    if (leadError) {
      console.error('submit-brief: lead upsert failed:', leadError.message, leadError.code);
    }

    // 2. Create or find company
    let companyId: string | null = null;
    if (companyName) {
      const { data: existingCo } = await supabase
        .from('companies')
        .select('id')
        .ilike('name', companyName)
        .limit(1)
        .single();

      if (existingCo) {
        companyId = existingCo.id;
      } else {
        const { data: newCo, error: companyError } = await supabase
          .from('companies')
          .insert({
            user_id: userId,
            name:    companyName,
            website: sanitize(data['currentSite']),
            phone:   sanitize(data['companyPhone']),
            email:   sanitize(data['companyEmail']),
            address: sanitize(data['companyAddress']),
            source:  'brief_form',
          })
          .select('id')
          .single();

        if (companyError) {
          console.error('submit-brief: company insert failed:', companyError.message, companyError.code, { companyName });
        }
        companyId = newCo?.id ?? null;
      }
    }

    // 3. Create or find contact
    let contactId: string | null = null;
    const { data: existingContact } = await supabase
      .from('contacts')
      .select('id')
      .ilike('email', contactEmail)
      .limit(1)
      .single();

    if (existingContact) {
      contactId = existingContact.id;
    } else {
      const { data: newContact, error: contactError } = await supabase
        .from('contacts')
        .insert({
          user_id:    userId,
          first_name: first,
          last_name:  last,
          email:      contactEmail,
          phone:      contactPhone,
          job_title:  contactRole,
          company_id: companyId,
          source:     'brief_form',
        })
        .select('id')
        .single();

      if (contactError) {
        console.error('submit-brief: contact insert failed:', contactError.message, contactError.code);
      }
      contactId = newContact?.id ?? null;
    }

    // 4. Save full brief as a note
    const noteBody = briefToNote(data);
    let noteSaved = false;
    if (contactId) {
      const { error: noteError } = await supabase.from('notes').insert({
        user_id:    userId,
        contact_id: contactId,
        company_id: companyId,
        lead_id:    lead?.id ?? null,
        title:      `Website brief — ${companyName || contactName}`,
        content:    noteBody,
        type:       'brief',
      });

      if (noteError) {
        console.error('submit-brief: note insert failed:', noteError.message, noteError.code, { contactId, companyId });
      } else {
        noteSaved = true;
      }
    } else {
      console.error('submit-brief: skipped note insert — no contactId resolved');
    }

    // 5. Create deal — links the completed brief into the sales pipeline
    let dealId: string | null = null;
    if (contactId) {
      try {
        // Match the convention used elsewhere (voice-sync/index.ts): pipeline_id
        // is optional on deals, resolved from the admin's default pipeline when
        // one exists, otherwise left null.
        const { data: defaultPipeline } = await supabase
          .from('pipelines')
          .select('id')
          .eq('user_id', userId)
          .eq('is_default', true)
          .limit(1)
          .maybeSingle();

        const dealTitle = `${companyName ?? contactName} — website brief`;

        // Avoid duplicate deals if the same brief is ever submitted twice
        const { data: existingDeal } = await supabase
          .from('deals')
          .select('id')
          .eq('contact_id', contactId)
          .ilike('title', dealTitle)
          .limit(1)
          .maybeSingle();

        if (existingDeal) {
          dealId = existingDeal.id;
        } else {
          const { data: newDeal, error: dealError } = await (supabase as any)
            .from('deals')
            .insert({
              user_id:     userId,
              contact_id:  contactId,
              company_id:  companyId,
              pipeline_id: defaultPipeline?.id ?? null,
              title:       dealTitle,
              stage:       'lead',
              value:       0,
              // NOTE: deals has no `source` column (unlike leads/companies/
              // contacts, which do) — including it here caused every deal
              // insert to fail silently, confirmed via a live test.
            })
            .select('id')
            .single();

          if (dealError) {
            console.error('submit-brief: deal insert failed:', dealError.message, dealError.code, { contactId });
          } else {
            dealId = newDeal?.id ?? null;
          }
        }
      } catch (dealErr) {
        console.error('submit-brief: deal creation error:', dealErr);
      }
    } else {
      console.error('submit-brief: skipped deal creation — no contactId resolved');
    }

    // 6. Confirmation email to the client — mirrors the on-screen "Brief
    // received" copy (index.html screen-4) so the email never promises
    // anything the UI didn't already say. Sent BEFORE the internal email
    // below so its real send result (Resend can return a 4xx/5xx without
    // fetch() ever rejecting) can be reported there — there's no other
    // log visibility into this from where this was fixed.
    let clientEmailStatus = 'not attempted (no RESEND_API_KEY set)';
    if (resendApiKey) {
      if (!contactEmail) {
        clientEmailStatus = 'skipped — no contactEmail on this submission';
      } else {
        const heClient = (s: string | null | undefined) => s == null ? '' : String(s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

        const clientHtml = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;">
  <div style="background:#09090E;padding:24px 32px;border-radius:12px 12px 0 0;display:flex;align-items:center;">
    <span style="font-size:20px;font-weight:900;color:#fff;letter-spacing:-0.04em;">NEX</span><span style="font-size:20px;font-weight:900;color:#C9A764;letter-spacing:-0.04em;">Q</span>
  </div>
  <div style="background:#f8fafc;padding:28px 32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;">
    <p style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#C9A764;margin:0 0 8px;">Brief received</p>
    <h2 style="font-size:1.375rem;font-weight:700;color:#111827;margin:0 0 16px;">Thank you, ${heClient(first)} — we're on it.</h2>
    <p style="font-size:0.9375rem;line-height:1.6;color:#374151;margin:0 0 24px;">We'll review your brief within 4 hours. Here's what happens next:</p>
    <table style="width:100%;border-collapse:collapse;font-size:0.9375rem;">
      <tr>
        <td style="padding:10px 12px 10px 0;color:#C9A764;font-weight:700;vertical-align:top;width:22px;">1</td>
        <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;">
          <div style="font-weight:600;color:#111827;">We review your brief</div>
          <div style="color:#6b7280;font-size:0.875rem;margin-top:2px;">Within 4 hours — we check for any gaps and come back with questions if needed</div>
        </td>
      </tr>
      <tr>
        <td style="padding:10px 12px 10px 0;color:#C9A764;font-weight:700;vertical-align:top;">2</td>
        <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;">
          <div style="font-weight:600;color:#111827;">We confirm your start date</div>
          <div style="color:#6b7280;font-size:0.875rem;margin-top:2px;">Once your deposit is confirmed the 48-hour build clock starts. We'll tell you exactly when your preview arrives.</div>
        </td>
      </tr>
      <tr>
        <td style="padding:10px 12px 10px 0;color:#C9A764;font-weight:700;vertical-align:top;">3</td>
        <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;">
          <div style="font-weight:600;color:#111827;">Build begins</div>
          <div style="color:#6b7280;font-size:0.875rem;margin-top:2px;">48 hours later, you receive a preview link to review your site before anything goes live</div>
        </td>
      </tr>
      <tr>
        <td style="padding:10px 12px 10px 0;color:#C9A764;font-weight:700;vertical-align:top;">4</td>
        <td style="padding:10px 0;">
          <div style="font-weight:600;color:#111827;">Review, approve and go live</div>
          <div style="color:#6b7280;font-size:0.875rem;margin-top:2px;">Request any changes, approve in writing, and we connect it to your domain</div>
        </td>
      </tr>
    </table>
    <p style="color:#6b7280;font-size:0.875rem;margin:24px 0 0;padding-top:16px;border-top:1px solid #e2e8f0;">
      Any questions? Email <a href="mailto:info@nexq.co.uk" style="color:#C9A764;font-weight:600;">info@nexq.co.uk</a> or call <a href="tel:+443300243335" style="color:#C9A764;font-weight:600;">+44 330 024 3335</a>.
    </p>
  </div>
</div>`;

        try {
          const clientRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from:     'NexQ Brief <notifications@nexq.co.uk>',
              to:       [contactEmail],
              reply_to: 'info@nexq.co.uk',
              subject:  'Brief received — we\'re on it',
              html:     clientHtml,
            }),
          });
          if (clientRes.ok) {
            clientEmailStatus = 'sent OK';
          } else {
            const errText = await clientRes.text().catch(() => '(no body)');
            clientEmailStatus = `FAILED — HTTP ${clientRes.status}: ${errText.slice(0, 500)}`;
          }
        } catch (e) {
          clientEmailStatus = `FAILED — network error: ${String(e).slice(0, 500)}`;
        }
      }
    }

    // 7. Email notification to Aidan
    if (resendApiKey) {
      const services    = sanitize(data['services'], 300) ?? '—';
      const improve     = sanitize(data['improve'],  300) ?? '—';
      const currentSite = sanitize(data['currentSite']) ?? '—';

      const he = (s: string | null | undefined) => s == null ? '' : String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

      const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;">
  <div style="background:#09090E;padding:24px 32px;border-radius:12px 12px 0 0;display:flex;align-items:center;">
    <span style="font-size:20px;font-weight:900;color:#fff;letter-spacing:-0.04em;">NEX</span><span style="font-size:20px;font-weight:900;color:#C9A764;letter-spacing:-0.04em;">Q</span>
    <span style="margin-left:12px;font-size:12px;color:rgba(255,255,255,0.45);letter-spacing:0.12em;text-transform:uppercase;">New brief received</span>
  </div>
  <div style="background:#f8fafc;padding:28px 32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;">
    <p style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#C9A764;margin:0 0 8px;">Website brief</p>
    <h2 style="font-size:1.25rem;font-weight:700;color:#111827;margin:0 0 24px;">
      ${he(contactName)}${companyName ? ` — ${he(companyName)}` : ''}
    </h2>
    <table style="width:100%;border-collapse:collapse;font-size:0.9375rem;">
      <tr><td style="padding:8px 0;color:#6b7280;border-bottom:1px solid #f3f4f6;width:130px;">Name</td><td style="padding:8px 0;font-weight:600;color:#111827;border-bottom:1px solid #f3f4f6;">${he(contactName)}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280;border-bottom:1px solid #f3f4f6;">Email</td><td style="padding:8px 0;border-bottom:1px solid #f3f4f6;"><a href="mailto:${he(contactEmail)}" style="color:#C9A764;font-weight:600;">${he(contactEmail)}</a></td></tr>
      ${contactPhone ? `<tr><td style="padding:8px 0;color:#6b7280;border-bottom:1px solid #f3f4f6;">Phone</td><td style="padding:8px 0;border-bottom:1px solid #f3f4f6;">${he(contactPhone)}</td></tr>` : ''}
      ${companyName ? `<tr><td style="padding:8px 0;color:#6b7280;border-bottom:1px solid #f3f4f6;">Company</td><td style="padding:8px 0;border-bottom:1px solid #f3f4f6;">${he(companyName)}</td></tr>` : ''}
      <tr><td style="padding:8px 0;color:#6b7280;border-bottom:1px solid #f3f4f6;">Current site</td><td style="padding:8px 0;border-bottom:1px solid #f3f4f6;">${he(currentSite)}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280;vertical-align:top;border-bottom:1px solid #f3f4f6;">Services</td><td style="padding:8px 0;border-bottom:1px solid #f3f4f6;">${he(services)}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280;vertical-align:top;">Wants to improve</td><td style="padding:8px 0;">${he(improve)}</td></tr>
    </table>
    <div style="margin-top:24px;">
      <p style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#C9A764;margin:0 0 10px;">Full website brief</p>
      <pre style="white-space:pre-wrap;word-break:break-word;background:#111827;color:#e5e7eb;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.55;padding:16px;border-radius:8px;margin:0;">${he(noteBody)}</pre>
    </div>
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;display:flex;gap:12px;">
      <a href="mailto:${he(contactEmail)}" style="display:inline-flex;align-items:center;gap:8px;background:#C9A764;color:#09090E;text-decoration:none;font-weight:700;font-size:0.875rem;padding:11px 22px;border-radius:999px;">Reply to ${he(first)}</a>
    </div>
    ${noteSaved
      ? '<p style="color:#94a3b8;font-size:11px;margin:16px 0 0;">Full brief also saved as a note in NexQ CRM &middot; source: brief_form</p>'
      : '<p style="color:#dc2626;font-weight:700;font-size:12px;margin:16px 0 8px;">⚠ Note save FAILED — the full brief is included above, but was NOT saved to the CRM. Check function logs.</p>'
    }
    <p style="${clientEmailStatus === 'sent OK' ? 'color:#94a3b8;' : 'color:#dc2626;font-weight:700;'}font-size:11px;margin:8px 0 0;">Client confirmation email: ${he(clientEmailStatus)}</p>
  </div>
</div>`;

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:     'NexQ Brief <notifications@nexq.co.uk>',
          to:       ['leads@nexq.co.uk'],
          reply_to: contactEmail,
          subject:  `New brief: ${contactName}${companyName ? ` — ${companyName}` : ''}`,
          html,
        }),
      }).catch((e) => console.error('Email send failed:', e));
    }

    return new Response(
      JSON.stringify({
        success:    true,
        lead_id:    lead?.id ?? null,
        contact_id: contactId,
        company_id: companyId,
        deal_id:    dealId,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('submit-brief error:', err);
    return new Response(JSON.stringify({ error: 'An unexpected error occurred' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
