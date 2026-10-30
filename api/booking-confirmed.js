// Vercel function. Supabase calls it whenever a booking row is added or updated.
//  - New online booking              -> email to the owner
//  - Status changes to Confirmed     -> confirmation email to the customer
//  - Status changes to Completed     -> thank-you email to the customer
const crypto = require('crypto');

const esc = (x) =>
  String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function sameSecret(got, want) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from('Bearer ' + String(want || ''));
  return want && a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function send(payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.FROM_EMAIL, ...payload }),
  });
  if (!r.ok) {
    console.error('Resend error', r.status, await r.text());
    return false;
  }
  return true;
}

function wrap(inner) {
  return '<div style="font-family:Arial,sans-serif;max-width:520px;line-height:1.5">' + inner + '</div>';
}
function row(k, v) {
  return '<tr><td style="padding:4px 16px 4px 0"><b>' + k + '</b></td><td>' + esc(v) + '</td></tr>';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  if (!sameSecret(req.headers.authorization, process.env.WEBHOOK_SECRET)) return res.status(401).end();

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { type, record, old_record } = body || {};
  if (!record) return res.status(200).json({ skipped: 'no record' });

  const shop = process.env.SHOP_NAME || 'the workshop';
  const site = (process.env.SITE_URL || '').replace(/\/$/, '');
  const when = record.date + (record.time ? ' at ' + record.time : '');
  const replyTo = process.env.REPLY_TO ? { reply_to: process.env.REPLY_TO } : {};

  // 1. New booking made by a customer on the website: tell the owner.
  if (type === 'INSERT') {
    if (record.src === 'owner') return res.status(200).json({ skipped: 'added by the owner' });
    const owners = String(process.env.OWNER_EMAIL || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!owners.length) return res.status(200).json({ skipped: 'OWNER_EMAIL is not set' });
    const html = wrap(
      '<h2 style="margin:0 0 12px">New booking request</h2>' +
      '<table style="border-collapse:collapse">' +
      row('Customer', record.name) + row('Phone', record.phone) + row('Email', record.email) +
      row('Vehicle', record.car) + row('Service', record.svc) + row('When', when) + row('Notes', record.notes || '-') +
      '</table>' +
      (site ? '<p><a href="' + esc(site) + '/#admin">Open the dashboard to confirm it</a></p>' : '') +
      '<p style="color:#666;font-size:13px">Reply to this email to write to the customer.</p>'
    );
    const text =
      'New booking request\n\nCustomer: ' + record.name + '\nPhone: ' + record.phone + '\nEmail: ' + record.email +
      '\nVehicle: ' + record.car + '\nService: ' + record.svc + '\nWhen: ' + when + '\nNotes: ' + (record.notes || '-') +
      (site ? '\n\nDashboard: ' + site + '/#admin' : '');
    const ok = await send({
      to: owners,
      subject: 'New booking: ' + record.svc + ' on ' + record.date + ' (' + record.name + ')',
      html, text,
      ...(record.email ? { reply_to: record.email } : {}),
    });
    return ok ? res.status(200).json({ sent: 'owner notice' }) : res.status(502).json({ error: 'email provider refused the request' });
  }

  if (type !== 'UPDATE') return res.status(200).json({ skipped: 'not an insert or update' });
  if (!record.email) return res.status(200).json({ skipped: 'no customer email' });
  const was = old_record && old_record.status;

  // 2. Booking just confirmed: tell the customer.
  if (record.status === 'Confirmed' && was !== 'Confirmed') {
    const html = wrap(
      '<h2 style="margin:0 0 12px">Your booking is confirmed</h2><p>Hello ' + esc(record.name) + ',</p>' +
      '<p>We have confirmed your booking at ' + esc(shop) + '.</p><table style="border-collapse:collapse">' +
      row('Service', record.svc) + row('When', when) + row('Vehicle', record.car) + '</table>' +
      '<p>If you need to change or cancel, just reply to this email.</p><p>See you soon,<br>' + esc(shop) + '</p>'
    );
    const text = 'Hello ' + record.name + ',\n\nYour booking at ' + shop + ' is confirmed.\n\nService: ' + record.svc +
      '\nWhen: ' + when + '\nVehicle: ' + record.car + '\n\nIf you need to change or cancel, just reply to this email.\n\n' + shop;
    const ok = await send({ to: [record.email], subject: 'Your booking is confirmed: ' + record.svc + ' on ' + record.date, html, text, ...replyTo });
    return ok ? res.status(200).json({ sent: 'confirmation' }) : res.status(502).json({ error: 'email provider refused the request' });
  }

  // 3. Service just completed: thank the customer.
  if (record.status === 'Completed' && was !== 'Completed') {
    const html = wrap(
      '<h2 style="margin:0 0 12px">Thank you</h2><p>Hello ' + esc(record.name) + ',</p>' +
      '<p>Thank you for choosing ' + esc(shop) + '. Your <b>' + esc(record.svc) + '</b> on your ' + esc(record.car) + ' is complete.</p>' +
      '<p>We hope everything is running just as it should. If anything does not feel right, reply to this email and we will look at it straight away.</p>' +
      (site ? '<p>You can see your booking history and book your next service at <a href="' + esc(site) + '/#account">' + esc(site.replace(/^https?:\/\//, '')) + '</a>.</p>' : '') +
      '<p>Kind regards,<br>' + esc(shop) + '</p>'
    );
    const text = 'Hello ' + record.name + ',\n\nThank you for choosing ' + shop + '. Your ' + record.svc + ' on your ' + record.car +
      ' is complete.\n\nWe hope everything is running just as it should. If anything does not feel right, reply to this email and we will look at it straight away.' +
      (site ? '\n\nBook your next service: ' + site + '/#account' : '') + '\n\nKind regards,\n' + shop;
    const ok = await send({ to: [record.email], subject: 'Thank you from ' + shop, html, text, ...replyTo });
    return ok ? res.status(200).json({ sent: 'thank you' }) : res.status(502).json({ error: 'email provider refused the request' });
  }

  return res.status(200).json({ skipped: 'no email needed for this change' });
};
