import { formatOrderIdSuffix } from "../orderLookup.js";
import { getCourierIntegration } from "../courierCredentials.js";
import { normalizeBdMobile, isValidBdMobile } from "../courierFraudCheck.js";
import { createPathaoOrder } from "./createPathaoOrder.js";
import {
  createSteadfastOrder,
  steadfastInvoiceFromOrderId,
} from "./createSteadfastOrder.js";
import { createRedxOrder } from "./createRedxOrder.js";

function buildRecipientAddress(order) {
  const b = order.billingDetails || {};
  const parts = [b.address, b.area, b.zone, b.city].filter(Boolean);
  return parts.join(", ") || b.address || "";
}

function defaultCodAmount(order) {
  if (order.paymentMethod === "cash-on-delivery") {
    return Math.round(Number(order.total || 0));
  }
  return 0;
}

const COLOR_KEY_RE = /^colou?rs?$/i;
const SIZE_KEY_RE = /^sizes?$/i;

// Full variant string for an order item — color, size AND every generic
// attribute the customer picked (e.g. "White / Type: Waterproof"), so the
// courier panel and rider get the complete selection, not just color/size.
// Mirrors the frontend `variantLabel` helper so both read identically.
export function itemVariantString(it = {}, sep = " / ") {
  const parts = [it?.color, it?.size].filter(Boolean);
  const attrs = it?.attributes;
  const entries =
    attrs instanceof Map
      ? [...attrs.entries()]
      : attrs && typeof attrs === "object"
        ? Object.entries(attrs)
        : [];
  const clean = entries.filter(([, v]) => v != null && String(v).trim());
  if (clean.length) {
    clean.forEach(([g, v]) => {
      // color/size already added above — don't repeat them if a variant also
      // carried them inside the generic attributes map.
      if (COLOR_KEY_RE.test(g) || SIZE_KEY_RE.test(g)) return;
      parts.push(`${g}: ${v}`);
    });
  } else if (it?.attrGroup && it?.attrValue) {
    parts.push(`${it.attrGroup}: ${it.attrValue}`);
  }
  return parts.join(sep);
}

// Total number of physical units across all line items (couriers want the
// count of pieces in the parcel, not the number of distinct products).
export function totalItemQuantity(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const sum = items.reduce((acc, it) => acc + (Number(it?.quantity) || 0), 0);
  return sum > 0 ? sum : 1;
}

// Human-readable summary of what's in the parcel so the courier panel shows
// the actual products (name × qty @ price) instead of a generic placeholder.
// Kept compact — most courier APIs cap this field around 250 chars.
export function buildItemDescription(order, maxLen = 250) {
  const items = Array.isArray(order.items) ? order.items : [];
  const parts = items
    .map((it) => {
      const name = String(it?.title || "Item").trim();
      const qty = Number(it?.quantity) || 1;
      const price = Number(it?.price) || 0;
      const variant = itemVariantString(it);
      const label = variant ? `${name} (${variant})` : name;
      return `${label} x${qty} @${Math.round(price)}`;
    })
    .filter(Boolean);

  if (parts.length === 0) return "AppleBD order";

  let desc = parts.join(", ");
  if (desc.length > maxLen) {
    // Trim to the last complete item that fits, then note the remainder.
    let shown = 0;
    const kept = [];
    for (const p of parts) {
      const addLen = kept.length ? p.length + 2 : p.length;
      if (shown + addLen > maxLen - 12) break;
      kept.push(p);
      shown += addLen;
    }
    const remaining = parts.length - kept.length;
    desc =
      (kept.length ? kept.join(", ") : parts[0].slice(0, maxLen - 12)) +
      (remaining > 0 ? ` +${remaining} more` : "");
  }
  return desc.slice(0, maxLen);
}

