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
    pokemonCollection: [{  // Updated field name to match Player model
      id: Number,
      name: String,
      image: String,
      basePrice: Number,
      rarity: String
    }],
    skipsLeft: Number,
    bidPosition: Number,
    finalScore: Number,
    connected: {
      type: Boolean,
      default: true
    },
    disconnectedAt: {
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
  playerCards: {
    type: Map,
    of: Number,
    default: {}
  },
  skippedPlayers: [String],
  isConfirmationPhase: {
    type: Boolean,
    default: false
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Use a different pattern to check for existing models
let GameModel;
try {
  GameModel = mongoose.model("Game");
} catch (error) {
  GameModel = mongoose.model("Game", GameSchema);
}

module.exports = GameModel;
