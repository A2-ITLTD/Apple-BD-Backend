import ActivityLog from "../models/ActivityLog.js";
import { isHiddenAdmin } from "./attribution.js";

// Fire-and-forget audit logger. NEVER throws — a logging failure must not break
// the product action that triggered it. Records who did what and when.
export async function logActivity({
  entityType = "product",
  entityId,
  entityTitle,
  action,
  admin,
  meta,
} = {}) {
  try {
    if (!entityId || !action) return;
    // Hidden super-admin leaves no audit trail.
    if (isHiddenAdmin(admin)) return;
    await ActivityLog.create({
      entityType,
      entityId,
      entityTitle,
      action,
      actor: admin?._id,
      actorName:
        admin?.name || admin?.email?.split("@")[0] || "Unknown admin",
      actorEmail: admin?.email,
      meta,
    });
  } catch (err) {
    console.error("logActivity error:", err.message);
  }
}

// Log the same action for many products at once (bulk trash/restore/delete).
export async function logActivityBulk({
  entityType = "product",
  items = [], // [{ entityId, entityTitle }]
  action,
  admin,
  meta,
} = {}) {
  try {
    if (!action || !items.length) return;
    // Hidden super-admin leaves no audit trail.
    if (isHiddenAdmin(admin)) return;
    const now = new Date();
    await ActivityLog.insertMany(
      items.map((it) => ({
        entityType,
        entityId: it.entityId,
        entityTitle: it.entityTitle,
        action,
        actor: admin?._id,
        actorName:
          admin?.name || admin?.email?.split("@")[0] || "Unknown admin",
        actorEmail: admin?.email,
        meta,
        createdAt: now,
      })),
    );
  } catch (err) {
    console.error("logActivityBulk error:", err.message);
  }
}
