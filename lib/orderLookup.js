import mongoose from 'mongoose';
import Order from '../models/Order.js';
import { extractTrackingIdFromUrl } from './couriers/trackingUtils.js';

export function formatOrderIdSuffix(id) {
  return String(id || '').slice(-8).toUpperCase();
}

export function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/**
 * Build MongoDB $or conditions that match an order by its ID from a search box.
 * Admins see the short 8-char suffix (see formatOrderIdSuffix / formatOrderId),
 * so a full 24-char ObjectId, the 8-char suffix, or any hex fragment of it must
 * all resolve. Returns [] when the query isn't ID-shaped, so callers can spread
 * it alongside their name/phone conditions.
 */
export function orderIdMatchConditions(rawQ) {
  const clean = String(rawQ || '').trim().replace(/^#/, '');
  if (!clean) return [];
  // Human-friendly order number, e.g. "apl1001".
  if (/^apl\d+$/i.test(clean)) {
    const digits = clean.replace(/\D/g, '');
    return [{ orderNumber: `apl${digits}` }];
  }
  if (/^[a-f\d]{24}$/i.test(clean)) return [{ _id: clean }];

  const conditions = [];
  // Bare digits could be an order number ("1001") or a numeric hash fragment.
  if (/^\d+$/.test(clean)) conditions.push({ orderNumber: `apl${clean}` });
  if (/^[a-f\d]{1,8}$/i.test(clean)) {
    const esc = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    conditions.push({
      $expr: {
        $regexMatch: {
          input: { $toString: '$_id' },
          regex: esc,
          options: 'i',
        },
      },
    });
  }
  return conditions;
}

function isFullObjectId(value) {
  return /^[a-f\d]{24}$/i.test(String(value || '').trim());
}

export async function findOrderByIdOrSuffix(rawId) {
  const clean = String(rawId || '').trim().replace(/^#/, '');
  if (!clean) return null;

  if (isFullObjectId(clean)) {
    return Order.findById(clean);
  }

  // Human-friendly order number, e.g. "apl1001" (or the bare digits).
  if (/^apl\d+$/i.test(clean) || /^\d+$/.test(clean)) {
    const digits = clean.replace(/\D/g, '');
    const byNumber = await Order.findOne({ orderNumber: `apl${digits}` });
    if (byNumber) return byNumber;
    if (/^apl\d+$/i.test(clean)) return null;
  }

  const suffix = clean.toUpperCase().slice(-8);
  const matches = await Order.aggregate([
    {
      $addFields: {
        idSuffix: {
          $toUpper: { $substr: [{ $toString: '$_id' }, 16, 8] },
        },
      },
    },
    { $match: { idSuffix: suffix } },
    { $sort: { createdAt: -1 } },
    { $limit: 1 },
  ]);

  if (!matches.length) return null;
  return Order.findById(matches[0]._id);
}

export async function findOrderByTrackingId(rawTrackingId) {
  const clean = String(rawTrackingId || '').trim();
  if (!clean) return null;

  const order = await Order.findOne({ 'shipment.trackingId': clean }).sort({
    createdAt: -1,
  });
  if (order) return order;

  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Order.findOne({
    'shipment.trackingId': { $regex: new RegExp(`${escaped}$`, 'i') },
  }).sort({ createdAt: -1 });
}

export async function findOrderByTrackingUrl(rawUrl) {
  const clean = String(rawUrl || '').trim();
  if (!clean) return null;

  const exact = await Order.findOne({ 'shipment.trackingUrl': clean }).sort({
    createdAt: -1,
  });
  if (exact) return exact;

  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const partial = await Order.findOne({
    'shipment.trackingUrl': { $regex: escaped, $options: 'i' },
  }).sort({ createdAt: -1 });
  if (partial) return partial;

  const extracted = extractTrackingIdFromUrl(null, clean);
  if (extracted) {
    return findOrderByTrackingId(extracted);
  }

  return null;
}

export async function findOrdersByPhone(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return [];

  const tail = digits.length >= 10 ? digits.slice(-10) : digits;
  const pattern = new RegExp(`${tail}$`);

  return Order.find({ 'billingDetails.phone': pattern })
    .sort({ createdAt: -1 })
    .limit(50);
}

export function phoneMatchesOrder(order, phone) {
  const orderPhone = normalizePhone(order?.billingDetails?.phone);
  const queryPhone = normalizePhone(phone);
  if (!orderPhone || !queryPhone) return false;
  return (
    orderPhone === queryPhone ||
    orderPhone.endsWith(queryPhone) ||
    queryPhone.endsWith(orderPhone)
  );
}

export function toPublicTrackOrder(order) {
  return {
    _id: order._id,
    orderNumber: order.orderNumber || null,
    orderId: order.orderNumber || formatOrderIdSuffix(order._id),
    status: order.status,
    paymentStatus: order.paymentStatus,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items: order.items,
    total: order.total,
    billingDetails: {
      name: order.billingDetails?.name,
      phone: order.billingDetails?.phone,
      city: order.billingDetails?.city,
    },
    shipment: order.shipment,
    assignedAgent: order.assignedAgent || null,
    // Public status timeline — safe fields only (no internal reason/changedBy)
    statusHistory: Array.isArray(order.statusHistory)
      ? order.statusHistory.map((h) => ({
          previousStatus: h.previousStatus || null,
          newStatus: h.newStatus,
          at: h.at,
        }))
      : [],
  };
}
