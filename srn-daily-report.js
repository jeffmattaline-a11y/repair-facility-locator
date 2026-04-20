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
  const url = `${SUPABASE_URL}/rest/v1/facilities?added_at=gte.${since}&select=id,name,city,state,zip,phone,status,source_method,added_at,added_by&order=added_at.desc`;

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
// 2. Query Supabase for network-wide status snapshot (aggregated)
// ---------------------------------------------------------------------------
async function fetchStatusSnapshot() {
  // Fetch only status + source_method, paginated to avoid timeout
  const PAGE = 1000;
  let from = 0, all = [], done = false;
  while (!done) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/facilities?select=status,source_method&limit=${PAGE}&offset=${from}`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    if (!res.ok) return [];
    const batch = await res.json();
    all = all.concat(batch);
    if (batch.length < PAGE) done = true;
    else from += PAGE;
  }
  return all;
}

// ---------------------------------------------------------------------------
// 3. Query open (unaddressed) messages count
// ---------------------------------------------------------------------------
async function fetchOpenMessagesCount() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/facility_messages?is_addressed=eq.false&select=id`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'count=exact',
        'Range': '0-0',
      },
    }
  );
  if (!res.ok) return 0;
  const range = res.headers.get('content-range');
  return parseInt(range?.split('/')[1] || '0', 10);
}

// ---------------------------------------------------------------------------
// 4. Source method display helpers
// ---------------------------------------------------------------------------
const SOURCE_LABELS = {
  manual:         { label: 'Manual',          color: '#1a5fb4', bg: '#e8f0fc' },
  bulk_import:    { label: 'Bulk Import',      color: '#c2410c', bg: '#fff7ed' },
  n8n_submission: { label: 'Submission (n8n)', color: '#15803d', bg: '#f0fdf4' },
};

function sourceChip(method) {
  const s = SOURCE_LABELS[method] || { label: method || 'Unknown', color: '#6b7280', bg: '#f3f4f6' };
  return `<span style="display:inline-block;background:${s.bg};color:${s.color};border:1px solid ${s.color}33;border-radius:20px;padding:2px 9px;font-size:11px;font-weight:600;">${s.label}</span>`;
}

