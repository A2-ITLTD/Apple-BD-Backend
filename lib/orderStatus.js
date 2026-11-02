import { appendManualTrackingEvent } from './shipmentTracking.js';
import { isHiddenAdmin } from './attribution.js';

export function appendStatusHistory(order, { previousStatus, newStatus, reason = '', changedBy = 'system' }) {
  if (!order.statusHistory) order.statusHistory = [];
  order.statusHistory.push({
    previousStatus: previousStatus ?? null,
    newStatus,
    reason: String(reason || '').trim(),
    changedBy,
    at: new Date(),
  });
}

// Record which admin/moderator edited an order. Appends { name, at } to the
// order's editedBy trail (most recent last) and caps its length so it can't grow
// without bound. The dashboard renders the latest few names as "by <name>".
export function recordOrderEditor(order, admin) {
  // Hidden super-admin (owner/root) leaves no "edited by" trail on the order.
  if (isHiddenAdmin(admin)) return;
  const name = admin?.name || admin?.email || 'admin';
  if (!order.editedBy) order.editedBy = [];
  order.editedBy.push({ name, at: new Date() });
  if (order.editedBy.length > 20) {
    order.editedBy = order.editedBy.slice(-20);
  }
}

export function applyOrderStatusChange(order, newStatus, { reason = '', changedBy = 'system' } = {}) {
  const previousStatus = order.status;
  if (previousStatus === newStatus) return false;

  order.status = newStatus;
  appendStatusHistory(order, { previousStatus, newStatus, reason, changedBy });

  if (newStatus === 'delivered') {
    if (!order.shipment) order.shipment = { trackingEvents: [] };
    order.shipment.deliveredAt = new Date();
    appendManualTrackingEvent(order, {
      status: 'delivered',
      message: reason || 'Delivered',
    });
  }

  order.updatedAt = new Date();
  return true;
}
