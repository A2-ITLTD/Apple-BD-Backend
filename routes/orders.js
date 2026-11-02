import express from "express";
import jwt from "jsonwebtoken";
import { orderLimiter } from "../lib/rateLimiters.js";
import SSLCommerzPayment from "sslcommerz-lts";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import User from "../models/User.js";
import Admin from "../models/Admin.js";
import Discount from "../models/Discount.js";
import CouponUsage from "../models/CouponUsage.js";
import CheckoutSession from "../models/CheckoutSession.js";
import {
  sendOrderConfirmationEmail,
  sendAdminOrderNotification,
  sendPaymentConfirmedEmail,
  sendOrderCancelledEmail,
} from "../lib/mailer.js";
import { syncOrderShipment } from "../lib/shipmentTracking.js";
import { requirePermission } from "../lib/permissions.js";
import { getCourierLabelMap } from "../lib/courierDefaults.js";
import {
  findOrderByIdOrSuffix,
  findOrderByTrackingId,
  findOrderByTrackingUrl,
  findOrdersByPhone,
  formatOrderIdSuffix,
  toPublicTrackOrder,
  phoneMatchesOrder,
} from "../lib/orderLookup.js";
import { applyOrderStatusChange } from "../lib/orderStatus.js";
import {
  POINTS_PER_TK,
  calcItemsRewardPoints,
  calcLineRewardPoints,
  deductUserRewardPoints,
  refundUserRewardPoints,
  creditOrderRewardPoints,
  resolveRedeemablePoints,
} from "../lib/rewards.js";

const router = express.Router();

const BACKEND_URL = process.env.BACKEND_URL || "https://api.applebd.com";
const FRONTEND_URL = process.env.FRONTEND_ORIGIN || "https://applebd.com";
// Credentials are read lazily (inside each handler) so they are always
// resolved after dotenv has populated process.env, regardless of ESM
// module evaluation order.
const getSSLCreds = () => [process.env.STORE_ID, process.env.STORE_PASSWORD];
const is_live = process.env.IS_LIVE === "true";

// Dhaka city name variants (case-insensitive match)
const DHAKA_NAMES = ["dhaka", "ঢাকা"];
const isDhaka = (city) =>
  !!city && DHAKA_NAMES.some((d) => city.trim().toLowerCase() === d);

// Case-insensitive/trim match helper for zone & area names.
const sameName = (a, b) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Location-aware base shipping, driven by the admin-configured
 * Setting.deliveryCharge (falls back to the ৳70 / ৳130 defaults if no
 * config exists yet):
 *   - outsideDhaka charge when city isn't Dhaka
 *   - insideDhaka charge by default when city is Dhaka
 *   - a per-zone override, or a more specific per-area override within that
 *     zone, when configured for the matching Dhaka zone/area
 *   - 0 when city is unknown (not yet selected)
 */
const calcBaseShipping = async (city, zone, area) => {
  if (!city) return 0;

  const Setting = (await import("../models/Setting.js")).default;
  const settings = await Setting.findOne().select("deliveryCharge").lean();
  const config = settings?.deliveryCharge || {};
  const insideDhaka = config.insideDhaka ?? 70;
  const outsideDhaka = config.outsideDhaka ?? 130;

  if (!isDhaka(city)) return outsideDhaka;

  const zoneEntry = zone
    ? (config.zones || []).find((z) => sameName(z.zone, zone))
    : null;
  if (zoneEntry) {
    const areaEntry = area
      ? (zoneEntry.areas || []).find((a) => sameName(a.area, area))
      : null;
    if (areaEntry?.charge != null) return areaEntry.charge;
    if (zoneEntry.charge != null) return zoneEntry.charge;
  }

  return insideDhaka;
};

/**
 * Check if user is eligible for a coupon
 */
const checkCouponEligibility = async (coupon, userId, subtotal) => {
  // Check if coupon is active
  if (!coupon.isActive) {
    return { valid: false, error: "Coupon is not active." };
  }

  // Check if coupon is expired
  if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
    return { valid: false, error: "This coupon has expired." };
  }

  // Check minimum order amount
  if (coupon.minOrderAmount > 0 && subtotal < coupon.minOrderAmount) {
    return {
      valid: false,
      error: `Minimum order of ৳${coupon.minOrderAmount} required for coupon "${coupon.couponCode}".`,
    };
  }

  // Check total usage limit
  if (coupon.maxUsesTotal > 0 && coupon.usageCount >= coupon.maxUsesTotal) {
    return { valid: false, error: "This coupon has reached its usage limit." };
  }

  // User-specific checks
  if (userId) {
    const userDoc = await User.findById(userId).select("createdAt").lean();

    // Check new user requirement
    if (coupon.isNewUserOnly) {
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const isNewUser =
        userDoc && new Date(userDoc.createdAt).getTime() > thirtyDaysAgo;
      if (!isNewUser) {
        return {
          valid: false,
          error: "This coupon is only valid for new users.",
        };
      }
    }

    // Check first order requirement
    if (coupon.isFirstOrderOnly) {
      const orderCount = await Order.countDocuments({
        userId,
        status: { $nin: ["cancelled", "failed"] },
      });
      if (orderCount > 0) {
        return {
          valid: false,
          error: "This coupon is only valid for your first order.",
        };
      }
    }

    // Check per-user usage limit
    if (coupon.maxUsesPerUser > 0) {
      const userUsageCount = await CouponUsage.countDocuments({
        userId,
        couponId: coupon._id,
      });
      if (userUsageCount >= coupon.maxUsesPerUser) {
        return {
          valid: false,
          error: `You have already used this coupon ${userUsageCount} time(s).`,
        };
      }
    }
  } else {
    // Guest users can't use user-specific coupons
    if (coupon.isNewUserOnly || coupon.isFirstOrderOnly) {
      return { valid: false, error: "Please login to use this coupon." };
    }
  }

  return { valid: true };
};

/**
 * Calculate discount value for a coupon
 */
const calculateCouponDiscount = (coupon, subtotal) => {
  if (coupon.discountType === "free_shipping") {
    return { type: "free_shipping", value: 0, givesFreeShipping: true };
  }

  if (coupon.discountType === "percentage") {
    let discount = (subtotal * coupon.discountValue) / 100;
    if (coupon.maxDiscountAmount > 0) {
      discount = Math.min(discount, coupon.maxDiscountAmount);
    }
    return { type: "percentage", value: discount, givesFreeShipping: false };
  }

  // fixed
  return {
    type: "fixed",
    value: coupon.discountValue,
    givesFreeShipping: false,
  };
};

// ── variant attribute matching ────────────────────────────────────────────────
const VARIANT_COLOR_RE = /^colou?rs?$/i;
const VARIANT_SIZE_RE = /^sizes?$/i;

// Normalised attribute map for a DB variant: explicit `attributes` plus
// Color/Size synthesised from the denormalised color.name / size fields, so a
// variant can be matched by any combination of Color, Size and generic groups.
const backendVariantAttrMap = (v) => {
  const map = {};
  Object.entries(v.attributes || {}).forEach(([k, val]) => {
    const s = val == null ? "" : String(val).trim();
    if (s) map[k] = s;
  });
  const colorName = v.color?.name?.trim();
  if (colorName && !Object.keys(map).some((k) => VARIANT_COLOR_RE.test(k))) {
    map.Color = colorName;
  }
  const sizeVal = v.size?.trim();
  if (sizeVal && !Object.keys(map).some((k) => VARIANT_SIZE_RE.test(k))) {
    map.Size = sizeVal;
  }
  return map;
};

// Find the single variant matching ALL provided attributes (case-insensitive).
// `attributes` is a plain map { groupName: value } — blanks are ignored.
const matchVariantByAttributes = (prod, attributes) => {
  const entries = Object.entries(attributes || {}).filter(
    ([, v]) => v != null && String(v).trim(),
  );
  if (!entries.length || !prod.variants?.length) return null;
  return (
    prod.variants.find((v) => {
      const map = backendVariantAttrMap(v);
      const keys = Object.keys(map);
      return entries.every(([g, val]) => {
        const k = keys.find((x) => x.toLowerCase() === g.toLowerCase());
        return k && map[k].toLowerCase() === String(val).trim().toLowerCase();
      });
    }) || null
  );
};

