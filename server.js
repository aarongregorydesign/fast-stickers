require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const Stripe = require('stripe');
const { Resend } = require('resend');
const { priceOrder, VALID_SHAPES } = require('./lib/pricing');

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'aaron@aarongregorydesign.com';
const RESEND_FROM = process.env.RESEND_FROM || 'Fast Stickers <onboarding@resend.dev>';
const PORT = process.env.PORT || 3000;

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — matches the frontend's stated limit
});

// Orders are created (and priced) at checkout time, then completed by Stripe's
// webhook a short while later once payment succeeds. This in-memory map
// bridges those two calls. It's fine for a single small-business instance;
// if this ever needs to survive restarts/scale to multiple instances, swap
// it for a real database.
const pendingOrders = new Map();

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
  for (const [id, order] of pendingOrders) {
    if (order.createdAt < cutoff) pendingOrders.delete(id);
  }
}, 15 * 60 * 1000);

const app = express();

// Stripe webhook needs the raw, unparsed body to verify the signature — this
// route must be registered before express.json() below.
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('Stripe/webhook secret not configured — rejecting webhook call');
    return res.status(500).send('Webhook not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata && session.metadata.orderId;
    const order = orderId ? pendingOrders.get(orderId) : null;

    try {
      await sendOrderNotification(session, order);
    } catch (err) {
      console.error('Failed to send order notification email:', err);
    }

    if (orderId) pendingOrders.delete(orderId);
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const MAX_BASKET_ITEMS = 30;
const FREE_DELIVERY_AT = 30; // £ — keep in sync with lib/pricing.js
const FLAT_POSTAGE = 10; // £

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Field names are dynamic per basket item (artwork_0, designProof_0,
// artwork_1, ...), so we accept any file field and match them back up to
// their basket index ourselves, rather than declaring fixed field names.
const uploadAny = upload.any();

app.post('/api/checkout', uploadAny, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Payments are not configured yet — please check back soon.' });
    }

    let itemsMeta;
    try {
      itemsMeta = JSON.parse(req.body.items || '[]');
    } catch (err) {
      return res.status(400).json({ error: 'Invalid basket data' });
    }
    if (!Array.isArray(itemsMeta) || itemsMeta.length === 0) {
      return res.status(400).json({ error: 'Your basket is empty' });
    }
    if (itemsMeta.length > MAX_BASKET_ITEMS) {
      return res.status(400).json({ error: `Please split orders over ${MAX_BASKET_ITEMS} items into more than one order.` });
    }

    const filesByField = {};
    (req.files || []).forEach((f) => { filesByField[f.fieldname] = f; });

    const items = [];
    for (let i = 0; i < itemsMeta.length; i++) {
      const raw = itemsMeta[i] || {};
      if (!VALID_SHAPES.includes(raw.shape)) {
        return res.status(400).json({ error: `Invalid shape in basket item ${i + 1}` });
      }
      // Authoritative price for each item — never trust a total sent by the client.
      const priced = priceOrder({ shape: raw.shape, widthMM: raw.widthMM, heightMM: raw.heightMM, qty: raw.qty });
      const artworkFile = filesByField[`artwork_${i}`];
      const proofFile = filesByField[`designProof_${i}`];
      items.push({
        shape: raw.shape,
        unit: raw.unit || 'mm',
        widthMM: priced.width,
        heightMM: priced.height,
        qty: priced.qty,
        subtotal: priced.subtotal,
        imageTransform: parseImageTransform(raw.imageTransform),
        file: artworkFile
          ? { buffer: artworkFile.buffer, originalname: artworkFile.originalname, mimetype: artworkFile.mimetype }
          : null,
        // A snapshot of exactly what the customer approved on-screen for
        // this item — separate from the original artwork file itself.
        proof: proofFile ? { buffer: proofFile.buffer, mimetype: proofFile.mimetype } : null,
      });
    }

    // Delivery is worked out once across the whole basket, not per item.
    const subtotal = round2(items.reduce((sum, it) => sum + it.subtotal, 0));
    const shipping = subtotal >= FREE_DELIVERY_AT ? 0 : FLAT_POSTAGE;
    const total = round2(subtotal + shipping);

    const orderId = crypto.randomUUID();
    pendingOrders.set(orderId, { items, subtotal, shipping, total, createdAt: Date.now() });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const lineItems = items.map((it) => ({
      price_data: {
        currency: 'gbp',
        product_data: { name: `Custom sticker — ${it.shape}, ${it.widthMM}×${it.heightMM}mm × ${it.qty}` },
        unit_amount: Math.round(it.subtotal * 100),
      },
      quantity: 1,
    }));
    if (shipping > 0) {
      lineItems.push({
        price_data: {
          currency: 'gbp',
          product_data: { name: 'Postage & packaging' },
          unit_amount: Math.round(shipping * 100),
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      shipping_address_collection: { allowed_countries: ['GB'] },
      metadata: { orderId },
      success_url: `${baseUrl}/?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?canceled=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout creation failed:', err);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// The client sends how the customer positioned their design in the preview
// (zoom/rotate/flip/pan) as a JSON string. Parse it defensively — never trust
// client input — and clamp everything to sane ranges.
function parseImageTransform(raw) {
  if (!raw) return null;
  let t;
  try {
    t = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    scale: Math.max(0.1, Math.min(10, num(t.scale, 1))),
    rotate: ((num(t.rotate, 0) % 360) + 360) % 360,
    flipX: num(t.flipX, 1) < 0 ? -1 : 1,
    flipY: num(t.flipY, 1) < 0 ? -1 : 1,
    panX: Math.max(-2000, Math.min(2000, num(t.panX, 0))),
    panY: Math.max(-2000, Math.min(2000, num(t.panY, 0))),
  };
}

// Human-readable summary for the order email — only mentions adjustments
// that actually differ from the default, so a plain upload stays silent.
function describeImageTransform(t) {
  if (!t) return null;
  const parts = [];
  if (Math.round(t.scale * 100) !== 100) parts.push(`zoom ${Math.round(t.scale * 100)}%`);
  if (Math.round(t.rotate) !== 0) parts.push(`rotated ${Math.round(t.rotate)}°`);
  if (t.flipX < 0) parts.push('flipped horizontally');
  if (t.flipY < 0) parts.push('flipped vertically');
  if (Math.round(t.panX) !== 0 || Math.round(t.panY) !== 0) {
    parts.push(`repositioned (x${t.panX >= 0 ? '+' : ''}${Math.round(t.panX)}, y${t.panY >= 0 ? '+' : ''}${Math.round(t.panY)})`);
  }
  return parts.length ? parts.join(', ') : null;
}

async function sendOrderNotification(session, order) {
  if (!resend) {
    console.error('RESEND_API_KEY not set — skipping order email. Order data:', order);
    return;
  }

  const customerEmail = session.customer_details && session.customer_details.email;
  const shippingDetails = session.shipping_details || session.customer_details;
  const addr = shippingDetails && shippingDetails.address;
  const addressLines = addr
    ? [addr.line1, addr.line2, addr.city, addr.postal_code, addr.country].filter(Boolean).join(', ')
    : 'Not provided';

  const items = order ? order.items : null;

  const itemLines = items
    ? items
        .map((it, i) => {
          const transformNote = describeImageTransform(it.imageTransform);
          return `<p><strong>Item ${i + 1}:</strong> ${it.shape}, ${it.widthMM}mm × ${it.heightMM}mm, qty ${it.qty} — £${it.subtotal.toFixed(2)}` +
            (transformNote ? `<br>Design positioning (from customer's preview): ${transformNote}` : '') +
            (it.proof ? `<br>Design proof attached (item-${i + 1}-design-proof.png)` : '') +
            `</p>`;
        })
        .join('')
    : '';

  const summaryHtml = order
    ? `<p>Stickers subtotal: £${order.subtotal.toFixed(2)}<br>Postage: £${order.shipping.toFixed(2)}<br>Total: £${order.total.toFixed(2)}</p>`
    : `<p>Total paid: £${(session.amount_total / 100).toFixed(2)} (order detail lookup expired)</p>`;

  const html = `
    <h2>New Fast Stickers order${items ? ` — ${items.length} item${items.length === 1 ? '' : 's'}` : ''}</h2>
    <p><strong>Customer:</strong> ${customerEmail || 'unknown'}</p>
    <p><strong>Shipping address:</strong> ${addressLines}</p>
    ${itemLines}
    ${summaryHtml}
    <p style="color:#888;font-size:12px;">Stripe session: ${session.id}</p>
  `;

  const attachments = [];
  if (items) {
    items.forEach((it, i) => {
      if (it.file) {
        attachments.push({ filename: `item-${i + 1}-${it.file.originalname}`, content: it.file.buffer.toString('base64') });
      }
      if (it.proof) {
        attachments.push({ filename: `item-${i + 1}-design-proof.png`, content: it.proof.buffer.toString('base64') });
      }
    });
  }

  await resend.emails.send({
    from: RESEND_FROM,
    to: NOTIFY_EMAIL,
    subject: `New order — £${order ? order.total.toFixed(2) : (session.amount_total / 100).toFixed(2)}`,
    html,
    attachments,
  });

  // Also send the customer their own copy of the design proofs they
  // approved, as a record of exactly what's being printed.
  if (customerEmail && items) {
    try {
      const proofAttachments = items
        .map((it, i) => (it.proof ? { filename: `item-${i + 1}-design-proof.png`, content: it.proof.buffer.toString('base64') } : null))
        .filter(Boolean);
      await resend.emails.send({
        from: RESEND_FROM,
        to: customerEmail,
        subject: `Your Fast Stickers order — design proof${items.length === 1 ? '' : 's'}`,
        html: `
          <h2>Thanks for your order!</h2>
          <p>Here ${items.length === 1 ? 'is the design proof' : 'are the design proofs'} you approved before checkout — attached as a reference for exactly what we're printing and cutting.</p>
          ${itemLines}
          ${summaryHtml}
          <p>If anything here doesn't look right, just reply to this email and we'll sort it out before it goes into production.</p>
        `,
        attachments: proofAttachments,
      });
    } catch (err) {
      console.error('Failed to send customer proof email:', err);
    }
  }
}

app.listen(PORT, () => {
  console.log(`Fast Stickers server listening on :${PORT}`);
  if (!stripe) console.warn('⚠️  STRIPE_SECRET_KEY not set — checkout is disabled until configured.');
  if (!resend) console.warn('⚠️  RESEND_API_KEY not set — order emails are disabled until configured.');
});
