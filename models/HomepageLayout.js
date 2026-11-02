import mongoose from 'mongoose';

// Fixed, code-defined registry of homepage blocks (Apple-frontend/components/home/Home.jsx)
// that always occupy exactly one slot each. Individual Featured Rows (product
// carousels, model FeaturedSection.js) are NOT in this registry — they get their
// own HomepageLayout row per document (type: 'featuredRow') so each can be
// positioned independently among these fixed blocks.
export const FIXED_REGISTRY = [
  { key: 'banner', label: 'Hero Banner (Slider)' },
  { key: 'storeHero', label: 'Store Hero (Mini Category)' },
  { key: 'shopByCategory', label: 'Shop by Category' },
  { key: 'adSlot', label: 'Ad Slot' },
  { key: 'categoryShowcase', label: 'Category Showcase' },
  { key: 'whyChooseUs', label: 'Why Choose Us' },
  { key: 'dealsOfDay', label: 'Deals of the Day' },
  { key: 'ctaSection', label: 'CTA Banner' },
  { key: 'offersToSayYes', label: 'Offers Banner' },
  { key: 'testimonials', label: 'Testimonials' },
  { key: 'shoppableVideo', label: 'Shoppable Video Carousel' },
];

const HomepageLayoutSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['fixed', 'featuredRow'],
    default: 'fixed',
  },
  // set when type === 'fixed' — one of FIXED_REGISTRY's keys
  key: {
    type: String,
    required: function () { return this.type === 'fixed'; },
  },
  // set when type === 'featuredRow' — points at an individual product carousel
  featuredSectionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FeaturedSection',
  },
  label:     { type: String, required: true },
  isActive:  { type: Boolean, default: true },
  order:     { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

HomepageLayoutSchema.pre('save', function () {
  this.updatedAt = Date.now();
});

export default mongoose.models.HomepageLayout ||
  mongoose.model('HomepageLayout', HomepageLayoutSchema);