// Normalise a client-supplied attributes object/Map to a plain {group: value}
// map with blanks stripped. Accepts a Map (Mongoose) or a plain object.
const cleanAttributes = (raw) => {
  const entries =
    raw instanceof Map
      ? [...raw.entries()]
      : raw && typeof raw === "object"
        ? Object.entries(raw)
        : [];
  return Object.fromEntries(
    entries.filter(([, v]) => v != null && String(v).trim()),
  );
};

// ── resolveAndQuote ───────────────────────────────────────────────────────────
// Shared helper used by both /quote (read-only preview) and POST / (order save).
// Fetches real prices from the DB, validates coupon(s), and returns the full
// pricing breakdown. Supports up to 2 stackable coupons (1 if cart has free-shipping product).
// couponCodes can be a single code string or array of codes.
const resolveAndQuote = async (
  clientItems,
  couponCodes,
  resolvedUserId,
  city,
  pointsToRedeem = 0,
  zone = null,
  area = null,
) => {
  const productIds = clientItems.map((i) => i.productId).filter(Boolean);
  const dbProducts = await Product.find({ _id: { $in: productIds } }).lean();
  const productMap = Object.fromEntries(
    dbProducts.map((p) => [p._id.toString(), p]),
  );

  const items = [];
  for (const ci of clientItems) {
    const prod = productMap[ci.productId?.toString()];
    if (!prod) {
      const err = new Error(`Product not found: ${ci.productId}`);
      err.status = 400;
      throw err;
    }
    const qty = Math.max(1, parseInt(ci.quantity) || 1);

    // Combined generic-variant selection sent alongside color/size, e.g.
    // { Type: "8 Pin" }. Optional — the customer may leave it unset.
    const extraAttrs = cleanAttributes(ci.attributes);
    const hasExtraAttrs = Object.keys(extraAttrs).length > 0;

    let unitPrice = prod.price ?? 0;
    if (prod.variants?.length && hasExtraAttrs) {
      // Match the exact combo across Color + Size + every generic group so
      // e.g. White + 8-Pin resolves to its own variant/price. Fall back to
      // extras-only, then color/size-only (color is cosmetic, so the generic
      // group price wins when there's no exact combined variant).
      const fullAttrs = {
        ...(ci.color ? { Color: ci.color } : {}),
        ...(ci.size ? { Size: ci.size } : {}),
        ...extraAttrs,
      };
      let variant = matchVariantByAttributes(prod, fullAttrs);
      if (!variant) variant = matchVariantByAttributes(prod, extraAttrs);
      if (!variant && (ci.color || ci.size)) {
        variant = matchVariantByAttributes(prod, {
          ...(ci.color ? { Color: ci.color } : {}),
          ...(ci.size ? { Size: ci.size } : {}),
        });
      }
      if (variant && variant.price != null && variant.price > 0) {
        unitPrice = variant.price;
      }
    } else if (prod.variants?.length && (ci.color || ci.size)) {
      // Try new structure first (v.color.name, v.size)
      let variant = prod.variants.find((v) => {
        const variantColor = v.color?.name?.toLowerCase()?.trim();
        const variantSize = v.size?.toLowerCase()?.trim();
        const selectedColor = ci.color?.toLowerCase()?.trim();
        const selectedSize = ci.size?.toLowerCase()?.trim();

        const colorMatches =
          !variantColor || !selectedColor || variantColor === selectedColor;
        const sizeMatches =
          !variantSize || !selectedSize || variantSize === selectedSize;
        const hasMatch =
          (variantColor && selectedColor && variantColor === selectedColor) ||
          (variantSize && selectedSize && variantSize === selectedSize);

        return hasMatch && colorMatches && sizeMatches;
      });

      // Fallback to old structure (v.attributes.color, v.attributes.size)
      if (!variant) {
        variant = prod.variants.find((v) => {
          const variantColor = v.attributes?.color?.toLowerCase()?.trim();
          const variantSize = v.attributes?.size?.toLowerCase()?.trim();
          const selectedColor = ci.color?.toLowerCase()?.trim();
          const selectedSize = ci.size?.toLowerCase()?.trim();

          const colorMatches =
            !variantColor || !selectedColor || variantColor === selectedColor;
          const sizeMatches =
            !variantSize || !selectedSize || variantSize === selectedSize;
          const hasMatch =
            (variantColor && selectedColor && variantColor === selectedColor) ||
            (variantSize && selectedSize && variantSize === selectedSize);

          return hasMatch && colorMatches && sizeMatches;
        });
      }

      // Use variant price if available, otherwise fall back to base product price
      if (variant && variant.price != null && variant.price > 0) {
        unitPrice = variant.price;
      }
    }

    items.push({
      productId: prod._id,
      title: prod.title,
      price: unitPrice,
      quantity: qty,
      lineTotal: unitPrice * qty,
      image: prod.images?.[0]?.url || null,
      color: ci.color || null,
      size: ci.size || null,
      attrGroup: ci.attrGroup || null,
      attrValue: ci.attrValue || null,
      attributes: hasExtraAttrs ? extraAttrs : undefined,
      rewardPoints: Math.max(0, Number(prod.rewardPoints) || 0),
      isPreorder: prod.availability === "pre_order",
    });
  }

  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);

  // If any cart item has product-level free shipping, shipping is always 0
  const hasFreeShipping = items.some(
    (i) => productMap[i.productId.toString()]?.freeShipping === true,
  );
  const baseShipping = hasFreeShipping
    ? 0
    : await calcBaseShipping(city, zone, area);

  let totalCouponDiscount = 0;
  let couponGivesFreeShip = false;
  const appliedCoupons = [];
  const couponErrors = [];

  // Normalize couponCodes to array
  let codes = [];
  if (couponCodes) {
    if (Array.isArray(couponCodes)) {
      codes = couponCodes.map((c) => c?.trim().toUpperCase()).filter(Boolean);
    } else {
      codes = [couponCodes.trim().toUpperCase()];
    }
  }

  // If any product has free shipping, max 1 coupon; otherwise max 2
  codes = hasFreeShipping ? codes.slice(0, 1) : codes.slice(0, 2);

  // Process each coupon code
  for (const code of codes) {
    // Find coupon in database
    const coupon = await Discount.findOne({
      couponCode: code.toUpperCase(),
      isActive: true,
    }).lean();

    if (!coupon) {
      couponErrors.push({ code, error: "Invalid coupon code." });
      continue;
    }

    // Check eligibility
    const eligibility = await checkCouponEligibility(
      coupon,
      resolvedUserId,
      subtotal,
    );
    if (!eligibility.valid) {
      couponErrors.push({ code, error: eligibility.error });
      continue;
    }

    // Check stackability (only first coupon can be non-stackable, others must be stackable)
    if (appliedCoupons.length > 0 && !coupon.stackable) {
      couponErrors.push({
        code,
        error: "This coupon cannot be combined with others.",
      });
      continue;
    }
    if (appliedCoupons.length > 0 && appliedCoupons.some((c) => !c.stackable)) {
      couponErrors.push({
        code,
        error: "A non-stackable coupon is already applied.",
      });
      continue;
    }

    // Calculate discount
    const discountResult = calculateCouponDiscount(coupon, subtotal);

    if (discountResult.givesFreeShipping) {
      couponGivesFreeShip = true;
    } else {
      totalCouponDiscount += discountResult.value;
    }

    appliedCoupons.push({
      _id: coupon._id,
      code: coupon.couponCode,
      title: coupon.title,
      discountType: coupon.discountType,
      discountValue: discountResult.value,
      givesFreeShipping: discountResult.givesFreeShipping,
      stackable: coupon.stackable,
    });
  }

  // If only one code was provided and it failed, throw error for backwards compatibility
  if (
    codes.length === 1 &&
    couponErrors.length === 1 &&
    appliedCoupons.length === 0
  ) {
    const err = new Error(couponErrors[0].error);
    err.status = 400;
    throw err;
  }

  const shipping = couponGivesFreeShip ? 0 : baseShipping;
  const discount = totalCouponDiscount;
  const prePointsTotal = Math.max(0, subtotal + shipping - discount);
  const rewardPointsEarned = calcItemsRewardPoints(items);

  let availablePoints = 0;
  let pointsRedeemed = 0;
  let pointsDiscount = 0;

  if (resolvedUserId) {
    const userDoc = await User.findById(resolvedUserId)
      .select("rewardPointsBalance")
      .lean();
    availablePoints = userDoc?.rewardPointsBalance || 0;
    if (pointsToRedeem > 0) {
      const redeem = resolveRedeemablePoints(
        pointsToRedeem,
        availablePoints,
        prePointsTotal,
      );
      pointsRedeemed = redeem.pointsRedeemed;
      pointsDiscount = redeem.pointsDiscount;
    }
  }

  const total = Math.max(0, prePointsTotal - pointsDiscount);

  // Legacy fields for backwards compatibility (single coupon)
  const appliedCouponCode =
    appliedCoupons.length > 0 ? appliedCoupons[0].code : null;
  const couponHeadline =
    appliedCoupons.length > 0 ? appliedCoupons[0].title : null;

  return {
    items,
    subtotal,
    baseShipping,
    shipping,
    autoDiscount: 0, // No more auto discount - all discounts come from coupons
    couponDiscount: totalCouponDiscount,
    discount,
    total,
    freeShippingFromCoupon: couponGivesFreeShip,
    appliedCouponCode,
    couponHeadline,
    appliedCoupons,
    couponErrors,
    insideDhaka: isDhaka(city),
    rewardPointsEarned,
    availablePoints,
    pointsRedeemed,
    pointsDiscount,
    pointsPerTk: POINTS_PER_TK,
  };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extracts the logged-in user's MongoDB _id from the JWT cookie, if present. */
