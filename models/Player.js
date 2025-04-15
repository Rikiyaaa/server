const mongoose = require("mongoose");
const { Schema } = mongoose;

const PlayerSchema = new Schema({
  socketId: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true,
    unique: true    // เปลี่ยนให้ name เป็น unique แทน socketId
  },
  balance: {
    type: Number,
    default: 5000
  },
  collection: [{
    id: Number,
    name: String,
    image: String
  }],
  skipsLeft: {
    type: Number,
    default: 2
  },
  bidPosition: {
    type: Number
  },
  cardValue: {     // เพิ่มค่าการ์ดที่ผู้เล่นเลือก
    type: Number
  },
  connected: {     // เพิ่มสถานะการเชื่อมต่อ
    type: Boolean,
    default: true
  },
  disconnectedAt: {  // เพิ่มเวลาที่ตัดการเชื่อมต่อ
    type: Date,
    default: null
  },
  lastGameId: {    // เพิ่มอ้างอิงถึงเกมล่าสุดที่เล่น
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Game'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// สร้าง index ที่เป็น unique แบบหลายฟิลด์เพื่อให้สามารถมี socketId ซ้ำได้ในเกมคนละรอบ
PlayerSchema.index({ name: 1, lastGameId: 1 }, { unique: true });

const Player = mongoose.model("Player", PlayerSchema);
module.exports = Player;
