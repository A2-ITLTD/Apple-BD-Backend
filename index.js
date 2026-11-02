// dotenv/config MUST be the very first import.
// With ESM all static imports are hoisted before any code runs, so
// 'import dotenv; dotenv.config()' fires AFTER other modules are already
// evaluated. Importing the side-effect entry point directly fixes this.
import "dotenv/config";

// Validate required environment variables at startup — fail fast rather than
// silently running with unsafe defaults.
const REQUIRED_ENV = [
  "JWT_SECRET",
  "MONGODB_URI",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "STORE_ID",
  "STORE_PASSWORD",
];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(
    `FATAL: Missing required environment variables: ${missingEnv.join(", ")}`,
  );
  process.exit(1);
}

import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import SSLCommerzPayment from "sslcommerz-lts";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";

import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import productRoutes from "./routes/products.js";
import blogRoutes from "./routes/blog.js";
import userRoutes from "./routes/user.js";
import orderRoutes from "./routes/orders.js";
import couponRoutes from "./routes/coupons.js";
import checkoutSessionsRouter from "./routes/checkoutSessions.js";
import analyticsRoutes from "./routes/analytics.js";
import brandRoutes from "./routes/brands.js";
import contactRoutes from "./routes/contact.js";
import newsletterRoutes from "./routes/newsletter.js";
import cartRoutes from "./routes/cart.js";
import cronRoutes from "./routes/cron.js";
import { syncActiveShipments } from "./lib/shipmentTracking.js";
import { seedDefaultsIfEmpty } from "./lib/courierDefaults.js";
import { generalLimiter } from "./lib/rateLimiters.js";
import { UPLOADS_ROOT } from "./lib/assetStore.js";
import logger from "./lib/logger.js";
import { sendAbandonedCartEmail } from "./lib/mailer.js";
import { redisClient } from "./lib/redis.js";

const app = express();

// Vercel (and Render/Railway) sit behind exactly one reverse-proxy hop that
// sets X-Forwarded-For — trust it so req.ip and express-rate-limit resolve
// the real client IP instead of the proxy's.
app.set("trust proxy", 1);

// Allowed origins: explicit whitelist only — never reflect unknown origins.
// Add all production domains + Vercel preview pattern to ALLOWED_ORIGINS env var.
const ALLOWED_ORIGINS = new Set(
  (
    process.env.ALLOWED_ORIGINS ||
    "https://applebd.com,https://www.applebd.com,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173"
  )
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
);
// Optional: allow Vercel preview URLs matching a pattern, e.g. ^https://AppleBDfrontend-[a-z0-9-]+\.vercel\.app$
const VERCEL_PATTERN = process.env.VERCEL_PROJECT_PATTERN
  ? new RegExp(process.env.VERCEL_PROJECT_PATTERN)
  : null;

const store_id = process.env.STORE_ID;
const store_passwd = process.env.STORE_PASSWORD;
const is_live = process.env.IS_LIVE === "true";

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isAllowed =
    origin &&
    (ALLOWED_ORIGINS.has(origin) ||
      (VERCEL_PATTERN && VERCEL_PATTERN.test(origin)));
  if (isAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(compression());
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false,
  }),
);
// Serve locally-uploaded media. Files are written under public/uploads with
// unique (uuid) names, so they're safe to cache aggressively and never change.
// Mounted before the rate limiter so image requests are never throttled.
app.use(
  "/uploads",
  express.static(UPLOADS_ROOT, {
    maxAge: "365d",
    immutable: true,
    index: false,
  }),
);

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
// Image bytes arrive as multipart/form-data (handled by multer per-route), not
// JSON — but product/blog docs with rich HTML + many image URLs can grow past a
// couple MB, so keep the JSON limit generous so saves never 413 "entity too
// large". File uploads are capped at 10MB (client-side + multer, see
// lib/uploadImage.js and the /upload routes).
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  if (req.path.startsWith("/api/admin")) return next();
  return generalLimiter(req, res, next);
});

const PORT = process.env.PORT || 5000;

