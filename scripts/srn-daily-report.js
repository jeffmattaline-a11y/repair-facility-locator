// srn-daily-report.js
// Queries Supabase for facilities added in the last 24 hours and sends a formatted email report.

import fetch from 'node-fetch';
import nodemailer from 'nodemailer';

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  REPORT_RECIPIENT,
} = process.env;

// ---------------------------------------------------------------------------
// 1. Query Supabase for new facilities in the last 24 hours
// ---------------------------------------------------------------------------
async function fetchNewFacilities() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/facilities?added_on=gte.${since}&select=id,name,address,city,state,zip,phone,status,added_on&order=added_on.desc`;

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Supabase query failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// 2. Build the HTML email body
// ---------------------------------------------------------------------------
function buildEmailHtml(facilities) {
  const reportDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Chicago',
  });

  const total = facilities.length;

  // Group by status
  const grouped = {};
  for (const f of facilities) {
    const s = f.status || 'Unknown';
    if (!grouped[s]) grouped[s] = [];
    grouped[s].push(f);
  }

  const statusColors = {
    'Preferred':    '#1a7a3e',
    'Under Review': '#b45309',
    'Inactive':     '#6b7280',
    'Suspended':    '#c0392b',
    'PRF':          '#1a7a3e',
    'NRV':          '#7c3aed',
    'Unknown':      '#374151',
  };

  // Status summary rows
  let statusSummaryRows = '';
  for (const [status, items] of Object.entries(grouped)) {
    const color = statusColors[status] || '#374151';
    statusSummaryRows += `
      <tr>
        <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;">
          <span style="display:inline-block;background:${color};color:#fff;border-radius:4px;padding:2px 10px;font-size:12px;font-weight:600;">${status}</span>
        </td>
        <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;font-size:20px;font-weight:700;color:#233348;text-align:right;">${items.length}</td>
      </tr>`;
  }

  // Facility detail rows
  let facilityRows = '';
  if (total === 0) {
    facilityRows = `<tr><td colspan="5" style="padding:24px;text-align:center;color:#6b7280;">No new facilities were added in the last 24 hours.</td></tr>`;
  } else {
    for (const f of facilities) {
      const color = statusColors[f.status] || '#374151';
      const addedTime = f.added_on ? f.added_on : 'N/A';
      const location = [f.city, f.state, f.zip].filter(Boolean).join(', ');
      facilityRows += `
        <tr>
          <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#233348;">${f.name || '—'}</td>
          <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;color:#374151;">${location || f.address || '—'}</td>
          <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;color:#374151;">${f.phone || '—'}</td>
          <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;">
            <span style="background:${color};color:#fff;border-radius:4px;padding:2px 10px;font-size:12px;font-weight:600;">${f.status || '—'}</span>
          </td>
          <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;">${addedTime}</td>
        </tr>`;
    }
  }

  const noNewText = total === 0 ? ' — No New Additions' : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0;">
  <tr><td align="center">
    <table width="680" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

      <!-- Header -->
      <tr>
        <td style="background:#233348;padding:28px 32px;">
          <table width="100%"><tr>
            <td>
              <div style="font-size:11px;color:#52AFCD;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px;">Shield Repair Network</div>
              <div style="font-size:22px;font-weight:700;color:#ffffff;">Daily Network Report</div>
              <div style="font-size:13px;color:#93c5d9;margin-top:4px;">${reportDate}</div>
            </td>
            <td align="right">
              <div style="font-size:48px;font-weight:800;color:#1DB0D1;line-height:1;">${total}</div>
              <div style="font-size:12px;color:#93c5d9;text-align:right;">New Facilit${total === 1 ? 'y' : 'ies'}</div>
            </td>
          </tr></table>
        </td>
      </tr>

      ${total > 0 ? `
      <!-- Status Summary -->
      <tr>
        <td style="padding:24px 32px 8px;">
          <div style="font-size:13px;font-weight:700;color:#233348;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">By Status</div>
          <table width="100%" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
            <thead>
              <tr style="background:#f9fafb;">
                <th style="padding:8px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Status</th>
                <th style="padding:8px 16px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Count</th>
              </tr>
            </thead>
            <tbody>${statusSummaryRows}</tbody>
          </table>
        </td>
      </tr>` : ''}

      <!-- Facility Detail -->
      <tr>
        <td style="padding:24px 32px 32px;">
          <div style="font-size:13px;font-weight:700;color:#233348;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">Facility Detail${noNewText}</div>
          <table width="100%" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;font-size:14px;">
            <thead>
              <tr style="background:#f9fafb;">
                <th style="padding:8px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Facility</th>
                <th style="padding:8px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Location</th>
                <th style="padding:8px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Phone</th>
                <th style="padding:8px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Status</th>
                <th style="padding:8px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Added</th>
              </tr>
            </thead>
            <tbody>${facilityRows}</tbody>
          </table>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;text-align:center;">
          <a href="https://jeffmattaline-a11y.github.io/repair-facility-locator/srn_admin.html"
             style="color:#225981;font-size:13px;text-decoration:none;font-weight:600;">Open SRN Admin Tool →</a>
          <div style="font-size:11px;color:#9ca3af;margin-top:6px;">
            Shield Repair Network · American Auto Shield · Automated daily report — do not reply
          </div>
        </td>
      </tr>

    </table>
  </td></tr>
</table>

</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 3. Send the email via Gmail SMTP (App Password)
// ---------------------------------------------------------------------------
async function sendEmail(subject, html) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
  });

  const info = await transporter.sendMail({
    from: `"SRN Automated Reports" <${GMAIL_USER}>`,
    to: REPORT_RECIPIENT,
    subject,
    html,
  });

  console.log(`Email sent: ${info.messageId}`);
}

// ---------------------------------------------------------------------------
// 4. Main
// ---------------------------------------------------------------------------
(async () => {
  try {
    console.log('Querying Supabase for new facilities...');
    const facilities = await fetchNewFacilities();
    console.log(`Found ${facilities.length} new facility/facilities in the last 24 hours.`);

    const total = facilities.length;
    const dateStr = new Date().toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago',
    });

    const subject = total === 0
      ? `SRN Daily Report — No New Facilities (${dateStr})`
      : `SRN Daily Report — ${total} New Facilit${total === 1 ? 'y' : 'ies'} Added (${dateStr})`;

    const html = buildEmailHtml(facilities);

    console.log('Sending email...');
    await sendEmail(subject, html);
    console.log('Done.');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