// ---------------------------------------------------------------------------
// 5. Build the HTML email body
// ---------------------------------------------------------------------------
function buildEmailHtml(facilities, snapshot, openMessages) {
  const reportDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Chicago',
  });

  const total = facilities.length;

  // ── Source breakdown for NEW facilities ──
  const bySrc = { manual: 0, bulk_import: 0, n8n_submission: 0 };
  for (const f of facilities) {
    const s = f.source_method || 'manual';
    bySrc[s] = (bySrc[s] || 0) + 1;
  }

  const sourceChips = [
    { key: 'manual',         icon: '✏️' },
    { key: 'bulk_import',    icon: '📥' },
    { key: 'n8n_submission', icon: '📋' },
  ].filter(s => bySrc[s.key] > 0).map(s => {
    const meta = SOURCE_LABELS[s.key];
    return `<span style="display:inline-block;background:${meta.bg};color:${meta.color};border:1px solid ${meta.color}44;border-radius:20px;padding:3px 12px;font-size:12px;font-weight:600;margin-right:6px;">${s.icon} ${meta.label}: ${bySrc[s.key]}</span>`;
  }).join('');

  // ── Status breakdown for NEW facilities ──
  const grouped = {};
  for (const f of facilities) {
    const s = f.status || 'Unknown';
    if (!grouped[s]) grouped[s] = [];
    grouped[s].push(f);
  }

  const statusColors = {
    PRF:  '#1a7a3e', OPT: '#1a7a3e', VIP: '#1a7a3e',
    STD:  '#92400e', NEW: '#92400e',
    NRV:  '#6b21a8', PEND: '#1a5fb4',
    BL:   '#7f1d1d', DNC: '#b91c1c', DEL: '#b91c1c',
    MOB:  '#374151', UPB: '#374151',
    Unknown: '#374151',
  };

  let statusSummaryRows = '';
  for (const [status, items] of Object.entries(grouped)) {
    const color = statusColors[status] || '#374151';
    const srcBreakdown = [
      { key: 'manual', icon: '✏️' },
      { key: 'bulk_import', icon: '📥' },
      { key: 'n8n_submission', icon: '📋' },
    ].map(s => {
      const cnt = items.filter(f => (f.source_method || 'manual') === s.key).length;
      if (!cnt) return '';
      const meta = SOURCE_LABELS[s.key];
      return `<span style="font-size:11px;color:${meta.color};background:${meta.bg};border-radius:10px;padding:1px 7px;margin-right:3px;">${s.icon} ${cnt}</span>`;
    }).join('');

    statusSummaryRows += `
      <tr>
        <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;">
          <span style="display:inline-block;background:${color};color:#fff;border-radius:4px;padding:2px 10px;font-size:12px;font-weight:600;">${status}</span>
        </td>
        <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;font-size:20px;font-weight:700;color:#233348;text-align:right;">${items.length}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;text-align:right;">${srcBreakdown}</td>
      </tr>`;
  }

  // ── Network snapshot ──
  let snapshotRows = '';
  if (snapshot.length > 0) {
    const snapByStatus = {};
    const snapBySrc = { manual: 0, bulk_import: 0, n8n_submission: 0 };
    for (const f of snapshot) {
      const s = f.status || 'Unknown';
      snapByStatus[s] = (snapByStatus[s] || 0) + 1;
      const src = f.source_method || 'unknown';
      if (snapBySrc[src] !== undefined) snapBySrc[src]++;
    }
    const snapTotal = snapshot.length;
    for (const [status, cnt] of Object.entries(snapByStatus).sort((a, b) => b[1] - a[1])) {
      const color = statusColors[status] || '#374151';
      const pct = Math.round(cnt / snapTotal * 100);
      snapshotRows += `
        <tr>
          <td style="padding:8px 16px;border-bottom:1px solid #e5e7eb;">
            <span style="display:inline-block;background:${color};color:#fff;border-radius:4px;padding:2px 10px;font-size:12px;font-weight:600;">${status}</span>
          </td>
          <td style="padding:8px 16px;border-bottom:1px solid #e5e7eb;font-weight:700;color:#233348;text-align:right;">${cnt.toLocaleString()}</td>
          <td style="padding:8px 16px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:12px;text-align:right;">${pct}%</td>
        </tr>`;
    }
    const srcSummaryHtml = [
      { key: 'manual', icon: '✏️' },
      { key: 'bulk_import', icon: '📥' },
      { key: 'n8n_submission', icon: '📋' },
    ].map(s => {
      const meta = SOURCE_LABELS[s.key];
      return `<span style="font-size:12px;color:${meta.color};background:${meta.bg};border-radius:20px;padding:2px 10px;margin-right:4px;">${s.icon} ${meta.label}: ${snapBySrc[s.key].toLocaleString()}</span>`;
    }).join('');

    snapshotRows += `
      <tr>
        <td colspan="3" style="padding:12px 16px;background:#f9fafb;border-top:2px solid #e5e7eb;">
          <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-weight:600;">Network Total: ${snapTotal.toLocaleString()} facilities · By Source</div>
          <div>${srcSummaryHtml}</div>
        </td>
      </tr>`;
  }

  // ── Facility detail rows ──
  let facilityRows = '';
  if (total === 0) {
    facilityRows = `<tr><td colspan="6" style="padding:24px;text-align:center;color:#6b7280;">No new facilities were added in the last 24 hours.</td></tr>`;
  } else {
    for (const f of facilities) {
      const color = statusColors[f.status] || '#374151';
      const addedTime = f.added_at
        ? new Date(f.added_at).toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            timeZone: 'America/Chicago',
          })
        : 'N/A';
      facilityRows += `
        <tr>
          <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#233348;">${f.name || '—'}</td>
          <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;color:#374151;">${f.city || '—'}, ${f.state || '—'} ${f.zip || ''}</td>
          <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;color:#374151;">${f.phone || '—'}</td>
          <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;">
            <span style="background:${color};color:#fff;border-radius:4px;padding:2px 10px;font-size:12px;font-weight:600;">${f.status || '—'}</span>
          </td>
          <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;">${sourceChip(f.source_method)}</td>
          <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;">${addedTime} CT</td>
        </tr>`;
    }
  }

  const noNewText = total === 0 ? ' — No New Additions' : '';

  // ── Open messages alert banner ──
  const messagesBanner = openMessages > 0 ? `
      <!-- Messages Alert -->
      <tr>
        <td style="padding:16px 32px;">
          <div style="background:#fdf4ff;border:1px solid #d8b4fe;border-radius:8px;padding:14px 18px;display:flex;align-items:center;gap:12px;">
            <span style="font-size:22px;">💬</span>
            <div>
              <div style="font-size:14px;font-weight:700;color:#6b21a8;">${openMessages} Open Message${openMessages === 1 ? '' : 's'} Awaiting Response</div>
              <div style="font-size:12px;color:#7e22ce;margin-top:2px;">Facilities have unaddressed contact form messages. <a href="https://jeffmattaline-a11y.github.io/repair-facility-locator/srn_admin.html" style="color:#7e22ce;font-weight:600;">Open Admin Tool →</a></div>
            </div>
          </div>
        </td>
      </tr>` : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0;">
  <tr><td align="center">
    <table width="700" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

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

      ${messagesBanner}

      ${total > 0 ? `
      <!-- Source Breakdown Banner -->
      <tr>
        <td style="padding:16px 32px 4px;background:#f8fafc;border-bottom:1px solid #e5e7eb;">
          <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">New Today by Source</div>
          <div>${sourceChips}</div>
        </td>
      </tr>

      <!-- Status Summary -->
      <tr>
        <td style="padding:24px 32px 8px;">
          <div style="font-size:13px;font-weight:700;color:#233348;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">New Additions by Status</div>
          <table width="100%" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
            <thead>
              <tr style="background:#f9fafb;">
                <th style="padding:8px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Status</th>
                <th style="padding:8px 16px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Count</th>
                <th style="padding:8px 16px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Source</th>
              </tr>
            </thead>
            <tbody>${statusSummaryRows}</tbody>
          </table>
        </td>
      </tr>` : ''}

      ${snapshotRows ? `
      <!-- Network Snapshot -->
      <tr>
        <td style="padding:24px 32px 8px;">
          <div style="font-size:13px;font-weight:700;color:#233348;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">Network Snapshot — All Facilities</div>
          <table width="100%" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
            <thead>
              <tr style="background:#f9fafb;">
                <th style="padding:8px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Status</th>
                <th style="padding:8px 16px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Total</th>
                <th style="padding:8px 16px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">% of Network</th>
              </tr>
            </thead>
            <tbody>${snapshotRows}</tbody>
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
                <th style="padding:8px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Source</th>
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
// 6. Send the email via Gmail SMTP (App Password)
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

  console.log(`✅ Email sent: ${info.messageId}`);
}

// ---------------------------------------------------------------------------
// 7. Main
// ---------------------------------------------------------------------------
(async () => {
  try {
    console.log('📡 Querying Supabase for new facilities...');
    const facilities = await fetchNewFacilities();
    console.log(`Found ${facilities.length} new facility/facilities in the last 24 hours.`);

    console.log('📊 Fetching network snapshot...');
    const snapshot = await fetchStatusSnapshot();
    console.log(`Network total: ${snapshot.length} facilities.`);

    console.log('💬 Fetching open messages count...');
    const openMessages = await fetchOpenMessagesCount();
    console.log(`Open messages: ${openMessages}`);

    const total = facilities.length;
    const dateStr = new Date().toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago',
    });

    const bySrc = { manual: 0, bulk_import: 0, n8n_submission: 0 };
    for (const f of facilities) {
      const s = f.source_method || 'manual';
      bySrc[s] = (bySrc[s] || 0) + 1;
    }
    const srcParts = [
      bySrc.manual         > 0 ? `${bySrc.manual} Manual`            : '',
      bySrc.bulk_import    > 0 ? `${bySrc.bulk_import} Bulk`          : '',
      bySrc.n8n_submission > 0 ? `${bySrc.n8n_submission} Submission` : '',
    ].filter(Boolean).join(' · ');

    const msgAlert = openMessages > 0 ? ` · 💬 ${openMessages} Open` : '';

    const subject = total === 0
      ? `SRN Daily Report — No New Facilities (${dateStr})${msgAlert}`
      : `SRN Daily Report — ${total} New Facilit${total === 1 ? 'y' : 'ies'} Added (${dateStr})${srcParts ? ' · ' + srcParts : ''}${msgAlert}`;

    const html = buildEmailHtml(facilities, snapshot, openMessages);

    console.log('📧 Sending email...');
    await sendEmail(subject, html);
    console.log('✅ Done.');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
