import mongoose from 'mongoose';

const TestimonialSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true },
  address:   { type: String, default: '', trim: true },
  message:   { type: String, required: true, trim: true },
  rating:    { type: Number, default: 5, min: 1, max: 5 },
  avatar:    { url: { type: String, default: '' }, public_id: { type: String, default: '' } },
  isActive:  { type: Boolean, default: true },
  order:     { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

TestimonialSchema.pre('save', function () { this.updatedAt = Date.now(); });

export default mongoose.models.Testimonial || mongoose.model('Testimonial', TestimonialSchema);