// Connect to MongoDB (with fallback if SRV DNS lookup fails)
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const MONGODB_URI_DIRECT = process.env.MONGODB_URI_DIRECT;

async function connectMongo() {
  try {
    await mongoose.connect(MONGODB_URI);
    logger.info("MongoDB connected");
    await seedDefaultsIfEmpty();
  } catch (err) {
    const isSrvLookupFailure =
      err?.syscall === "querySrv" || err?.code === "ECONNREFUSED";
    if (isSrvLookupFailure && MONGODB_URI_DIRECT) {
      logger.warn(
        "MongoDB SRV lookup failed; trying MONGODB_URI_DIRECT fallback...",
      );
      await mongoose.connect(MONGODB_URI_DIRECT);
      logger.info("MongoDB connected (direct URI fallback)");
      await seedDefaultsIfEmpty();
      return;
    }
    logger.error({ err }, "MongoDB connection error");
    throw err; // re-throw so .then(startBackgroundJobs) is skipped on failure
  }
}

function startBackgroundJobs() {
  // Flash sale auto-expiry: clear flashSale flag on products past their end time
  setInterval(
    async () => {
      try {
        const { default: Product } = await import("./models/Product.js");
        const result = await Product.updateMany(
          { flashSale: true, flashSaleEndsAt: { $lt: new Date() } },
          { $set: { flashSale: false } },
        );
        if (result.modifiedCount > 0) {
          logger.info(
            `Flash sale expiry: cleared ${result.modifiedCount} product(s)`,
          );
        }
      } catch (err) {
        logger.warn({ err }, "Flash sale expiry job failed");
      }
    },
    5 * 60 * 1000,
  );

  // Abandoned cart email: runs every 15 minutes
  const abandonedCartIntervalMs = 15 * 60 * 1000;
  setInterval(async () => {
    if (process.env.ABANDONED_CART_EMAILS !== "true") return;
    try {
      const CheckoutSession = (await import("./models/CheckoutSession.js"))
        .default;
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const sessions = await CheckoutSession.find({
        userEmail: { $exists: true, $ne: null, $ne: "" },
        status: "incomplete",
        completedAt: null,
        abandonedEmailSent: { $ne: true },
        updatedAt: { $lt: oneHourAgo },
      })
        .limit(50)
        .lean();

      for (const session of sessions) {
        try {
          await sendAbandonedCartEmail(session);
          await CheckoutSession.updateOne(
            { _id: session._id },
            {
              $set: {
                abandonedEmailSent: true,
                abandonedEmailSentAt: new Date(),
              },
            },
          );
        } catch (emailErr) {
          logger.warn(
            { err: emailErr, sessionId: session._id },
            "Abandoned cart email failed",
          );
        }
      }
      if (sessions.length > 0) {
        logger.info(
          `Abandoned cart: sent ${sessions.length} recovery email(s)`,
        );
      }
    } catch (err) {
      logger.warn({ err }, "Abandoned cart job failed");
    }
  }, abandonedCartIntervalMs);

  const syncIntervalMs = Number(
    process.env.SHIPMENT_SYNC_INTERVAL_MS || 15 * 60 * 1000,
  );
  if (syncIntervalMs > 0) {
    setInterval(async () => {
      try {
        const results = await syncActiveShipments(25);
        const synced = results.filter((r) => r.ok && !r.skipped).length;
        if (synced > 0) {
          logger.info(`Shipment sync: updated ${synced} order(s)`);
        }
      } catch (err) {
        logger.warn({ err }, "Shipment sync job failed");
      }
    }, syncIntervalMs);
  }
}

connectMongo()
  .then(() => {
    // On Vercel, function instances freeze between requests, so setInterval
    // jobs can't run reliably — those jobs are exposed as /api/cron/* routes
    // instead and triggered by an external pinger. Only run them in-process
    // on always-on hosts (Render/Railway/local).
    if (!process.env.VERCEL) startBackgroundJobs();
  })
  .catch(() => {});

app.get("/", (req, res) => {
  res.send("Welcome to AppleBD Backend!");
});

