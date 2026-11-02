import mongoose from "mongoose";

// Simple atomic sequence store. One document per named counter (e.g.
// "orderNumber"); `seq` is bumped with $inc so concurrent orders never collide.
const CounterSchema = new mongoose.Schema({
  _id: { type: String }, // counter name
  seq: { type: Number, default: 1674 }, // first order becomes seq+1 = apl1675
});

export default mongoose.models.Counter ||
  mongoose.model("Counter", CounterSchema);
