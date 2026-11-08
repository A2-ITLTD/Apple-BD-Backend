import "dotenv/config";
import { readFile } from "node:fs/promises";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { v2 as cloudinary } from "cloudinary";
import Product from "../models/Product.js";
import User from "../models/User.js";

const primaryKey = process.env.MONGODB_URI
  ? "MONGODB_URI"
  : process.env.MONGO_URI
    ? "MONGO_URI"
    : null;
const primaryUri = primaryKey ? process.env[primaryKey] : null;
const directUri = process.env.MONGODB_URI_DIRECT;

function safeTarget(uri) {
  try {
    const parsed = new URL(uri);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname || "/"}`;
  } catch {
    return "URI is configured but its target could not be parsed";
  }
}

async function configuredSource(variableName) {
  try {
    const fileValues = dotenv.parse(await readFile(".env"));
    return fileValues[variableName] === process.env[variableName]
      ? "backend .env file"
      : "process environment (overrides backend .env)";
  } catch {
    return "process environment (no readable backend .env found)";
  }
}

async function printMongoUriAssignments() {
  try {
    const lines = (await readFile(".env", "utf8")).split(/\r?\n/);
    const assignments = [];
    lines.forEach((line, index) => {
      const match = line.match(/^\s*(MONGODB_URI(?:_DIRECT)?|MONGO_URI)\s*=/);
      if (!match) return;
      const value = dotenv.parse(line)[match[1]];
      assignments.push(
        `  .env:${index + 1} ${match[1]} -> ${safeTarget(value)}`,
      );
    });
    console.log("MongoDB URI settings found in this backend .env:");
    console.log(assignments.length ? assignments.join("\n") : "  (none)");
  } catch {
    // The main diagnostic reports a missing URI if no usable setting exists.
  }
}

if (!primaryUri) {
  console.error("Missing MONGODB_URI (or MONGO_URI) in the backend environment.");
  process.exit(1);
}

async function connect() {
  try {
    await mongoose.connect(primaryUri);
    return primaryKey;
  } catch (error) {
    const isSrvLookupFailure =
      error?.syscall === "querySrv" || error?.code === "ECONNREFUSED";
    if (!isSrvLookupFailure || !directUri) throw error;
    console.warn("SRV connection failed; trying MONGODB_URI_DIRECT fallback.");
    await mongoose.connect(directUri);
    return "MONGODB_URI_DIRECT (fallback)";
  }
}

try {
  await printMongoUriAssignments();
  const connectedUsing = await connect();

  const connection = mongoose.connection;
  const hosts = Array.from(
    connection.client?.topology?.description?.servers?.keys?.() || [],
  );
  const [allRecords, activeProducts, published, drafts, archived, userRecords] =
    await Promise.all([
      Product.countDocuments({}),
      Product.countDocuments({ deletedAt: null }),
      Product.countDocuments({ deletedAt: null, status: "published" }),
      Product.countDocuments({ deletedAt: null, status: "draft" }),
      Product.countDocuments({ deletedAt: null, status: "archived" }),
      User.countDocuments({}),
    ]);

  console.log("MongoDB connection diagnostic");
  console.log(`Status: ${connection.readyState === 1 ? "connected" : "not connected"}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development/local"}`);
  console.log(`Configured URI variable used: ${connectedUsing}`);
  if (connectedUsing === "MONGODB_URI" || connectedUsing === "MONGO_URI") {
    console.log(`URI value source: ${await configuredSource(connectedUsing)}`);
  }
  console.log(`Configured URI target: ${safeTarget(connectedUsing.includes("DIRECT") ? directUri : primaryUri)}`);
  if (process.env.MONGO_URI) {
    console.log(`MONGO_URI is also set to: ${safeTarget(process.env.MONGO_URI)}${primaryKey === "MONGODB_URI" ? " (not selected; MONGODB_URI takes precedence)" : ""}`);
  }
  if (process.env.MONGODB_URI_DIRECT) {
    console.log(`MONGODB_URI_DIRECT target (fallback only): ${safeTarget(directUri)}`);
  }
  const missingCloudinary = [
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
  ].filter((name) => !process.env[name]);
  console.log(
    `Cloudinary config: ${missingCloudinary.length ? `missing ${missingCloudinary.join(", ")}` : "all required credentials are set"}`,
  );
  if (!missingCloudinary.length) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    try {
      await cloudinary.api.ping();
      console.log("Cloudinary authentication: successful");
    } catch {
      console.log("Cloudinary authentication: failed (check backend credentials/network)");
    }
  }
  console.log(`Database: ${connection.name || connection.db.databaseName}`);
  console.log("Host(s):");
  for (const host of hosts.length ? hosts : [connection.host].filter(Boolean)) {
    console.log(`  - ${host}`);
  }
  if (!hosts.length && !connection.host) {
    console.log("  (MongoDB driver did not report host details)");
  }
  console.log(`Product records (including soft-deleted): ${allRecords}`);
  console.log(`Active products (not in trash): ${activeProducts}`);
  console.log(`  Published: ${published}`);
  console.log(`  Drafts: ${drafts}`);
  console.log(`  Archived: ${archived}`);
  console.log(`User records: ${userRecords}`);
  console.log("Connection string/credentials were not displayed.");
} catch (error) {
  console.error("Database diagnostic failed:", error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