const getUserId = (req) => {
  try {
    const token = req.cookies?.token;
    if (!token) return null;
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload.type === "admin" ? null : (payload.id?.toString() ?? null);
  } catch {
    return null;
  }
};

// Resolve requester identity for ownership checks and order-history lookups.
// We match by userId first, then by email to support legacy/guest-linked orders.
const getRequesterIdentity = async (req) => {
  try {
    const token = req.cookies?.token;
    if (!token) return null;

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const id = payload?.id ? payload.id.toString() : null;

    if (!id) return null;

    let email = null;
    if (payload.type === "admin") {
      const admin = await Admin.findById(id).select("email").lean();
      email = admin?.email ? String(admin.email).trim().toLowerCase() : null;
    } else {
      const user = await User.findById(id).select("email").lean();
      email = user?.email ? String(user.email).trim().toLowerCase() : null;
    }

    return { id, email, type: payload.type || "user" };
  } catch {
    return null;
  }
};

// ── Guest order-access grant ────────────────────────────────────────────────
// Guests (no login) still need to view the full confirmation and self-edit/
// cancel the order they just placed, without exposing name/phone/address to any
// stranger who merely guesses the order id. On creation we set an httpOnly,
// signed cookie listing the order ids this browser is allowed to access. It is
// scoped to those ids only (not a login), and expires after the edit window.
const ORDER_GRANT_COOKIE = "orderGrant";
const ORDER_GRANT_TTL_MS = 2 * 60 * 60 * 1000; // 2h — covers the 1h edit window

// Read the set of order ids this browser has been granted access to.
const getGrantedOrderIds = (req) => {
  const raw = req.cookies?.[ORDER_GRANT_COOKIE];
  if (!raw) return [];
  try {
    const payload = jwt.verify(raw, process.env.JWT_SECRET);
    return Array.isArray(payload?.oids) ? payload.oids.map(String) : [];
  } catch {
    return [];
  }
};

const hasOrderGrant = (req, order) => {
  if (!order) return false;
  return getGrantedOrderIds(req).includes(String(order._id));
};

// Append the just-placed order id to the grant cookie (keeping recent grants so
// a buyer who places several orders can still edit each one's confirmation).
const grantOrderAccess = (req, res, orderId) => {
  const existing = getGrantedOrderIds(req);
  const oids = [...new Set([String(orderId), ...existing])].slice(0, 10);
  const token = jwt.sign({ oids }, process.env.JWT_SECRET, {
    expiresIn: Math.floor(ORDER_GRANT_TTL_MS / 1000),
  });
  res.cookie(ORDER_GRANT_COOKIE, token, {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    maxAge: ORDER_GRANT_TTL_MS,
  });
};

const ownsOrder = (order, identity) => {
  if (!order || !identity) return false;

  const ownerId = order.userId ? String(order.userId) : null;
  if (identity.id && ownerId && identity.id === ownerId) return true;

  const normalizedEmail = identity.email
    ? String(identity.email).trim().toLowerCase()
    : null;
  if (!normalizedEmail) return false;

  const orderEmail = order.userEmail
    ? String(order.userEmail).trim().toLowerCase()
    : null;
  const billingEmail = order.billingDetails?.email
    ? String(order.billingDetails.email).trim().toLowerCase()
    : null;

  return normalizedEmail === orderEmail || normalizedEmail === billingEmail;
};

const resolveVariantPrice = (product, color, size) => {
  if (!product) return null;

  const selectedColor = String(color || "")
    .trim()
    .toLowerCase();
  const selectedSize = String(size || "")
    .trim()
    .toLowerCase();

  if (!Array.isArray(product.variants) || !product.variants.length) {
    return product.price ?? null;
  }

  const matchedVariant = product.variants.find((variant) => {
    const variantColor = String(
      variant?.color?.name || variant?.attributes?.color || "",
    )
      .trim()
      .toLowerCase();
    const variantSize = String(variant?.size || variant?.attributes?.size || "")
      .trim()
      .toLowerCase();
    const colorMatches =
      !variantColor || !selectedColor || variantColor === selectedColor;
    const sizeMatches =
      !variantSize || !selectedSize || variantSize === selectedSize;
    const hasMatch =
      (variantColor && selectedColor && variantColor === selectedColor) ||
      (variantSize && selectedSize && variantSize === selectedSize);
    return hasMatch && colorMatches && sizeMatches;
  });

  return matchedVariant?.price != null
    ? matchedVariant.price
    : (product.price ?? null);
};

// Price for a full color + size + combined generic-attributes selection, with
// the same fallbacks as resolveAndQuote (full combo → extras-only →
// color/size-only). Used when re-pricing edited/added order items.
const priceForSelection = (product, color, size, attributes) => {
  if (!product) return null;
  const extra = cleanAttributes(attributes);
  if (product.variants?.length && Object.keys(extra).length) {
    const cs = {
      ...(color ? { Color: color } : {}),
      ...(size ? { Size: size } : {}),
    };
    let variant = matchVariantByAttributes(product, { ...cs, ...extra });
    if (!variant) variant = matchVariantByAttributes(product, extra);
    if (!variant && (color || size)) {
      variant = matchVariantByAttributes(product, cs);
    }
    if (variant && variant.price != null && variant.price > 0) {
      return variant.price;
    }
  }
  return resolveVariantPrice(product, color, size);
};

