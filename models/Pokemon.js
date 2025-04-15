const mongoose = require('mongoose');

const PokemonSchema = new mongoose.Schema({
  pokemonId: {
    type: Number,
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true
  },
  image: {
    type: String
  },
  basePrice: {
    type: Number,
    default: 100
  },
  rarity: {
    type: String,
    enum: ['Common', 'Uncommon', 'Rare', 'Pseudo-Legendary', 'Legendary'],
    default: 'Common'
  },
  stats: {
    hp: Number,
    attack: Number,
    defense: Number,
    specialAttack: Number,
    specialDefense: Number,
    speed: Number
  },
  types: [String],
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const Pokemon = mongoose.model("Pokemon", PokemonSchema);
module.exports = Pokemon;
