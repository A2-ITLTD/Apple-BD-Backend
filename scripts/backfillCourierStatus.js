import "dotenv/config";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import { mapCourierStatusToOrderStatus, shouldApplyCourierStatus } from "../lib/courierStatusMap.js";
import { applyOrderStatusChange } from "../lib/orderStatus.js";

const uri = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://localhost:27017/AppleBD";
const directUri = process.env.MONGODB_URI_DIRECT;

async function connect() {
  try {
    await mongoose.connect(uri);
  } catch (err) {
    const srvFailure = err?.syscall === "querySrv" || err?.code === "ECONNREFUSED";
    if (srvFailure && directUri) {
      await mongoose.connect(directUri);
      return;
    }
    throw err;
  }
}

const dryRun = process.argv.includes("--dry-run");

async function main() {
  await connect();

  const cursor = Order.find({
    deletedAt: null,
    status: { $nin: ["delivered", "returned", "cancelled", "failed", "rejected"] },
    "shipment.courierStatus": { $exists: true, $nin: [null, ""] },
  }).cursor();

  let scanned = 0;
  let updated = 0;
  const byStatus = {};

  for await (const order of cursor) {
    scanned += 1;
    const raw = order.shipment?.courierStatus;
    const next = mapCourierStatusToOrderStatus(raw);
    if (!shouldApplyCourierStatus(order.status, next)) continue;

    const previousCourierStatus = raw;
    const changed = applyOrderStatusChange(order, next, {
      reason: `Courier backfill: ${String(raw).trim()}`,
      changedBy: "courier:backfill",
    });
    if (!changed) continue;

    if (order.shipment) order.shipment.courierStatus = previousCourierStatus;
    if (!dryRun) await order.save();
    updated += 1;
    byStatus[next] = (byStatus[next] || 0) + 1;
  }

  console.log(`Scanned ${scanned} orders with courier status.`);
  console.log(`${dryRun ? "Would update" : "Updated"} ${updated} orders:`, byStatus);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
