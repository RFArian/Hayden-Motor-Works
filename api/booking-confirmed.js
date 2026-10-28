// Vercel function. Supabase calls it when a booking row is updated.
// It emails the customer the first time a booking becomes "Confirmed".
const crypto = require('crypto');

const esc = (x) =>
  String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function sameSecret(got, want) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from('Bearer ' + String(want || ''));
  return want && a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  if (!sameSecret(req.headers.authorization, process.env.WEBHOOK_SECRET)) return res.status(401).end();

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { type, record, old_record } = body || {};

  // Only act when a booking has just changed to Confirmed.
  if (type !== 'UPDATE' || !record || record.status !== 'Confirmed') return res.status(200).json({ skipped: 'not a new confirmation' });
  if (old_record && old_record.status === 'Confirmed') return res.status(200).json({ skipped: 'already confirmed' });
  if (!record.email) return res.status(200).json({ skipped: 'no customer email' });

  const shop = process.env.SHOP_NAME || 'the workshop';
  const when = record.date + (record.time ? ' at ' + record.time : '');
  const html =
    '<div style="font-family:Arial,sans-serif;max-width:520px;line-height:1.5">' +
    '<h2 style="margin:0 0 12px">Your booking is confirmed</h2>' +
    '<p>Hello ' + esc(record.name) + ',</p>' +
    '<p>We have confirmed your booking at ' + esc(shop) + '.</p>' +
    '<table style="border-collapse:collapse">' +
    '<tr><td style="padding:4px 16px 4px 0"><b>Service</b></td><td>' + esc(record.svc) + '</td></tr>' +
    '<tr><td style="padding:4px 16px 4px 0"><b>When</b></td><td>' + esc(when) + '</td></tr>' +
    '<tr><td style="padding:4px 16px 4px 0"><b>Vehicle</b></td><td>' + esc(record.car) + '</td></tr></table>' +
    '<p>If you need to change or cancel, just reply to this email.</p><p>See you soon,<br>' + esc(shop) + '</p></div>';
  const text =
    'Hello ' + record.name + ',\n\nYour booking at ' + shop + ' is confirmed.\n\nService: ' + record.svc +
    '\nWhen: ' + when + '\nVehicle: ' + record.car + '\n\nIf you need to change or cancel, just reply to this email.\n\n' + shop;

  const payload = {
    from: process.env.FROM_EMAIL,
    to: [record.email],
    subject: 'Your booking is confirmed: ' + record.svc + ' on ' + record.date,
    html,
    text,
  };
  if (process.env.REPLY_TO) payload.reply_to = process.env.REPLY_TO;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    console.error('Resend error', r.status, await r.text());
    return res.status(502).json({ error: 'email provider refused the request' });
  }
  return res.status(200).json({ sent: true });
};
