// Attribution helpers for the hidden super-admin (owner/root) account.
//
// A superAdmin (see models/Admin.js) must leave no staff-visible trace: its
// product edits produce no activity-log entry, and its order edits/picks are
// recorded under a neutral label instead of its name/email. Centralising the
// checks here keeps every audit surface consistent.

// True when this actor is the hidden owner account whose actions must not be
// attributed anywhere staff can see.
export function isHiddenAdmin(admin) {
  return !!admin?.superAdmin;
}

// Label to store as the actor of an order status change / pick. The super admin
// blends into the generic "admin" fallback that the system already uses when no
// name/email is available, so nothing singles it out.
export function actorLabel(admin, fallback = "admin") {
  if (!admin || isHiddenAdmin(admin)) return fallback;
  return admin.name || admin.email || fallback;
}
