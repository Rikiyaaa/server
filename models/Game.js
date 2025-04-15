const mongoose = require('mongoose');

const GameSchema = new mongoose.Schema({
  state: {
    type: String,
    enum: ['waiting', 'cardSelection', 'auction', 'gameOver'],
    default: 'waiting'
  },
  players: [{
    id: String,
    name: String,
    balance: Number,
    collection: [{
      id: Number,
      name: String,
      image: String,
      basePrice: Number,
      rarity: String
    }],
    skipsLeft: Number,
    bidPosition: Number,
    finalScore: Number,
    connected: {      // เพิ่มฟิลด์เก็บสถานะการเชื่อมต่อ
      type: Boolean,
      default: true
    },
    disconnectedAt: { // เพิ่มเวลาที่ตัดการเชื่อมต่อ
      type: Date,
      default: null
    }
  }],
  auctionPool: [{
    id: Number,
    name: String,
    image: String,
    basePrice: Number,
    rarity: String
  }],
  poolPokemon: [{
    id: Number,
    name: String,
    image: String,
    basePrice: Number,
    rarity: String
  }],
  currentPokemon: {
    id: Number,
    name: String,
    image: String,
    basePrice: Number,
    rarity: String
  },
  currentBid: {
    type: Number,
    default: 0
  },
  currentBidder: {
    id: String,
    name: String
  },
  currentBidderTurn: {
    type: String,
    default: null
  },
  timeLeft: {
    type: Number,
    default: 30
  },
  playerPositions: [String],
  playerCards: {    // เพิ่มฟิลด์สำหรับเก็บข้อมูลการ์ดของผู้เล่น
    type: Map,
    of: Number,
    default: {}
  },
  skippedPlayers: [String],  // เพิ่มรายการผู้เล่นที่เลือกข้าม
  isConfirmationPhase: {
    type: Boolean,
    default: false
  },
  lastUpdated: {    // เพิ่มเวลาล่าสุดที่อัปเดต
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const Game = mongoose.model("Game", GameSchema);
module.exports = Game;
