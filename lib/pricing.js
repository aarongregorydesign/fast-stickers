// Server-side mirror of the pricing logic in public/index.html.
// The server never trusts a price sent by the client — it only trusts shape/
// dimensions/qty and recomputes the amount actually charged. Keep this in
// sync with the constants/formulas in the <script> block of public/index.html.

const SHEET_WIDTH_MM = 720;   // width of the vinyl roll
const SIDE_MARGIN_MM = 5;     // kept clear either side of the roll for cutting
const MAX_DIM_MM = SHEET_WIDTH_MM - SIDE_MARGIN_MM * 2; // 710mm
const GUTTER_MM = 5;          // gap left between stickers when nesting on the sheet
const COST_PER_METRE = 10;    // £10 per linear metre of full-width roll
const MARGIN_MULTIPLIER = 2.6; // 160% margin on top of raw vinyl cost
const SINGLE_SETUP_MM = 200;  // extra length billed for a lone, one-off sticker
const FREE_DELIVERY_AT = 30;  // £
const FLAT_POSTAGE = 10;      // £
const MIN_ORDER_PRICE = 4.5;  // £ floor so a tiny/one-off run never prices at pennies

const USABLE_WIDTH = SHEET_WIDTH_MM - SIDE_MARGIN_MM * 2;

const VALID_SHAPES = ['square', 'rectangle', 'circle', 'oval', 'custom'];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function billedLengthMM(widthMM, heightMM, qty) {
  if (qty === 1) {
    // A lone sticker still needs a full-width run of the machine, so we bill
    // the smaller dimension plus a fixed setup allowance.
    const smallest = Math.min(widthMM, heightMM);
    return smallest + SINGLE_SETUP_MM;
  }
  // Nest stickers across the usable width, row by row, then bill the total
  // roll length those rows consume.
  const perRow = Math.max(1, Math.floor((USABLE_WIDTH + GUTTER_MM) / (widthMM + GUTTER_MM)));
  const rows = Math.ceil(qty / perRow);
  return rows * (heightMM + GUTTER_MM);
}

// Recomputes the authoritative price from shape/dimensions/qty. Returns the
// clamped/validated inputs alongside the price so the caller can persist and
// display exactly what was actually charged.
function priceOrder({ shape, widthMM, heightMM, qty }) {
  let w = clamp(Number(widthMM) || 0, 1, MAX_DIM_MM);
  let h = clamp(Number(heightMM) || 0, 1, MAX_DIM_MM);
  const q = clamp(Math.round(Number(qty) || 1), 1, 100000);

  if (shape === 'square' || shape === 'circle') {
    h = w; // single-dimension shapes
  }

  const lengthMM = billedLengthMM(w, h, q);
  const rawCost = (lengthMM / 1000) * COST_PER_METRE;
  // Round the subtotal first, then derive shipping/total from that rounded
  // value — summing already-rounded figures guarantees what's displayed
  // (subtotal + shipping) always matches the total actually charged.
  const subtotal = round2(Math.max(rawCost * MARGIN_MULTIPLIER, MIN_ORDER_PRICE));
  const shipping = subtotal >= FREE_DELIVERY_AT ? 0 : FLAT_POSTAGE;
  const total = round2(subtotal + shipping);

  return {
    width: w,
    height: h,
    qty: q,
    subtotal,
    shipping,
    total,
  };
}

module.exports = { priceOrder, MAX_DIM_MM, VALID_SHAPES };
