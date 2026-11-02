import mongoose from "mongoose";

const PackagingCostSchema = new mongoose.Schema(
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

export default mongoose.models.PackagingCost ||
  mongoose.model("PackagingCost", PackagingCostSchema);
