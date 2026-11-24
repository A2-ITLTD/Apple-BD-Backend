// Exact-match translation of courier status phrases into internal order statuses.
// Never use substring matching here: phrases like "At Delivery Hub" or
// "Out for Delivery" must not be mistaken for an actual "Delivered" status.

const STATUS_MAP = new Map([
  ["pending", "pending"],
  ["created", "pending"],
  ["order created", "pending"],
  ["in review", "pending"],
  ["pickup requested", "accepted"],
  ["assigned for pickup", "accepted"],
  ["accepted", "accepted"],
  ["approved", "approved"],
  ["confirmed", "confirmed"],
  ["order confirmed", "confirmed"],
  ["picked", "picked"],
  ["picked up", "picked"],
  ["processing", "processing"],
  ["shipped", "shipped"],
  ["at the sorting hub", "shipped"],
  ["at sorting hub", "shipped"],
  ["in transit", "shipped"],
  ["dispatched from hub", "shipped"],
  ["received at last mile hub", "shipped"],
  ["ready for delivery", "shipped"],
  ["assigned for delivery", "shipped"],
  ["out for delivery", "shipped"],
  ["delivered", "delivered"],
  ["failed", "failed"],
  ["delivery failed", "failed"],
  ["returned", "returned"],
  ["return", "returned"],
  ["returned to merchant", "returned"],
  ["return in transit", "returned"],
  ["cancelled", "cancelled"],
  ["canceled", "cancelled"],
]);

const STATUS_RANK = {
  pending: 0,
  accepted: 1,
  picked: 2,
  approved: 2,
  confirmed: 2,
  processing: 3,
  shipped: 4,
  delivered: 5,
  returned: 5,
  cancelled: 5,
  failed: 5,
  rejected: 5,
};

const TERMINAL_STATUSES = new Set([
  "delivered",
  "returned",
  "cancelled",
  "failed",
  "rejected",
]);

export function normalizeCourierStatus(value) {
  if (value == null) return null;
  const key = String(value)
    .trim()
    .toLowerCase()
    .replace(/^order[.\s_-]+/, "")
    .replace(/[_/]+/g, " ")
    .replace(/-+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return key || null;
}

export function mapCourierStatusToOrderStatus(value) {
  const key = normalizeCourierStatus(value);
  return key ? STATUS_MAP.get(key) || null : null;
}

export function shouldApplyCourierStatus(currentStatus, nextStatus) {
  if (!nextStatus || currentStatus === nextStatus) return false;
  if (TERMINAL_STATUSES.has(currentStatus)) return false;
  return (STATUS_RANK[nextStatus] ?? 0) > (STATUS_RANK[currentStatus] ?? 0);
}

export async function applyCourierStatusToOrder(
  order,
  rawStatus,
  courier = "courier",
) {
  const nextStatus = mapCourierStatusToOrderStatus(rawStatus);
  if (!shouldApplyCourierStatus(order?.status, nextStatus)) return false;

  const previousCourierStatus = order.shipment?.courierStatus;
  const { applyOrderStatusChange } = await import("./orderStatus.js");
  const changed = applyOrderStatusChange(order, nextStatus, {
    reason: `Courier update: ${String(rawStatus).trim()}`,
    changedBy: `courier:${courier}`,
  });

  if (changed && order.shipment && previousCourierStatus !== undefined) {
    order.shipment.courierStatus = previousCourierStatus;
  }
  return changed;
}
