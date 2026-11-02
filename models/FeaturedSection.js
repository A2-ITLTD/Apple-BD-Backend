import mongoose from 'mongoose';

// One video card inside a shoppable video carousel section.
// Either an uploaded/direct video (url [+ public_id if Cloudinary]) or a
// YouTube video (youtubeId). Each card can link a product shown beneath it.
const CarouselVideoSchema = new mongoose.Schema(
  {
    url:         { type: String, default: '' },  // direct/Cloudinary video URL (uploaded file OR any raw video link)
    public_id:   { type: String, default: '' },  // Cloudinary public_id (uploaded files)
    youtubeId:   { type: String, default: '' },  // set instead of url for YouTube links
    facebookUrl: { type: String, default: '' },  // original Facebook video/reel page URL (rendered via FB's embed plugin)
    instagramUrl:{ type: String, default: '' },  // ready-to-use Instagram embed URL (…/embed)
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    // Seconds into the video whose frame is shown while the card is paused
    // (uploaded videos only — YouTube cards always show their thumbnail)
    previewTime: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const FeaturedSectionSchema = new mongoose.Schema({
  // 'products' = product carousel (default), 'video' = shoppable video carousel
  type:        { type: String, enum: ['products', 'video'], default: 'products' },
  // e.g. "Eid Fest on Smart Televisions!" — not shown/asked for video carousels,
  // which use the tagline (subtitle) as their heading instead.
  title:       { type: String, required: function () { return this.type !== 'video'; }, default: '' },
  titleBn:     { type: String, default: '' },      // Bangla title
  // Small tagline above the title (video sections), e.g. "THIS IS HOW BEAUTY LOOKS LIKE"
  subtitle:    { type: String, default: '' },
  subtitleBn:  { type: String, default: '' },
  viewAllLink: { type: String, default: '/' },
  isActive:    { type: Boolean, default: true },
  order:       { type: Number, default: 0 },
  // Admin manually picks products to display
  productIds:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  // Optional: auto-pull from a category instead (if productIds is empty)
  categoryId:  { type: String, default: '' },
  limit:       { type: Number, default: 10 },
  // Video cards for type: 'video'
  videos:      { type: [CarouselVideoSchema], default: [] },
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
});

FeaturedSectionSchema.pre('save', function () {
  this.updatedAt = Date.now();
});

export default mongoose.models.FeaturedSection ||
  mongoose.model('FeaturedSection', FeaturedSectionSchema);
