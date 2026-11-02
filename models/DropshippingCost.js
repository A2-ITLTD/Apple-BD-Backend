import mongoose from "mongoose";

const DropshippingCostSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    cost: {
      type: Number,
      required: true,
      min: 0,
    },
    description: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  },
);

export default mongoose.models.DropshippingCost ||
  mongoose.model("DropshippingCost", DropshippingCostSchema);
