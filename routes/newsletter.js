import express from "express";
import Subscriber from "../models/Subscriber.js";

const router = express.Router();

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public newsletter subscribe — no auth required. Idempotent: subscribing an
// already-subscribed email just succeeds (never leaks whether it existed).
router.post("/subscribe", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const source = String(req.body?.source || "footer").slice(0, 40);

    if (!emailRe.test(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    await Subscriber.updateOne(
      { email },
      { $setOnInsert: { email, source, createdAt: new Date() } },
      { upsert: true },
    );

    res.json({ ok: true, subscribed: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
