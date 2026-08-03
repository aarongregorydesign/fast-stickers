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

const uploadFields = upload.fields([
  { name: 'artwork', maxCount: 1 },
  { name: 'designProof', maxCount: 1 },
]);

app.post('/api/checkout', uploadFields, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Payments are not configured yet — please check back soon.' });
    }

    const { shape, widthMM, heightMM, qty, unit, imageTransform } = req.body;
    if (!VALID_SHAPES.includes(shape)) {
      return res.status(400).json({ error: 'Invalid shape' });
    }

    // Authoritative price — never trust a total sent by the client.
    const priced = priceOrder({ shape, widthMM, heightMM, qty });

    const artworkFile = req.files && req.files.artwork && req.files.artwork[0];
    const proofFile = req.files && req.files.designProof && req.files.designProof[0];

    const orderId = crypto.randomUUID();
    pendingOrders.set(orderId, {
      shape,
      unit: unit || 'mm',
      widthMM: priced.width,
      heightMM: priced.height,
      qty: priced.qty,
      subtotal: priced.subtotal,
      shipping: priced.shipping,
      total: priced.total,
      imageTransform: parseImageTransform(imageTransform),
      file: artworkFile
        ? { buffer: artworkFile.buffer, originalname: artworkFile.originalname, mimetype: artworkFile.mimetype }
        : null,
      // A snapshot of exactly what the customer approved on-screen — the
      // "design proof" — separate from the original artwork file itself.
      proof: proofFile ? { buffer: proofFile.buffer, mimetype: proofFile.mimetype } : null,
      createdAt: Date.now(),
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            product_data: {
              name: `Custom sticker — ${shape}, ${priced.width}×${priced.height}mm × ${priced.qty}`,
            },
            unit_amount: Math.round(priced.total * 100),
          },
          quantity: 1,
        },
      ],
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

  const transformNote = order && describeImageTransform(order.imageTransform);
  const orderLines = order
    ? [
        `Shape: ${order.shape}`,
        `Size: ${order.widthMM}mm × ${order.heightMM}mm`,
        `Quantity: ${order.qty}`,
        `Stickers: £${order.subtotal.toFixed(2)}`,
        `Postage: £${order.shipping.toFixed(2)}`,
        `Total: £${order.total.toFixed(2)}`,
      ].concat(transformNote ? [`Design positioning (from customer's preview): ${transformNote}`] : [])
    : [`Total paid: £${(session.amount_total / 100).toFixed(2)}`, '(order detail lookup expired)'];

  const html = `
    <h2>New Fast Stickers order</h2>
    <p><strong>Customer:</strong> ${customerEmail || 'unknown'}</p>
    <p><strong>Shipping address:</strong> ${addressLines}</p>
    <p>${orderLines.join('<br>')}</p>
    ${order && order.proof ? '<p>Design proof attached — this is exactly what the customer approved before paying.</p>' : ''}
    <p style="color:#888;font-size:12px;">Stripe session: ${session.id}</p>
  `;

  const attachments = [];
  if (order && order.file) {
    attachments.push({
      filename: order.file.originalname,
      content: order.file.buffer.toString('base64'),
    });
  }
  if (order && order.proof) {
    attachments.push({
      filename: 'design-proof.png',
      content: order.proof.buffer.toString('base64'),
    });
  }

  await resend.emails.send({
    from: RESEND_FROM,
    to: NOTIFY_EMAIL,
    subject: `New order — £${order ? order.total.toFixed(2) : (session.amount_total / 100).toFixed(2)}`,
    html,
    attachments,
  });

  // Also send the customer their own copy of the design proof they approved,
  // as a record of exactly what's being printed.
  if (customerEmail && order && order.proof) {
    try {
      await resend.emails.send({
        from: RESEND_FROM,
        to: customerEmail,
        subject: 'Your Fast Stickers order — design proof',
        html: `
          <h2>Thanks for your order!</h2>
          <p>Here's the design proof you approved before checkout — attached as a reference for exactly what we're printing and cutting.</p>
          <p>Shape: ${order.shape}<br>Size: ${order.widthMM}mm × ${order.heightMM}mm<br>Quantity: ${order.qty}<br>Total: £${order.total.toFixed(2)}</p>
          <p>If anything here doesn't look right, just reply to this email and we'll sort it out before it goes into production.</p>
        `,
        attachments: [{ filename: 'design-proof.png', content: order.proof.buffer.toString('base64') }],
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
