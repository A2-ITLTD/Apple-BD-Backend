import mongoose from "mongoose";

// Audit trail for admin actions on catalog entities (currently products).
// Each entry is an immutable snapshot: it stores the actor's name/email at the
// time of the action so the history stays readable even if the admin account
// is later renamed or removed.
const ActivityLogSchema = new mongoose.Schema(
  {
    entityType: { type: String, default: "product" },
    entityId: { type: mongoose.Schema.Types.ObjectId },
    entityTitle: { type: String }, // snapshot of the product title

    action: {
      type: String,
      enum: [
        "create",
        "update",
        "trash",
        "restore",
        "permanent-delete",
        "duplicate",
      ],
      required: true,
    },

    actor: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    actorName: { type: String }, // snapshot — survives admin rename/delete
    actorEmail: { type: String },

    // free-form extras, e.g. { fields: [...] } for updates or { sourceId }
    meta: { type: Object },

    createdAt: { type: Date, default: Date.now },
  },
  { minimize: false },
);

// history lookup for a single product, newest first
ActivityLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

export default mongoose.models.ActivityLog ||
  mongoose.model("ActivityLog", ActivityLogSchema);
