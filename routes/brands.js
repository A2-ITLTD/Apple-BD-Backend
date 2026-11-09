import express from 'express';
import Brand from '../models/Brand.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

const router = express.Router();

// Public: list active brands
router.get('/', async (req, res) => {
  try {
    const { type, featured, limit = 50, page = 1 } = req.query;
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 50));
    const pageNumber = Math.max(1, Number.parseInt(page, 10) || 1);
    const filter = { isActive: true };
    if (type) filter.type = type;
    if (featured === 'true') filter.isFeatured = true;
    const skip = (pageNumber - 1) * pageSize;
    const [brands, total] = await Promise.all([
      Brand.find(filter).sort({ order: 1, name: 1 }).skip(skip).limit(pageSize).lean(),
      Brand.countDocuments(filter),
    ]);
    res.json({ brands, total });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// Public: get single brand by slug
router.get('/:slug', async (req, res) => {
  try {
    const brand = await Brand.findOne({ slug: req.params.slug, isActive: true }).lean();
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    res.json({ brand });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: create brand
router.post('/', requireAdmin, async (req, res) => {
  try {
    const brand = await Brand.create(req.body);
    res.status(201).json({ brand });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Slug already exists' });
    res.status(400).json({ error: err.message });
  }
});

// Admin: update brand
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const brand = await Brand.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    res.json({ brand });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Slug already exists' });
    res.status(400).json({ error: err.message });
  }
});

// Admin: delete brand
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const brand = await Brand.findByIdAndDelete(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
