import mongoose from "mongoose";

// Public newsletter subscribers — anyone can subscribe from the storefront
// footer with just an email (no account required). Logged-in users still get
// their own `newsletterSubscribed` flag on the User model.
const SubscriberSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  source: { type: String, default: "footer" },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.models?.Subscriber ||
  mongoose.model("Subscriber", SubscriberSchema);
