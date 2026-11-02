import Counter from "../models/Counter.js";

export const ORDER_NUMBER_PREFIX = "apl";

// Counter seeds here, so the first order number is ORDER_NUMBER_SEED + 1
// (apl1675). Chosen so numbers look established rather than starting at #1.
export const ORDER_NUMBER_SEED = 1674;

// Minimum digit width, so every id is "apl" + 4 digits = 7 characters
// (apl1675). Numbers past 9999 simply grow wider — they're never truncated.
export const ORDER_NUMBER_MIN_DIGITS = 4;

/** Format a raw counter value as the display id, e.g. 1675 -> "apl1675". */
export function formatOrderNumber(seq) {
  return `${ORDER_NUMBER_PREFIX}${String(seq).padStart(ORDER_NUMBER_MIN_DIGITS, "0")}`;
}

/**
 * Atomically reserve the next human-friendly order number, e.g. "apl1675".
 * Sequential and never random — the same value is shown across the
 * storefront/dashboard and sent to couriers as the merchant invoice id.
 *
 * Note: we can't lean on `setDefaultsOnInsert` to seed the counter, because
 * Mongoose skips the schema default for any field named in an update operator
 * ($inc here) — that would start the sequence at 1 (apl1). So we seed the doc
 * with $setOnInsert first, then increment.
 */
export async function nextOrderNumber() {
  await Counter.updateOne(
    { _id: "orderNumber" },
    { $setOnInsert: { seq: ORDER_NUMBER_SEED } },
    { upsert: true },
  );
  const doc = await Counter.findByIdAndUpdate(
    "orderNumber",
    { $inc: { seq: 1 } },
    { new: true },
  );
  return formatOrderNumber(doc.seq);
}
