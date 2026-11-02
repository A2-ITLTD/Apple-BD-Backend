import mongoose from 'mongoose';

const BannerSchema = new mongoose.Schema({
  image:      { url: { type: String, default: '' }, public_id: { type: String, default: '' } }, // LEFT side image
  rightImage: { url: { type: String, default: '' }, public_id: { type: String, default: '' } }, // RIGHT side image (new hero design)
  title:      { type: String, default: '' },   // left side big title, e.g. "Sound Max Pro"
  subtitle:   { type: String, default: '' },   // left side description
  buttonText: { type: String, default: 'Shop Now' },
  buttonLink: { type: String, default: '/' },
  badge:      { type: String, default: '' },   // small tagline above left title, e.g. "Feel the Music with"
  rightTitle: { type: String, default: '' },   // right side big title, e.g. "Bass Blaster X7"
  rightText:  { type: String, default: '' },   // right side description
  isActive:   { type: Boolean, default: true },
  order:      { type: Number, default: 0 },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now },
});

BannerSchema.pre('save', function () { this.updatedAt = Date.now(); });

export default mongoose.models.Banner || mongoose.model('Banner', BannerSchema);
