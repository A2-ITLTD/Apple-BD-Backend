/**
 * seedAdmin.js
 * Creates (or updates) an admin account. Self-registration is disabled in
 * routes/admin.js, so the first admin must be seeded with this script.
 *
 * Usage:
 *   node seedAdmin.js <email> <password> [name]
 *   node seedAdmin.js admin@example.com StrongPass123 "Super Admin"
 *
 * Add --super to create (or promote to) a HIDDEN owner/root account:
 *   node seedAdmin.js owner@example.com StrongPass123 "Owner" --super
 * A superAdmin has full access but never appears in the Authorized-admins
 * list and leaves no staff-visible audit trail (product activity log, order
 * status history / "edited by", order pick). See models/Admin.js.
 *
 * If an admin with the same email already exists, its password/name are
 * updated (handy for password resets) — nothing else is touched (except the
 * superAdmin flag is set when --super is passed).
 */

import mongoose from "mongoose";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
dotenv.config();

const SALT_ROUNDS = 12; // keep in sync with routes/admin.js

async function main() {
  const args = process.argv.slice(2);
  const isSuper = args.includes("--super");
  const [email, password, name] = args.filter((a) => a !== "--super");

  if (!email || !password) {
    console.log(
      "Usage: node seedAdmin.js <email> <password> [name] [--super]",
    );
    process.exit(1);
  }
  if (password.length < 6) {
    console.log("Password must be at least 6 characters.");
    process.exit(1);
  }

  const URI =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    "mongodb://localhost:27017/AppleBD";
  await mongoose.connect(URI);
  console.log("Connected to MongoDB");

  const Admin = (await import("./models/Admin.js")).default;

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
  const normalizedEmail = email.toLowerCase().trim();

  const existing = await Admin.findOne({ email: normalizedEmail });
  if (existing) {
    existing.hashedPassword = hashedPassword;
    if (name) existing.name = name;
    existing.isActive = true;
    existing.isLocked = false;
    existing.lockUntil = undefined;
    existing.loginAttempts = 0;
    if (isSuper) {
      existing.role = "admin";
      existing.permissions = [];
      existing.superAdmin = true;
    }
    await existing.save();
    console.log(
      `Updated existing admin: ${existing.email} (${existing.role})` +
        (existing.superAdmin ? " [hidden super admin]" : ""),
    );
  } else {
    const admin = await Admin.create({
      name: name || "Admin",
      email: normalizedEmail,
      hashedPassword,
      role: "admin",
      isActive: true,
      permissions: [], // empty = unrestricted / full access
      superAdmin: isSuper,
    });
    console.log(
      `Created new admin: ${admin.email}` +
        (admin.superAdmin ? " [hidden super admin]" : ""),
    );
  }

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
