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
    unique: true
  },
  balance: {
    type: Number,
    default: 5000
  },
  // Rename "collection" to "pokemonCollection" to avoid conflicts
  pokemonCollection: [{
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
  cardValue: {
    type: Number
  },
  connected: {
    type: Boolean,
    default: true
  },
  disconnectedAt: {
    type: Date,
    default: null
  },
  lastGameId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Game'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create a compound unique index
PlayerSchema.index({ name: 1, lastGameId: 1 }, { unique: true });

// Use a different pattern to check for existing models
let PlayerModel;
try {
  PlayerModel = mongoose.model("Player");
} catch (error) {
  PlayerModel = mongoose.model("Player", PlayerSchema);
}

module.exports = PlayerModel;