export function validateOrderForBooking(order) {
  const phone = normalizeBdMobile(order.billingDetails?.phone);
  const address = buildRecipientAddress(order);
  const name = order.billingDetails?.name;

  if (!name?.trim()) return { ok: false, error: "Customer name is required" };
  if (!isValidBdMobile(phone)) {
    return { ok: false, error: "Valid BD mobile (01XXXXXXXXX) is required" };
  }
  if (!address.trim() || address.length < 10) {
    return {
      ok: false,
      error: "Customer delivery address is required (min 10 chars)",
    };
  }
  if (order.shipment?.bookingSource === "api" && order.shipment?.trackingId) {
    return { ok: false, error: "Parcel already booked via API for this order" };
  }
  return { ok: true, phone, address, name: name.trim() };
}

export async function bookParcelWithCourier(order, courierSlug, options = {}) {
  const slug = String(courierSlug).toLowerCase();
  const validation = validateOrderForBooking(order);
  if (!validation.ok) return validation;

  const integration = await getCourierIntegration(slug);
  if (!integration.configured) {
    return {
      ok: false,
      error: `${slug} is not configured. Add credentials in Shipment Settings.`,
      code: "courier_not_configured",
    };
  }

  if (integration.apiEnabled === false) {
    return { ok: false, error: `${slug} API is disabled in settings` };
  }

  if (integration.capabilities?.parcelCreate === false) {
    return { ok: false, error: `Parcel booking is disabled for ${slug}` };
  }

  const payload = {
    orderId: order._id,
    // Send the human-friendly order number (e.g. "apl1001") as the courier's
    // merchant invoice id so it matches what's shown everywhere else. Fall back
    // to the legacy hash only for any pre-migration order without a number.
    merchantOrderId:
      order.orderNumber || steadfastInvoiceFromOrderId(order._id),
    recipientName: validation.name,
    recipientPhone: validation.phone,
    recipientAddress: validation.address,
    recipientCity: order.billingDetails?.city || "",
    codAmount: options.codAmount ?? defaultCodAmount(order),
    weight: Number(
      options.weight || integration.storeConfig?.defaultWeight || 0.5,
    ),
    weightGrams: Math.round(
      Number(
        options.weightGrams ||
          (options.weight || integration.storeConfig?.defaultWeight || 0.5) *
            1000,
      ),
    ),
    itemQuantity: Number(options.itemQuantity || totalItemQuantity(order)),
    itemDescription: options.itemDescription || buildItemDescription(order),
    // Structured line items for couriers that accept a per-product breakdown
    // (e.g. RedX parcel_details_json). Others just use itemDescription above.
    // Include the variant (color/size) in the name so the breakdown matches the
    // human-readable itemDescription and the courier/rider knows the variant.
    items: (Array.isArray(order.items) ? order.items : []).map((it) => {
      const name = String(it?.title || "Item").trim();
      const variant = itemVariantString(it);
      return {
        name: variant ? `${name} (${variant})` : name,
        quantity: Number(it?.quantity) || 1,
        price: Math.round(Number(it?.price) || 0),
      };
    }),
    note: options.note || order.billingDetails?.note || "",
    declaredValue: options.declaredValue ?? defaultCodAmount(order),
    deliveryAreaId: options.deliveryAreaId,
    deliveryAreaName: options.deliveryAreaName,
  };

  let result;
  switch (slug) {
    case "pathao":
      result = await createPathaoOrder(
        integration.creds,
        integration.storeConfig,
        payload,
      );
      break;
    case "steadfast":
      result = await createSteadfastOrder(
        integration.creds,
        integration.storeConfig,
        payload,
      );
      break;
    case "redx":
      result = await createRedxOrder(
        integration.creds,
        integration.storeConfig,
        payload,
      );
      break;
    default:
      return { ok: false, error: "Unsupported courier for API booking" };
  }

  if (!result.consignmentId) {
    return {
      ok: false,
      error: "Courier did not return a tracking/consignment ID",
      raw: result.raw,
    };
  }

  return {
    ok: true,
    courier: slug,
    consignmentId: result.consignmentId,
    trackingUrl: result.trackingUrl,
    raw: result.raw,
  };
}