// ── POST /api/orders/quote ───────────────────────────────────────────────────
// Read-only price preview. No DB writes. The frontend calls this whenever cart
// contents change or a coupon is applied, and displays ONLY these server values.
router.post("/quote", async (req, res) => {
  try {
    const {
      items: clientItems,
      couponCode,
      couponCodes,
      city,
      zone,
      area,
      pointsToRedeem,
    } = req.body;
    if (!Array.isArray(clientItems) || !clientItems.length) {
      return res.status(400).json({ error: "No items provided." });
    }
    const resolvedUserId = getUserId(req);
    // Support both single couponCode and array of couponCodes
    const codes = couponCodes || couponCode || null;
    const quote = await resolveAndQuote(
      clientItems,
      codes,
      resolvedUserId,
      city || null,
      pointsToRedeem || 0,
      zone || null,
      area || null,
    );
    res.json(quote);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/orders/shipping-quote — delivery charge from an address alone
// (no cart items). Used by the admin manual-order form so the charge can be
// shown as soon as an address is picked, before any product is added.
router.post("/shipping-quote", async (req, res) => {
  try {
    const { city, zone, area } = req.body || {};
    const shipping = await calcBaseShipping(
      city || null,
      zone || null,
      area || null,
    );
    res.json({ shipping, insideDhaka: isDhaka(city) });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── POST /api/orders ──────────────────────────────────────────────────────────
// Creates an order. Returns { ok, orderId, method } for COD or
// { ok, orderId, method, url } for online/bkash (SSLCommerz payment URL).
router.post("/", orderLimiter, async (req, res) => {
  try {
    const {
      userEmail,
      items: clientItems,
      billingDetails,
      paymentMethod,
      couponCode,
      couponCodes,
      pointsToRedeem,
      deviceId,
    } = req.body;

    if (
      !Array.isArray(clientItems) ||
      !clientItems.length ||
      !billingDetails?.name ||
      !billingDetails?.phone ||
      !billingDetails?.city ||
      !billingDetails?.zone
    ) {
      return res.status(400).json({ error: "Missing required order fields" });
    }

    // ── Fake Order Protection ─────────────────────────────────────────────────
    try {
      const Setting = (await import("../models/Setting.js")).default;
      const fop = (await Setting.findOne().lean())?.fakeOrderProtection;
      if (fop?.installed) {
        const clientIp =
          (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
          req.socket?.remoteAddress ||
          "";
        const phone = billingDetails.phone?.replace(/\s+/g, "") || "";
        const now = new Date();

        // Sync blocklist checks first (no DB round-trips)
        if (fop.phoneOrder?.enabled && phone) {
          const phoneBlocklist = (fop.phoneOrder.blocklist || "")
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);
          if (phoneBlocklist.includes(phone)) {
            return res
              .status(400)
              .json({ error: "Orders cannot be placed from this number." });
          }
        }
        if (fop.ipOrder?.enabled && clientIp) {
          const ipBlocklist = (fop.ipOrder.blocklist || "")
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);
          if (ipBlocklist.includes(clientIp)) {
            return res
              .status(400)
              .json({ error: "Orders cannot be placed from this IP." });
          }
        }

        // Run all three rate-limit DB checks in parallel
        const mkSince = (dur, unit) =>
          new Date(now - (unit === "hours" ? dur * 3600000 : dur * 60000));
        const mkLabel = (dur, unit) =>
          unit === "hours" ? `${dur} hour(s)` : `${dur} minute(s)`;

        const phonePromise =
          fop.phoneOrder?.enabled && phone
            ? (() => {
                const dur = Number(fop.phoneOrder.limitDuration) || 5;
                const unit = fop.phoneOrder.limitDurationUnit || "minutes";
                return Order.countDocuments({
                  "billingDetails.phone": phone,
                  createdAt: { $gte: mkSince(dur, unit) },
                }).then((n) =>
                  n > 0
                    ? `An order has already been placed from this number. Please try again after ${mkLabel(dur, unit)}.`
                    : null,
                );
              })()
            : Promise.resolve(null);

        const ipPromise =
          fop.ipOrder?.enabled && clientIp
            ? (() => {
                const dur = Number(fop.ipOrder.limitDuration) || 5;
                const unit = fop.ipOrder.limitDurationUnit || "minutes";
                return Order.countDocuments({
                  clientIp,
                  createdAt: { $gte: mkSince(dur, unit) },
                }).then((n) =>
                  n > 0
                    ? `An order has already been placed from this location. Please try again after ${mkLabel(dur, unit)}.`
                    : null,
                );
              })()
            : Promise.resolve(null);

        const devicePromise =
          fop.deviceOrder?.enabled && deviceId
            ? (() => {
                const dur = Number(fop.deviceOrder.limitDuration) || 5;
                const unit = fop.deviceOrder.limitDurationUnit || "minutes";
                return Order.countDocuments({
                  deviceId,
                  createdAt: { $gte: mkSince(dur, unit) },
                }).then((n) =>
                  n > 0
                    ? `An order has already been placed from this device. Please try again after ${mkLabel(dur, unit)}.`
                    : null,
                );
              })()
            : Promise.resolve(null);

        const [phoneErr, ipErr, deviceErr] = await Promise.all([
          phonePromise,
          ipPromise,
          devicePromise,
        ]);
        if (phoneErr) return res.status(400).json({ error: phoneErr });
        if (ipErr) return res.status(400).json({ error: ipErr });
        if (deviceErr) return res.status(400).json({ error: deviceErr });
      }
    } catch (fopErr) {
      // don't block order on protection check failure
    }
    // ─────────────────────────────────────────────────────────────────────────

    // userId always comes from the JWT — the client value is never trusted
    const resolvedUserId = getUserId(req) || null;

    // All pricing is computed by the shared helper — no client figures trusted
    let quote;
    try {
      const orderCity = billingDetails?.city || null;
      const codes = couponCodes || couponCode || null;
      quote = await resolveAndQuote(
        clientItems,
        codes,
        resolvedUserId,
        orderCity,
        pointsToRedeem || 0,
        billingDetails?.zone || null,
        billingDetails?.area || null,
      );
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    const {
      items,
      subtotal,
      shipping,
      discount,
      total,
      appliedCouponCode,
      appliedCoupons,
      rewardPointsEarned,
      pointsRedeemed,
      pointsDiscount,
    } = quote;

    if (pointsRedeemed > 0 && !resolvedUserId) {
      return res
        .status(400)
        .json({ error: "Login required to use reward points." });
    }

    const order = new Order({
      userId: resolvedUserId,
      userEmail: userEmail || null,
      items,
      billingDetails,
      subtotal,
      shipping,
      discount,
      total,
      paymentMethod,
      couponCode: appliedCouponCode,
      appliedCoupons:
        appliedCoupons?.map((c) => ({
          code: c.code,
          discountValue: c.discountValue,
        })) || [],
      rewardPointsEarned: rewardPointsEarned || 0,
      rewardPointsRedeemed: pointsRedeemed || 0,
      rewardPointsDiscount: pointsDiscount || 0,
      status: "pending",
      // Customers may self-edit/cancel a COD order for 1 hour after placing it.
      // This is purely the edit/cancel deadline — it does NOT auto-confirm or
      // otherwise change the order status when it elapses.
      confirmAfter:
        paymentMethod === "cash-on-delivery"
          ? new Date(Date.now() + 60 * 60 * 1000)
          : null,
      paymentStatus: ["cash-on-delivery", "bkash", "nagad", "rocket"].includes(
        paymentMethod,
      )
        ? "cod"
        : "unpaid",
      clientIp:
        (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
        req.socket?.remoteAddress ||
        "",
      deviceId: deviceId || "",
      userAgent: req.headers["user-agent"] || "",
    });

    await order.save();

    // Grant this browser access to its own order (view full confirmation +
    // self-edit/cancel) even when checking out as a guest.
    grantOrderAccess(req, res, order._id);

    // Mark any open checkout sessions for this user as completed
    if (resolvedUserId) {
      CheckoutSession.updateMany(
        { userId: resolvedUserId, status: "incomplete" },
        { status: "completed", completedAt: new Date() },
      ).catch(() => {});
    }

    if (resolvedUserId && pointsRedeemed > 0) {
      await deductUserRewardPoints(resolvedUserId, pointsRedeemed);
    }

    // Track coupon usage
    if (resolvedUserId && appliedCoupons?.length > 0) {
      for (const coupon of appliedCoupons) {
        await CouponUsage.create({
          userId: resolvedUserId,
          couponId: coupon._id,
          orderId: order._id,
        });
        // Increment usage count on the discount
        await Discount.findByIdAndUpdate(coupon._id, {
          $inc: { usageCount: 1 },
        });
      }
    }

    // Send emails (non-blocking)
    sendOrderConfirmationEmail(order).catch(() => {});
    sendAdminOrderNotification(order).catch(() => {});

    // ── Cash on Delivery ──────────────────────────────────────────────────────
    if (paymentMethod === "cash-on-delivery") {
      return res.json({
        ok: true,
        orderId: order._id.toString(),
        orderNumber: order.orderNumber || null,
        method: "cod",
      });
    }

    // ── Manual Mobile Banking (bKash, Nagad, Rocket) ──────────────────────────
    if (["bkash", "nagad", "rocket"].includes(paymentMethod)) {
      const Setting = (await import("../models/Setting.js")).default;
      const settings = await Setting.findOne().lean();
      const cfg = settings?.mobileBanking?.[paymentMethod] || {};
      return res.json({
        ok: true,
        orderId: order._id.toString(),
        method: paymentMethod,
        merchantNumber: cfg.merchantNumber || "",
        amount: total,
      });
    }

    // ── Online → SSLCommerz ───────────────────────────────────────────────
    const [store_id, store_passwd] = getSSLCreds();
    if (!store_id || !store_passwd) {
      // Payment gateway not configured — fall back gracefully
      await Order.findByIdAndUpdate(order._id, {
        status: "failed",
        paymentStatus: "failed",
      });
      return res
        .status(503)
        .json({ error: "Payment gateway is not configured on the server." });
    }

    const tranId = order._id.toString();

    const sslData = {
      total_amount: total,
      tran_id: tranId,
      success_url: `${BACKEND_URL}/api/orders/payment/success`,
      fail_url: `${BACKEND_URL}/api/orders/payment/fail`,
      cancel_url: `${BACKEND_URL}/api/orders/payment/cancel`,
      ipn_url: `${BACKEND_URL}/api/orders/payment/ipn`,
      shipping_method: "Courier",
      product_name:
        items
          .map((i) => i.title)
          .join(", ")
          .slice(0, 255) || "AppleBD Order",
      product_category: "Mixed",
      product_profile: "general",
      num_of_item: items.reduce((s, i) => s + i.quantity, 0),
      cus_name: billingDetails.name,
      cus_email: billingDetails.email || userEmail || "customer@applebd.com",
      cus_add1: billingDetails.address || "N/A",
      cus_city: billingDetails.city || "Dhaka",
      cus_postcode: "1000",
      cus_country: "Bangladesh",
      cus_phone: billingDetails.phone,
      ship_name: billingDetails.name,
      ship_add1: billingDetails.address || "N/A",
      ship_city: billingDetails.city || "Dhaka",
      ship_postcode: "1000",
      ship_country: "Bangladesh",
    };

    const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live);
    const apiResponse = await sslcz.init(sslData);

    if (apiResponse?.GatewayPageURL) {
      order.transactionId = tranId;
      await order.save();
      return res.json({
        ok: true,
        orderId: tranId,
        method: "online",
        url: apiResponse.GatewayPageURL,
      });
    }

    // SSLCommerz init failed
    await Order.findByIdAndUpdate(order._id, {
      status: "failed",
      paymentStatus: "failed",
    });
    return res.status(502).json({
      error:
        apiResponse?.failedreason ||
        "Payment gateway initialisation failed. Please try again.",
    });
  } catch (err) {
    res.status(500).json({ error: "Server error placing order." });
  }
});

// ── SSLCommerz Callbacks ──────────────────────────────────────────────────────

// SSLCommerz POSTs here after successful card payment
router.post("/payment/success", async (req, res) => {
  try {
    const { tran_id, val_id, status, amount } = req.body;

    if (!tran_id)
      return res.redirect(`${FRONTEND_URL}/checkout/fail?reason=missing_id`);

    if (status === "VALID" || status === "VALIDATED") {
      const [store_id, store_passwd] = getSSLCreds();
      const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live);
      const validation = await sslcz.validate({ val_id });

      if (
        validation?.status === "VALID" ||
        validation?.status === "VALIDATED"
      ) {
        // ── Amount integrity check ──────────────────────────────────────────
        // Reject if paid amount differs from our stored order total by more than
        // ৳1 (SSLCommerz rounds to 2 decimal places, allowing minor float diff).
        const order = await Order.findById(tran_id);
        if (!order)
          return res.redirect(`${FRONTEND_URL}/checkout/fail?reason=not_found`);

        const paidAmt = parseFloat(validation.amount || amount || 0);
        if (Math.abs(paidAmt - order.total) > 1) {
          await Order.findByIdAndUpdate(tran_id, {
            status: "failed",
            paymentStatus: "failed",
            updatedAt: new Date(),
          });
          return res.redirect(
            `${FRONTEND_URL}/checkout/fail?orderId=${tran_id}&reason=amount_mismatch`,
          );
        }
        // ──────────────────────────────────────────────────────────────

        // Payment success only records that money was received — it must NOT
        // advance the order status. The order stays "pending" until an
        // authorized admin/moderator changes it manually
        // (PUT /api/admin/orders/:id/status). No automatic confirmation.
        await Order.findByIdAndUpdate(tran_id, {
          paymentStatus: "paid",
          valId: val_id,
          paidAmount: paidAmt,
          updatedAt: new Date(),
        });

        // Send payment-confirmed email (non-blocking)
        sendPaymentConfirmedEmail({
          ...order.toObject(),
          paymentStatus: "paid",
          valId: val_id,
        }).catch(() => {});

        return res.redirect(
          `${FRONTEND_URL}/thankyou/success?orderId=${tran_id}`,
        );
      }
    }

    // Validation failed
    await Order.findByIdAndUpdate(tran_id, {
      status: "failed",
      paymentStatus: "failed",
      updatedAt: new Date(),
    });
    return res.redirect(`${FRONTEND_URL}/checkout/fail?orderId=${tran_id}`);
  } catch (err) {
    res.redirect(`${FRONTEND_URL}/checkout/fail?reason=server_error`);
  }
});

// SSLCommerz POSTs here after failed payment
router.post("/payment/fail", async (req, res) => {
  try {
    const { tran_id } = req.body;
    if (tran_id) {
      await Order.findByIdAndUpdate(tran_id, {
        status: "failed",
        paymentStatus: "failed",
        updatedAt: new Date(),
      });
    }
    res.redirect(`${FRONTEND_URL}/checkout/fail?orderId=${tran_id || ""}`);
  } catch (err) {
    res.redirect(`${FRONTEND_URL}/checkout/fail`);
  }
});

// SSLCommerz POSTs here when user cancels payment (closed modal without paying)
// We keep the order alive as unpaid so the user can retry from their order history.
router.post("/payment/cancel", async (req, res) => {
  try {
    const { tran_id } = req.body;
    if (tran_id) {
      await Order.findByIdAndUpdate(tran_id, {
        status: "pending",
        paymentStatus: "unpaid",
        updatedAt: new Date(),
      });
    }
    res.redirect(`${FRONTEND_URL}/checkout/cancel?orderId=${tran_id || ""}`);
  } catch (err) {
    res.redirect(`${FRONTEND_URL}/checkout/cancel`);
  }
});

// Background IPN from SSLCommerz (server-to-server, no browser redirect needed)
router.post("/payment/ipn", async (req, res) => {
  try {
    const { tran_id, val_id, status, amount } = req.body;
    if ((status === "VALID" || status === "VALIDATED") && tran_id && val_id) {
      const [store_id, store_passwd] = getSSLCreds();
      const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live);
      const validation = await sslcz.validate({ val_id });
      if (
        validation?.status === "VALID" ||
        validation?.status === "VALIDATED"
      ) {
        const order = await Order.findById(tran_id);
        if (order && order.paymentStatus !== "paid") {
          const paidAmt = parseFloat(validation.amount || amount || 0);
          if (Math.abs(paidAmt - order.total) <= 1) {
            // Record payment only — never auto-advance the order status.
            // It stays "pending" until an authorized admin changes it manually.
            await Order.findByIdAndUpdate(tran_id, {
              paymentStatus: "paid",
              valId: val_id,
              paidAmount: paidAmt,
              updatedAt: new Date(),
            });
          } else {
            await Order.findByIdAndUpdate(tran_id, {
              status: "failed",
              paymentStatus: "failed",
              updatedAt: new Date(),
            });
          }
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    res.json({ received: true });
  }
});

// ── GET /api/orders/my ────────────────────────────────────────────────────────
// Returns orders for the currently logged-in user.

// ── POST /api/orders/:id/pay ─────────────────────────────────────────────────
// Re-initiate SSLCommerz for an existing unpaid/failed online order.
// Called from the fail/cancel pages so the user never has to re-fill the form.
router.post("/:id/pay", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });

    // Only the order owner can retry
    const identity = await getRequesterIdentity(req);
    if (!ownsOrder(order, identity)) {
      return res.status(403).json({ error: "Not your order." });
    }
    if (order.paymentMethod === "cash-on-delivery") {
      return res
        .status(400)
        .json({ error: "COD orders do not require online payment." });
    }
    if (order.paymentStatus === "paid") {
      return res
        .status(400)
        .json({ error: "This order has already been paid." });
    }
    if (!["unpaid", "failed"].includes(order.paymentStatus)) {
      return res
        .status(400)
        .json({ error: `Cannot retry for status "${order.paymentStatus}".` });
    }
    const [store_id, store_passwd] = getSSLCreds();
    if (!store_id || !store_passwd) {
      return res
        .status(503)
        .json({ error: "Payment gateway is not configured." });
    }

    // Reset to pending so callbacks can update it
    order.status = "pending";
    order.paymentStatus = "unpaid";
    order.updatedAt = new Date();
    await order.save();

    const tranId = order._id.toString();
    const billing = order.billingDetails || {};

    const sslData = {
      total_amount: order.total,
      tran_id: tranId,
      success_url: `${BACKEND_URL}/api/orders/payment/success`,
      fail_url: `${BACKEND_URL}/api/orders/payment/fail`,
      cancel_url: `${BACKEND_URL}/api/orders/payment/cancel`,
      ipn_url: `${BACKEND_URL}/api/orders/payment/ipn`,
      shipping_method: "Courier",
      product_name:
        (order.items || [])
          .map((i) => i.title)
          .join(", ")
          .slice(0, 255) || "AppleBD Order",
      product_category: "Mixed",
      product_profile: "general",
      num_of_item: (order.items || []).reduce((s, i) => s + i.quantity, 0),
      cus_name: billing.name || "Customer",
      cus_email: billing.email || order.userEmail || "customer@applebd.com",
      cus_add1: billing.address || "N/A",
      cus_city: billing.city || "Dhaka",
      cus_postcode: "1000",
      cus_country: "Bangladesh",
      cus_phone: billing.phone || "N/A",
      ship_name: billing.name || "Customer",
      ship_add1: billing.address || "N/A",
      ship_city: billing.city || "Dhaka",
      ship_postcode: "1000",
      ship_country: "Bangladesh",
    };

    const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live);
    const apiResponse = await sslcz.init(sslData);

    if (apiResponse?.GatewayPageURL) {
      order.transactionId = tranId;
      await order.save();
      return res.json({ ok: true, url: apiResponse.GatewayPageURL });
    }

    return res.status(502).json({
      error:
        apiResponse?.failedreason ||
        "Payment gateway failed. Please try again.",
    });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

async function requireAdmin(req, res, next) {
  try {
    const token = req.cookies?.token;
    if (!token) return res.status(401).json({ error: "Not authenticated" });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type !== "admin")
      return res.status(403).json({ error: "Admin access required" });
    const admin = await Admin.findById(payload.id);
    if (!admin || !admin.isActive)
      return res.status(403).json({ error: "Admin not found or disabled" });
    req.admin = admin;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// Admin: flat list of every pre-ordered line item across all orders (dashboard)
router.get(
  "/admin/preorders",
  requireAdmin,
  requirePermission("catalog"),
  async (req, res) => {
    try {
      const orders = await Order.find(
        { "items.isPreorder": true },
        "orderNumber items billingDetails userEmail status paymentStatus createdAt",
      )
        .sort({ createdAt: -1 })
        .lean();

      const rows = [];
      orders.forEach((o) => {
        (o.items || []).forEach((item, idx) => {
          if (!item.isPreorder) return;
          rows.push({
            orderId: o._id,
            orderNumber: o.orderNumber || null,
            itemIndex: idx,
            productId: item.productId,
            productTitle: item.title,
            image: item.image,
            price: item.price,
            quantity: item.quantity,
            color: item.color,
            size: item.size,
            customerName: o.billingDetails?.name || null,
            customerPhone: o.billingDetails?.phone || null,
            customerEmail: o.userEmail || o.billingDetails?.email || null,
            status: o.status,
            paymentStatus: o.paymentStatus,
            createdAt: o.createdAt,
          });
        });
      });

      res.json({ ok: true, rows });
    } catch (err) {
      res.status(500).json({ error: "Server error" });
    }
  },
);

//view own orders
router.get("/my", async (req, res) => {
  try {
    const identity = await getRequesterIdentity(req);
    if (!identity) return res.status(401).json({ error: "Not authenticated" });

    const ownerFilters = [];
    if (identity.id) ownerFilters.push({ userId: identity.id });
    if (identity.email) {
      ownerFilters.push({ userEmail: identity.email });
      ownerFilters.push({ "billingDetails.email": identity.email });
    }

    if (!ownerFilters.length) return res.json({ orders: [] });

    // never surface trashed orders to the customer
    const orders = await Order.find({
      $or: ownerFilters,
      deletedAt: null,
    }).sort({
      createdAt: -1,
    });

    // Lazy sync courier tracking from live URLs (max 5 per request)
    const toSync = orders
      .filter(
        (o) =>
          (o.shipment?.trackingId || o.shipment?.trackingUrl) &&
          !["delivered", "cancelled", "failed"].includes(o.status),
      )
      .slice(0, 5);

    await Promise.all(
      toSync.map(async (o) => {
        try {
          const result = await syncOrderShipment(o);
          if (result.order) {
            const idx = orders.findIndex(
              (row) => String(row._id) === String(result.order._id),
            );
            if (idx >= 0) orders[idx] = result.order;
          }
        } catch (err) {}
      }),
    );

    res.json({
      orders: orders.map((o) => {
        const obj = o.toObject ? o.toObject() : o;
        return {
          ...obj,
          orderId: o.orderNumber || formatOrderIdSuffix(o._id),
        };
      }),
    });
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
});

// ── POST /api/orders/webhooks/steadfast — Steadfast tracking / delivery callbacks
router.post("/webhooks/steadfast", async (req, res) => {
  try {
    const bearer =
      process.env.STEADFAST_WEBHOOK_BEARER ||
      process.env.STEADFAST_BEARER_TOKEN;
    if (bearer) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${bearer}`) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const payload = req.body || {};
    const trackingCode =
      payload.tracking_code ||
      payload.trackingCode ||
      payload.tracking_id ||
      null;
    const consignmentId =
      payload.consignment_id || payload.consignmentId || null;
    const message =
      payload.tracking_message ||
      payload.status ||
      payload.message ||
      "Courier update";
    const atRaw = payload.updated_at || payload.updatedAt || new Date();

    const filters = [];
    if (trackingCode)
      filters.push({ "shipment.trackingId": String(trackingCode) });
    if (consignmentId)
      filters.push({ "shipment.trackingId": String(consignmentId) });

    if (!filters.length) {
      return res
        .status(400)
        .json({ error: "tracking_code or consignment_id required" });
    }

    const order = await Order.findOne({ $or: filters });
    if (!order) {
      return res
        .status(404)
        .json({ error: "Order not found for tracking reference." });
    }

    if (!order.shipment) order.shipment = { trackingEvents: [] };
    if (!order.shipment.courier) order.shipment.courier = "steadfast";

    const event = {
      status: payload.status_type || payload.notification_type || "update",
      message: String(message),
      at: new Date(atRaw),
      source: "courier",
    };

    const existing = order.shipment.trackingEvents || [];
    const dup = existing.some(
      (e) =>
        e.message === event.message &&
        Math.abs(new Date(e.at) - event.at) < 60000,
    );
    if (!dup) {
      order.shipment.trackingEvents = [...existing, event].sort(
        (a, b) => new Date(a.at) - new Date(b.at),
      );
    }

    order.shipment.courierStatus = String(message);
    order.shipment.lastSyncAt = new Date();

    // DISPLAY-ONLY: the webhook records the courier's raw status + tracking event
    // history, but must never change the business order status. Substring matching
    // on status_type (e.g. .includes("deliver")) wrongly matched phrases like
    // "At Delivery Hub" / "Out for Delivery" and flipped orders to "delivered".
    // Order status now changes only through a manual admin/moderator action
    // (PUT /api/admin/orders/:id/status), which records changedBy in the history.

    order.updatedAt = new Date();
    await order.save();

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Webhook processing failed." });
  }
});

// ── POST /api/orders/webhooks/pathao — Pathao parcel status callback
router.post("/webhooks/pathao", async (req, res) => {
  try {
    const secret = process.env.PATHAO_WEBHOOK_SECRET;
    if (secret) {
      const incoming =
        req.headers["x-pathao-signature"] || req.headers["x-webhook-secret"];
      if (incoming !== secret) {
        return res.status(401).json({ error: "Invalid webhook signature." });
      }
    }

    const payload = req.body || {};
    const consignmentId =
      payload.consignment_id ||
      payload.consignmentId ||
      payload.tracking_id ||
      payload.trackingId;
    const courierStatus =
      payload.order_status ||
      payload.order_status_slug ||
      payload.status ||
      null;

    if (!consignmentId) {
      return res.status(400).json({ error: "consignment_id is required." });
    }

    const order = await Order.findOne({
      "shipment.trackingId": String(consignmentId),
    });
    if (!order) {
      return res
        .status(404)
        .json({ error: "Order not found for consignment." });
    }

    await syncOrderShipment(order, { force: true });
    if (courierStatus) {
      order.shipment.courierStatus = String(courierStatus);
      await order.save();
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Webhook processing failed." });
  }
});

// ── GET /api/orders/track — public lookup by order ID or phone number
router.get("/track", async (req, res) => {
  try {
    const orderId = String(req.query.orderId || "")
      .trim()
      .replace(/^#/, "");
    const phone = String(req.query.phone || "").trim();
    const trackingId = String(req.query.trackingId || "").trim();
    const trackingUrl = String(req.query.trackingUrl || "").trim();

    if (!orderId && !phone && !trackingId && !trackingUrl) {
      return res.status(400).json({
        error: "Order ID or phone number is required.",
      });
    }

    // Phone-only lookup: return all orders for this phone
    if (phone && !orderId && !trackingId && !trackingUrl) {
      const orders = await findOrdersByPhone(phone);
      if (!orders.length) {
        return res.status(404).json({
          error: "No orders found for this phone number.",
          code: "order_not_found",
        });
      }
      const courierLabels = await getCourierLabelMap();
      return res.json({
        orders: orders.map(toPublicTrackOrder),
        courierLabels,
      });
    }

    let order = null;
    if (orderId) {
      order = await findOrderByIdOrSuffix(orderId);
    } else if (trackingId) {
      order = await findOrderByTrackingId(trackingId);
    } else if (trackingUrl) {
      order = await findOrderByTrackingUrl(trackingUrl);
    }

    if (!order) {
      return res.status(404).json({
        error: "Order not found.",
        code: "order_not_found",
      });
    }

    try {
      const syncResult = await syncOrderShipment(order, { force: false });
      if (syncResult.ok && syncResult.order) {
        order = syncResult.order;
      }
    } catch (syncErr) {}

    const courierLabels = await getCourierLabelMap();
    const publicOrder = toPublicTrackOrder(order);

    res.json({
      order: publicOrder,
      courierLabels,
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── GET /api/orders/:id ───────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    // Accept either the raw ObjectId or the human-friendly order number
    // (e.g. "apl0023"), so the public confirmation URL can use the clean id.
    const order = await findOrderByIdOrSuffix(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const identity = await getRequesterIdentity(req);
    const isAdmin = identity?.type === "admin";
    const isOwner = ownsOrder(order, identity);

    // trashed orders are hidden from everyone except admins
    if (order.deletedAt && !isAdmin) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (isAdmin || isOwner || hasOrderGrant(req, order)) {
      return res.json({ order });
    }

    // Unauthenticated callers get non-PII confirmation data only.
    // This keeps the checkout success page working for guest orders
    // without exposing name / phone / address to strangers.
    const publicOrder = {
      _id: order._id,
      orderNumber: order.orderNumber || null,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      total: order.total,
      subtotal: order.subtotal,
      shipping: order.shipping,
      discount: order.discount,
      couponCode: order.couponCode,
      items: (order.items || []).map((i) => ({
        title: i.title,
        quantity: i.quantity,
        price: i.price,
        image: i.image || null,
        color: i.color ?? null,
        size: i.size ?? null,
        attributes: i.attributes || undefined,
        attrGroup: i.attrGroup ?? null,
        attrValue: i.attrValue ?? null,
      })),
      confirmAfter: order.confirmAfter || null,
      createdAt: order.createdAt,
    };
    res.json({ order: publicOrder });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── PATCH /api/orders/:id/cancel ─────────────────────────────────────────────
// Cancel a COD order within 1 hour of creation. Requires a reason (min 5 chars).
router.patch("/:id/cancel", async (req, res) => {
  try {
    const order = await findOrderByIdOrSuffix(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Allow the logged-in owner OR the guest browser that placed this order
    // (grant cookie set at creation) to cancel within the window.
    const identity = await getRequesterIdentity(req);
    if (!ownsOrder(order, identity) && !hasOrderGrant(req, order))
      return res.status(403).json({ error: "Not your order" });

    if (order.paymentMethod !== "cash-on-delivery") {
      return res
        .status(400)
        .json({ error: "Only COD orders can be cancelled here." });
    }
    if (order.status !== "pending") {
      return res.status(400).json({
        error: `Order is already ${order.status} and cannot be cancelled.`,
      });
    }
    const editCancelDeadline = order.confirmAfter
      ? new Date(order.confirmAfter).getTime()
      : new Date(order.createdAt).getTime() + 60 * 60 * 1000;
    if (Date.now() > editCancelDeadline) {
      return res.status(400).json({
        error: "The 1-hour edit/cancel window has passed for this order.",
      });
    }

    const reason = (req.body?.reason || "").trim();
    if (reason.length < 5) {
      return res.status(400).json({
        error: "Please provide a cancellation reason (at least 5 characters).",
      });
    }

    applyOrderStatusChange(order, "cancelled", {
      reason,
      changedBy: "customer",
    });
    order.paymentStatus = "cancelled";
    order.updatedAt = new Date();
    await order.save();

    if (order.userId && order.rewardPointsRedeemed > 0) {
      await refundUserRewardPoints(order.userId, order.rewardPointsRedeemed);
    }

    sendOrderCancelledEmail(order, { reason, cancelledBy: "customer" }).catch(
      () => {},
    );

    res.json({ ok: true, order });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── PATCH /api/orders/:id/edit ────────────────────────────────────────────────
// Edit a pending COD order within the 1-hour edit/cancel window.
router.patch("/:id/edit", async (req, res) => {
  try {
    const order = await findOrderByIdOrSuffix(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Allow the logged-in owner OR the guest browser that placed this order
    // (grant cookie set at creation) to edit within the window.
    const identity = await getRequesterIdentity(req);
    if (!ownsOrder(order, identity) && !hasOrderGrant(req, order))
      return res.status(403).json({ error: "Not your order" });

    if (order.status !== "pending") {
      return res.status(400).json({
        error: `Order is already ${order.status} and cannot be edited.`,
      });
    }
    const editCancelDeadline = order.confirmAfter
      ? new Date(order.confirmAfter).getTime()
      : new Date(order.createdAt).getTime() + 60 * 60 * 1000;
    if (Date.now() > editCancelDeadline) {
      return res.status(400).json({
        error: "The 1-hour edit/cancel window has passed for this order.",
      });
    }

    const { note, address, phone, billingDetails, items, addItems } =
      req.body || {};
    const billingPatch =
      billingDetails && typeof billingDetails === "object"
        ? billingDetails
        : {};
    const billingUpdates = {
      ...(typeof note !== "undefined" ? { note } : {}),
      ...(typeof address !== "undefined" ? { address } : {}),
      ...(typeof phone !== "undefined" ? { phone } : {}),
      ...billingPatch,
    };

    const prevCity = order.billingDetails.city;
    const prevZone = order.billingDetails.zone;
    const prevArea = order.billingDetails.area;

    Object.entries(billingUpdates).forEach(([key, value]) => {
      if (typeof value !== "undefined") {
        order.billingDetails[key] = value;
      }
    });

    // If the delivery address (city/zone/area) changed, recompute the shipping
    // charge from the new location. Only recompute for orders that were already
    // paying delivery (shipping > 0) so a free-shipping order (product/coupon)
    // keeps its 0 charge.
    let shippingChanged = false;
    const addressChanged =
      order.billingDetails.city !== prevCity ||
      order.billingDetails.zone !== prevZone ||
      order.billingDetails.area !== prevArea;
    if (addressChanged && (order.shipping || 0) > 0) {
      const newShipping = await calcBaseShipping(
        order.billingDetails.city,
        order.billingDetails.zone,
        order.billingDetails.area,
      );
      if (newShipping !== order.shipping) {
        order.shipping = newShipping;
        shippingChanged = true;
      }
    }

    // Update item quantities if provided
    if (Array.isArray(items) && items.length > 0) {
      for (const itemUpdate of items) {
        const explicitIndex = Number.isInteger(itemUpdate?.index)
          ? itemUpdate.index
          : -1;
        const productId = itemUpdate?.productId;
        const idx =
          explicitIndex >= 0 && explicitIndex < order.items.length
            ? explicitIndex
            : order.items.findIndex(
                (it) => it.productId?.toString() === productId?.toString(),
              );

        if (idx === -1) continue;

        const currentItem = order.items[idx];
        const nextColor =
          typeof itemUpdate.color !== "undefined"
            ? itemUpdate.color
            : currentItem.color;
        const nextSize =
          typeof itemUpdate.size !== "undefined"
            ? itemUpdate.size
            : currentItem.size;
        const nextAttrs =
          typeof itemUpdate.attributes !== "undefined"
            ? cleanAttributes(itemUpdate.attributes)
            : cleanAttributes(currentItem.attributes);
        const nextQuantity = Number(itemUpdate.quantity);

        if (Number.isFinite(nextQuantity) && nextQuantity >= 1) {
          currentItem.quantity = nextQuantity;
        }

        if (typeof itemUpdate.color !== "undefined") {
          currentItem.color = itemUpdate.color || null;
        }
        if (typeof itemUpdate.size !== "undefined") {
          currentItem.size = itemUpdate.size || null;
        }
        if (typeof itemUpdate.attributes !== "undefined") {
          currentItem.attributes = Object.keys(nextAttrs).length
            ? nextAttrs
            : undefined;
        }

        if (productId) {
          const product = await Product.findById(productId).lean();
          if (product) {
            const resolvedPrice = priceForSelection(
              product,
              nextColor,
              nextSize,
              nextAttrs,
            );
            if (resolvedPrice != null) {
              currentItem.price = resolvedPrice;
            }
          }
        }
      }
    }

    // Add new products to the order
    if (Array.isArray(addItems) && addItems.length > 0) {
      for (const ni of addItems) {
        if (!ni.productId) continue;
        const prod = await Product.findById(ni.productId).lean();
        if (!prod) continue;
        const qty = Math.max(1, parseInt(ni.quantity) || 1);
        const niAttrs = cleanAttributes(ni.attributes);
        const price =
          priceForSelection(prod, ni.color, ni.size, niAttrs) ??
          prod.price ??
          0;
        order.items.push({
          productId: prod._id,
          title: prod.title,
          price,
          quantity: qty,
          image: prod.images?.[0]?.url || null,
          color: ni.color || null,
          size: ni.size || null,
          attrGroup: ni.attrGroup || null,
          attrValue: ni.attrValue || null,
          attributes: Object.keys(niAttrs).length ? niAttrs : undefined,
          rewardPoints: Math.max(0, Number(prod.rewardPoints) || 0),
        });
      }
    }

    // Recalculate totals whenever items changed or the shipping charge changed
    const itemsChanged =
      (Array.isArray(items) && items.length > 0) ||
      (Array.isArray(addItems) && addItems.length > 0);
    if (itemsChanged || shippingChanged) {
      const newSubtotal = order.items.reduce(
        (sum, it) => sum + (it.price || 0) * it.quantity,
        0,
      );
      order.subtotal = newSubtotal;
      order.total = newSubtotal + (order.shipping || 0) - (order.discount || 0);
    }

    order.markModified("items");
    order.markModified("billingDetails");
    order.updatedAt = new Date();
    await order.save();

    res.json({ ok: true, order });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── Switch mobile-banking order to Cash on Delivery ──────────────────────────
// Called when customer cancels on the payment page and chooses COD instead
router.patch("/:id/switch-to-cod", async (req, res) => {
  try {
    const identity = await getRequesterIdentity(req);
    if (!identity) return res.status(401).json({ error: "Not authenticated." });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });

    if (!ownsOrder(order, identity) && identity.type !== "admin") {
      return res.status(403).json({ error: "Not your order." });
    }
    if (!["bkash", "nagad", "rocket"].includes(order.paymentMethod)) {
      return res
        .status(400)
        .json({ error: "Order is not a mobile-banking order." });
    }
    if (order.status !== "pending") {
      return res
        .status(400)
        .json({ error: "Only pending orders can be switched." });
    }
    order.paymentMethod = "cash-on-delivery";
    order.paymentStatus = "cod";
    order.paymentNote = "Switched to COD by customer on payment page.";
    await order.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// ── Submit mobile-banking transaction ID ──────────────────────────────────────
// Called from /checkout/payment page after customer sends money
router.patch("/:id/mobile-payment", async (req, res) => {
  try {
    const identity = await getRequesterIdentity(req);
    if (!identity) return res.status(401).json({ error: "Not authenticated." });

    const { senderNumber, transactionId } = req.body || {};
    if (!transactionId?.trim()) {
      return res.status(400).json({ error: "Transaction ID is required." });
    }
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });

    if (!ownsOrder(order, identity) && identity.type !== "admin") {
      return res.status(403).json({ error: "Not your order." });
    }
    if (!["bkash", "nagad", "rocket"].includes(order.paymentMethod)) {
      return res.status(400).json({ error: "Not a mobile-banking order." });
    }
    order.paymentNote = `TxID: ${transactionId.trim()}${senderNumber ? ` | Sender: ${senderNumber.trim()}` : ""}`;
    order.paymentStatus = "pending_verification";
    await order.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

export default router;

// Exposed so the admin dashboard can create orders manually (phone orders,
// abandoned-cart/checkout conversion) with the exact same server-authoritative
// pricing the storefront uses. Keep this the single source of truth for pricing.
export { resolveAndQuote };