app.use("/api/auth", authRoutes); // here have all of the auth related routes like login, register, logout, refresh token etc.

app.use("/api/admin", adminRoutes); // here have all of the admin related routes like user management, product management, order management etc.

app.use("/api/user", userRoutes); // user-level endpoints for profile, addresses, etc.

app.use("/api/orders", orderRoutes); // order placement, payment callbacks, order history

app.use("/api/coupons", couponRoutes); // coupon listing, eligibility checking, progress indicators

app.use("/api/products", productRoutes); //here have all of the product related routes like add product, update product, delete product, get products etc.

app.use("/api/blog", blogRoutes); //here have all of the blog related routes like add blog, update blog, delete blog, get blogs etc.

app.use("/api/checkout-sessions", checkoutSessionsRouter);
app.use("/api/analytics", analyticsRoutes); // checkout session tracking for abandoned checkout feature
app.use("/api/brands", brandRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/newsletter", newsletterRoutes); // public footer newsletter subscribe
app.use("/api/cart", cartRoutes); // shareable cart links
app.use("/api/cron", cronRoutes); // external-pinger-triggered background jobs (Vercel-safe)

// Public: list active occasion sections (used by homepage)
app.get("/api/occasions", async (req, res) => {
  try {
    const { default: OccasionSection } =
      await import("./models/OccasionSection.js");
    const items = await OccasionSection.find({ isActive: true }).sort({
      order: 1,
      createdAt: 1,
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Fields for product cards used in homepage/featured sections.
// Strips heavy embedded arrays (reviews, faqs, ingredients, specifications).
const HOMEPAGE_PRODUCT_SELECT = [
  "_id title slug price compareAtPrice images",
  "availability inventory badges averageRating reviewCount",
  "freeShipping flashSale flashSalePrice flashSaleEndsAt",
  "variants category categoryId status updatedAt monthlySold coupon",
].join(" ");

// Public: list active featured sections with populated products (used by homepage)
// NOTE: prefer /api/homepage which batches all page data in one request.
app.get("/api/featured", async (req, res) => {
  try {
    const { default: FeaturedSection } =
      await import("./models/FeaturedSection.js");
    const { default: Product } = await import("./models/Product.js");
    const sections = await FeaturedSection.find({ isActive: true })
      .sort({ order: 1, createdAt: 1 })
      .lean();

    // Batch all explicit IDs into one query, category sections in parallel.
    // Video sections contribute the productIds linked to their video cards.
    const explicitIds = [
      ...new Set(
        sections.flatMap((s) =>
          s.type === "video"
            ? (s.videos || [])
                .map((v) => v.productId?.toString())
                .filter(Boolean)
            : (s.productIds || []).map((id) => id.toString()),
        ),
      ),
    ];
    const categorySections = sections.filter(
      (s) => s.type !== "video" && !s.productIds?.length && s.categoryId,
    );

    const [explicitProds, ...catProdArrays] = await Promise.all([
      explicitIds.length
        ? Product.find({
            _id: { $in: explicitIds },
            status: { $ne: "archived" },
          })
            .select(HOMEPAGE_PRODUCT_SELECT)
            .lean()
        : Promise.resolve([]),
      ...categorySections.map((s) =>
        Product.find({ categoryId: s.categoryId, status: { $ne: "archived" } })
          .select(HOMEPAGE_PRODUCT_SELECT)
          .sort({ updatedAt: -1 })
          .limit(s.limit || 10)
          .lean(),
      ),
    ]);

    const explicitMap = Object.fromEntries(
      explicitProds.map((p) => [p._id.toString(), p]),
    );
    let catIdx = 0;
    const result = sections.map((sec) => {
      if (sec.type === "video") {
        return {
          ...sec,
          products: [],
          videos: (sec.videos || []).map((v) => ({
            ...v,
            product: v.productId
              ? explicitMap[v.productId.toString()] || null
              : null,
          })),
        };
      }
      if (sec.productIds?.length > 0) {
        const idOrder = sec.productIds.map((id) => id.toString());
        return {
          ...sec,
          products: idOrder.map((id) => explicitMap[id]).filter(Boolean),
        };
      }
      if (sec.categoryId)
        return { ...sec, products: catProdArrays[catIdx++] || [] };
      return { ...sec, products: [] };
    });

    res.json({ items: result });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: single featured section by id, populated with its products —
// used to render one individually-placed Featured Row on the homepage.
app.get("/api/featured/:id", async (req, res) => {
  try {
    const { default: FeaturedSection } =
      await import("./models/FeaturedSection.js");
    const { default: Product } = await import("./models/Product.js");
    const sec = await FeaturedSection.findOne({
      _id: req.params.id,
      isActive: true,
      type: { $ne: "video" },
    }).lean();
    if (!sec) return res.status(404).json({ error: "Not found" });

    let products = [];
    if (sec.productIds?.length > 0) {
      const idOrder = sec.productIds.map((id) => id.toString());
      const found = await Product.find({
        _id: { $in: idOrder },
        status: { $ne: "archived" },
      })
        .select(HOMEPAGE_PRODUCT_SELECT)
        .lean();
      const map = Object.fromEntries(found.map((p) => [p._id.toString(), p]));
      products = idOrder.map((id) => map[id]).filter(Boolean);
    } else if (sec.categoryId) {
      products = await Product.find({
        categoryId: sec.categoryId,
        status: { $ne: "archived" },
      })
        .select(HOMEPAGE_PRODUCT_SELECT)
        .sort({ updatedAt: -1 })
        .limit(sec.limit || 10)
        .lean();
    }

    res.json({ section: { ...sec, products } });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: ordered list of active homepage blocks (used by Home.jsx to decide
// which sections to render and in what order) — a mix of fixed blocks and
// individually-placed Featured Rows.
app.get("/api/homepage-layout", async (req, res) => {
  try {
    const { default: HomepageLayout, FIXED_REGISTRY } = await import(
      "./models/HomepageLayout.js"
    );
    const { default: FeaturedSection } =
      await import("./models/FeaturedSection.js");

    const layoutItems = await HomepageLayout.find({ isActive: true })
      .sort({ order: 1 })
      .lean();

    if (!layoutItems.length) {
      // Not seeded yet (no admin has opened the dashboard tab) — fall back
      // to the code-defined default fixed order so the homepage never
      // renders blank. Individual Featured Rows aren't known until seeded.
      return res.json({
        items: FIXED_REGISTRY.map((r, i) => ({
          type: "fixed",
          key: r.key,
          order: i,
        })),
      });
    }

    const rowIds = layoutItems
      .filter((i) => i.type === "featuredRow")
      .map((i) => i.featuredSectionId);
    const activeRowIds = rowIds.length
      ? new Set(
          (
            await FeaturedSection.find({
              _id: { $in: rowIds },
              isActive: true,
              type: { $ne: "video" },
            })
              .select("_id")
              .lean()
          ).map((s) => String(s._id)),
        )
      : new Set();

    const items = layoutItems
      .filter(
        (i) =>
          i.type === "fixed" || activeRowIds.has(String(i.featuredSectionId)),
      )
      .map((i) =>
        i.type === "fixed"
          ? { type: "fixed", key: i.key, order: i.order }
          : {
              type: "featuredRow",
              featuredSectionId: i.featuredSectionId,
              order: i.order,
            },
      );

    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: list active promo strip items (used below homepage banner)
app.get("/api/promo-strip", async (req, res) => {
  try {
    const { default: PromoStripItem } =
      await import("./models/PromoStripItem.js");
    const items = await PromoStripItem.find({ isActive: true }).sort({
      order: 1,
      createdAt: 1,
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: list active promo panels (used by Popular Picks left panel)
app.get("/api/promo-panels", async (req, res) => {
  try {
    const { default: PromoPanel } = await import("./models/PromoPanel.js");
    const items = await PromoPanel.find({ isActive: true })
      .sort({ order: 1, createdAt: 1 })
      .populate(
        "productIds",
        "title price compareAtPrice images availability inventory averageRating reviewCount badges variants _id slug",
      );
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: list active testimonials (homepage "What Our Customers Say")
app.get("/api/testimonials", async (req, res) => {
  try {
    const { default: Testimonial } = await import("./models/Testimonial.js");
    const items = await Testimonial.find({ isActive: true }).sort({
      order: 1,
      createdAt: 1,
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: which mobile-banking methods are enabled (checkout page needs this without auth)
app.get("/api/payment-methods", async (req, res) => {
  try {
    const { default: Setting } = await import("./models/Setting.js");
    const s = await Setting.findOne().lean();
    const mb = s?.mobileBanking || {};
    const enabled = ["bkash", "nagad", "rocket"].filter((k) => mb[k]?.enabled);
    res.json({ methods: enabled });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: Deal of the Day product (from settings)
app.get("/api/deal-of-day", async (req, res) => {
  try {
    const { default: Setting } = await import("./models/Setting.js");
    const s = await Setting.findOne().lean();
    const productId = s?.dealOfDayProductId;
    if (!productId) return res.json({ product: null });
    const { default: Product } = await import("./models/Product.js");
    const p = await Product.findById(productId).lean();
    res.json({ product: p || null });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: category-page heading + icon row, shown below the breadcrumb —
// each icon links wherever the admin points it (usually /category/{slug}/).
app.get("/api/store-hero", async (req, res) => {
  try {
    const { default: Setting } = await import("./models/Setting.js");
    const s = await Setting.findOne().lean();
    const cfg = s?.storeHero || {};
    const items = (cfg.items || []).filter(
      (it) => it && it.isActive !== false && (it.image?.url || it.label),
    );
    res.json({
      heading: cfg.heading || "Store.",
      subheading:
        cfg.subheading || "The best way to buy the products you love.",
      items,
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: poster-style typographic hero shown above "Why Choose Us" on the
// homepage — giant word + up to 4 admin-uploaded images tucked between the
// letters. Returns enabled:false so the storefront can render nothing.
app.get("/api/typographic-hero", async (req, res) => {
  try {
    const { default: Setting } = await import("./models/Setting.js");
    const s = await Setting.findOne().lean();
    const cfg = s?.typographicHero || {};
    res.json({
      enabled: cfg.enabled !== false,
      word: cfg.word || "GADGETS",
      images: (cfg.images || []).filter((im) => im && im.url),
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: thin promotional strip shown in the homepage slot that previously
// held Store Hero. Direct-image only. Returns null when disabled/unset so the
// storefront renders nothing.
app.get("/api/promo-banner", async (req, res) => {
  try {
    const { default: Setting } = await import("./models/Setting.js");
    const s = await Setting.findOne().lean();
    const cfg = s?.promoBanner;
    if (!cfg || !cfg.enabled || !cfg.image?.url) return res.json({ banner: null });
    res.json({
      banner: {
        image: cfg.image,
        mobileImage: cfg.mobileImage?.url ? cfg.mobileImage : null,
        link: cfg.link || "/",
        height: cfg.height || 64,
        timerEnabled: !!cfg.timerEnabled,
        timerEndsAt: cfg.timerEnabled ? cfg.timerEndsAt || "" : "",
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: tabbed "Featured Products" showcase (homepage, after categories).
// Resolves each tab's products server-side so the storefront just renders.
// Returns { showcase: null } when disabled or when no tab has any products.
app.get("/api/featured-showcase", async (req, res) => {
  try {
    const { default: Setting } = await import("./models/Setting.js");
    const { default: Product } = await import("./models/Product.js");
    const s = await Setting.findOne().lean();
    const cfg = s?.featuredShowcase || {};
    if (cfg.enabled === false) return res.json({ showcase: null });

    // Card-sized projection — enough for the showcase, no heavy arrays.
    const SELECT =
      "_id title slug description price compareAtPrice images badges " +
      "averageRating reviewCount freeShipping variants availability inventory monthlySold featured";

    // Default tabs when the admin hasn't configured any.
    const DEFAULT_TABS = [
      { label: "Latest", type: "latest", enabled: true },
      { label: "Top Seller", type: "top", enabled: true },
      { label: "Featured", type: "featured", enabled: true },
      { label: "Trending", type: "trending", enabled: true },
    ];
    const tabs =
      Array.isArray(cfg.tabs) && cfg.tabs.length ? cfg.tabs : DEFAULT_TABS;

    const base = { deletedAt: null, status: "published" };
    const LIMIT = 8;

    const resolveTab = async (tab) => {
      if (tab.enabled === false) return null;
      let products = [];
      if (tab.type === "manual") {
        const ids = (tab.productIds || []).map(String);
        if (ids.length) {
          const found = await Product.find({ ...base, _id: { $in: ids } })
            .select(SELECT)
            .lean();
          // preserve the admin's hand-picked order
          const byId = Object.fromEntries(found.map((p) => [String(p._id), p]));
          products = ids.map((id) => byId[id]).filter(Boolean);
          // Apply the admin's per-product showcase-image override and expose it
          // as `showcaseImage` so the storefront uses it as the hero instead of
          // the default 2nd image. The override value is either a custom
          // uploaded image URL (string) or the index of one of the product's own
          // images (number).
          const imageMap = tab.imageMap || {};
          const qtyMap = tab.qtyMap || {};
          products = products.map((p) => {
            const val = imageMap[String(p._id)];
            let url = "";
            if (typeof val === "string" && val.trim()) {
              url = val.trim();
            } else if (
              Number.isInteger(val) &&
              p.images &&
              p.images[val] &&
              p.images[val].url
            ) {
              url = p.images[val].url;
            }
            // per-product add-to-cart quantity (default 1)
            const q = qtyMap[String(p._id)];
            const showcaseQty =
              Number.isInteger(q) && q > 0 ? q : 1;
            const next = { ...p, showcaseQty };
            if (url) next.showcaseImage = url;
            return next;
          });
        }
      } else {
        const filter = { ...base };
        let sort = { createdAt: -1, _id: -1 };
        if (tab.type === "top") sort = { monthlySold: -1, _id: -1 };
        else if (tab.type === "featured") filter.featured = true;
        else if (tab.type === "trending") filter.badges = "trending";
        products = await Product.find(filter)
          .select(SELECT)
          .sort(sort)
          .limit(LIMIT)
          .lean();
      }
      if (!products.length) return null;
      return {
        label: tab.label || tab.type,
        type: tab.type || "latest",
        products: products.slice(0, LIMIT),
      };
    };

    const resolved = (await Promise.all(tabs.map(resolveTab))).filter(Boolean);
    if (!resolved.length) return res.json({ showcase: null });

    res.setHeader("Cache-Control", "no-store");
    res.json({
      showcase: {
        title: cfg.title || "Featured Products",
        subtitle: cfg.subtitle || "",
        tabs: resolved,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: homepage bento category showcase.
// Always returns { pages: [{ title, tiles: [{image, label, link}] }] } —
// legacy single-page configs (tiles / categoryIds) are normalized into one page.
app.get("/api/category-showcase", async (req, res) => {
  try {
    const { default: Setting } = await import("./models/Setting.js");
    const s = await Setting.findOne().lean();
    const cfg = s?.categoryShowcase || {};

    const validTiles = (arr) =>
      (arr || []).filter((t) => t && (t.image?.url || t.label));

    // current format: multiple pages
    const pages = (cfg.pages || [])
      .map((p) => ({ title: p.title || "", tiles: validTiles(p.tiles) }))
      .filter((p) => p.tiles.length > 0);
    if (pages.length > 0) return res.json({ pages });

    // legacy: single-page custom tiles
    const tiles = validTiles(cfg.tiles);
    if (tiles.length > 0)
      return res.json({ pages: [{ title: cfg.title || "", tiles }] });

    // legacy: category-based slots
    const ids = (cfg.categoryIds || []).map(String);
    if (ids.length === 0) return res.json({ pages: [] });
    const { default: Category } = await import("./models/Category.js");
    const cats = await Category.find({ _id: { $in: ids } })
      .select("name slug images")
      .lean();
    const byId = Object.fromEntries(cats.map((c) => [String(c._id), c]));
    const catTiles = ids
      .map((id) => byId[id])
      .filter(Boolean)
      .map((c) => ({
        image: { url: (c.images && c.images[0] && c.images[0].url) || "" },
        label: c.name || "",
        link: `/category/${c.slug || ""}/`,
      }));
    res.json({
      pages: catTiles.length
        ? [{ title: cfg.title || "Shop by Category", tiles: catTiles }]
        : [],
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: list active banner slides (used by homepage)
app.get("/api/banners", async (req, res) => {
  try {
    const { default: Banner } = await import("./models/Banner.js");
    const items = await Banner.find({ isActive: true }).sort({
      order: 1,
      createdAt: 1,
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: get active popup (used by frontend on page load)
app.get("/api/popup", async (req, res) => {
  try {
    const { default: Popup } = await import("./models/Popup.js");
    const popup = await Popup.findOne({ isActive: true });
    res.json({ popup: popup || null });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: list active discount offers (used by OffersToSayYes on homepage)
app.get("/api/discounts", async (req, res) => {
  try {
    const { default: Discount } = await import("./models/Discount.js");
    const { default: Setting } = await import("./models/Setting.js");
    const [items, settings] = await Promise.all([
      Discount.find({ isActive: true }).sort({ order: 1, createdAt: 1 }),
      Setting.findOne().select("offersTitle"),
    ]);
    res.json({ items, offersTitle: settings?.offersTitle || null });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: batched homepage data — replaces 7 separate network calls with one.
// Uses module-level Redis singleton (no per-request connection overhead).
app.get("/api/homepage", async (req, res) => {
  const CACHE_KEY = "homepage:v1";
  const CACHE_TTL = 300; // seconds

  // Try singleton Redis cache first
  if (redisClient?.isReady) {
    try {
      const cached = await redisClient.get(CACHE_KEY);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        res.setHeader(
          "Cache-Control",
          "public, max-age=60, stale-while-revalidate=300",
        );
        return res.json(JSON.parse(cached));
      }
    } catch {
      /* fall through to DB */
    }
  }

  try {
    const [
      { default: Banner },
      { default: OccasionSection },
      { default: FeaturedSection },
      { default: Product },
      { default: PromoStripItem },
      { default: PromoPanel },
      { default: Popup },
      { default: Discount },
    ] = await Promise.all([
      import("./models/Banner.js"),
      import("./models/OccasionSection.js"),
      import("./models/FeaturedSection.js"),
      import("./models/Product.js"),
      import("./models/PromoStripItem.js"),
      import("./models/PromoPanel.js"),
      import("./models/Popup.js"),
      import("./models/Discount.js"),
    ]);

    const [
      banners,
      occasions,
      featuredSections,
      promoStrip,
      promoPanels,
      popup,
      discounts,
    ] = await Promise.all([
      Banner.find({ isActive: true }).sort({ order: 1, createdAt: 1 }).lean(),
      OccasionSection.find({ isActive: true })
        .sort({ order: 1, createdAt: 1 })
        .lean(),
      FeaturedSection.find({ isActive: true })
        .sort({ order: 1, createdAt: 1 })
        .lean(),
      PromoStripItem.find({ isActive: true })
        .sort({ order: 1, createdAt: 1 })
        .lean(),
      PromoPanel.find({ isActive: true })
        .sort({ order: 1, createdAt: 1 })
        .lean(),
      Popup.findOne({ isActive: true }).lean(),
      Discount.find({ isActive: true }).sort({ order: 1, createdAt: 1 }).lean(),
    ]);

    // Hydrate featured sections — batched to avoid N+1 queries.
    // Explicit-productId sections: ONE query for all IDs combined.
    // Category sections: one query per unique category, all in parallel.
    // Video sections contribute the productIds linked to their video cards.
    const explicitIds = [
      ...new Set(
        featuredSections.flatMap((s) =>
          s.type === "video"
            ? (s.videos || [])
                .map((v) => v.productId?.toString())
                .filter(Boolean)
            : (s.productIds || []).map((id) => id.toString()),
        ),
      ),
    ];
    const categorySections = featuredSections.filter(
      (s) => s.type !== "video" && !s.productIds?.length && s.categoryId,
    );

    const [explicitProds, ...catProdArrays] = await Promise.all([
      explicitIds.length
        ? Product.find({
            _id: { $in: explicitIds },
            status: { $ne: "archived" },
          })
            .select(HOMEPAGE_PRODUCT_SELECT)
            .lean()
        : Promise.resolve([]),
      ...categorySections.map((s) =>
        Product.find({ categoryId: s.categoryId, status: { $ne: "archived" } })
          .select(HOMEPAGE_PRODUCT_SELECT)
          .sort({ updatedAt: -1 })
          .limit(s.limit || 10)
          .lean(),
      ),
    ]);

    const explicitMap = Object.fromEntries(
      explicitProds.map((p) => [p._id.toString(), p]),
    );
    let catIdx = 0;

    const featured = featuredSections.map((sec) => {
      if (sec.type === "video") {
        return {
          ...sec,
          products: [],
          videos: (sec.videos || []).map((v) => ({
            ...v,
            product: v.productId
              ? explicitMap[v.productId.toString()] || null
              : null,
          })),
        };
      }
      if (sec.productIds?.length > 0) {
        const idOrder = sec.productIds.map((id) => id.toString());
        const products = idOrder.map((id) => explicitMap[id]).filter(Boolean);
        return { ...sec, products };
      }
      if (sec.categoryId) {
        return { ...sec, products: catProdArrays[catIdx++] || [] };
      }
      return { ...sec, products: [] };
    });

    const payload = {
      banners,
      occasions,
      featured,
      promoStrip,
      promoPanels,
      popup,
      discounts,
    };

    // Write-back to Redis cache
    if (redisClient?.isReady) {
      redisClient
        .setEx(CACHE_KEY, CACHE_TTL, JSON.stringify(payload))
        .catch(() => {});
    }

    res.setHeader("X-Cache", "MISS");
    res.setHeader(
      "Cache-Control",
      "public, max-age=60, stale-while-revalidate=300",
    );
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Public: join product waitlist
app.post("/api/waitlist", async (req, res) => {
  try {
    const { productId, productTitle, email, phone } = req.body;
    if (!productId)
      return res.status(400).json({ error: "productId is required" });
    if (!email && !phone)
      return res.status(400).json({ error: "email or phone is required" });
    const { default: Waitlist } = await import("./models/Waitlist.js");
    // Deduplicate: prevent same contact joining waitlist for the same product twice
    const dupFilter = { productId };
    if (email) dupFilter.email = email.trim().toLowerCase();
    else if (phone) dupFilter.phone = phone.trim();
    const existing = await Waitlist.findOne(dupFilter);
    if (existing)
      return res
        .status(200)
        .json({ ok: true, entry: existing, duplicate: true });
    const entry = await Waitlist.create({
      productId,
      productTitle,
      email: email ? email.trim().toLowerCase() : undefined,
      phone: phone ? phone.trim() : undefined,
    });
    res.status(201).json({ ok: true, entry });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Global error handler — catches any unhandled errors thrown in route handlers
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : "Internal server error";
  if (status >= 500) {
    logger.error({ err, method: req.method, url: req.url }, "Unhandled error");
  }
  res.status(status).json({ error: message });
});

// On Vercel, the platform itself invokes the exported app per-request — it
// must NOT call app.listen(). On always-on hosts (Render/Railway/local) we
// still need a real listening server plus graceful shutdown on SIGTERM.
if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
  });

  // Graceful shutdown — allow in-flight requests to complete before exiting.
  // Render/Railway send SIGTERM before killing the process.
  const gracefulShutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);
    server.close(async () => {
      try {
        await mongoose.connection.close();
      } catch {}
      logger.info("MongoDB disconnected. Exiting.");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 30_000);
  };
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

export default app;
