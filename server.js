const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');

// Import models
const Player = require('./models/Player');  
const Game = require('./models/Game');
const Pokemon = require('./models/Pokemon');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ['GET', 'POST']
  }
});

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://pokemons:20762newsa@cluster0.8uspm5l.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0', { 
  useNewUrlParser: true, 
  useUnifiedTopology: true
})
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('Could not connect to MongoDB', err));

// Game state variables
let gameState = 'waiting'; // waiting, auction, gameOver
let players = [];
let currentPokemon = null;
let auctionPool = [];
let currentBid = 0;
let currentBidder = null;
let currentBidderTurn = null; // เพิ่มบรรทัดนี้
let auctionTimer = null;
let timeLeft = 30;
let poolPokemon = [];
let isConfirmationPhase = false;
let bidderTimeout; // เพิ่มบรรทัดนี้
let confirmTimeout; // เพิ่มบรรทัดนี้
// Variables for the card selection phase
let playerCards = new Map(); // Maps player IDs to their card values (1-3)
let playerPositions = []; // Array containing player IDs in bidding order
let assignedPositions = new Set(); // Keep track of assigned positions
let currentBidderIndex = 0; // Current bidder in the bidding cycle
let skippedPlayers = [];
// Add these variables to track reset votes
let resetVotes = new Set();
let resetVoteTimeout = null;
let externalVoters = new Set(); // For players who voted from login screen

let cardSelectionTimeout = null;
// Add to the initialization function
// Remove the automatic timer in initializing game
// Initialize a new game
function initializeGame() {
  // Reset game state
  gameState = 'waiting';
  players = [];
  currentPokemon = null;
  auctionPool = [];
  poolPokemon = [];
  currentBid = 0;
  currentBidder = null;
  currentBidderTurn = null;
  clearInterval(auctionTimer);
  clearTimeout(bidderTimeout);
  clearTimeout(confirmTimeout);
  if (cardSelectionTimeout) {
    clearTimeout(cardSelectionTimeout);
    cardSelectionTimeout = null;
  }
  
  // Reset card selection variables
  playerCards = new Map();
  playerPositions = [];
  assignedPositions = new Set();
  currentBidderIndex = 0;
  
  // Fetch random Pokemon for auction
  fetchRandomPokemon(18).then(pokemon => {
    auctionPool = pokemon;
    
    // Save initial game state to database
    try {
      Game.findOneAndUpdate(
        {}, 
        { 
          state: gameState,
          players: [],
          auctionPool,
          poolPokemon,
          currentPokemonIndex: null,
          currentBid,
          currentBidder: null
        },
        { upsert: true, new: true }
      ).exec();
    } catch (error) {
      console.error('Error initializing game in database:', error);
    }
  });
}


// Function to fetch random Pokemon from PokeAPI
async function fetchRandomPokemon(count = 18) {
  try {
    const totalPokemon = 898; // Total number of Pokemon in PokeAPI
    const randomIds = new Set();
    
    // Generate unique random Pokemon IDs
    while (randomIds.size < count) {
      const id = Math.floor(Math.random() * totalPokemon) + 1;
      randomIds.add(id);
    }
    
    // Fetch Pokemon data
    const pokemonPromises = Array.from(randomIds).map(async (id) => {
      const response = await axios.get(`https://pokeapi.co/api/v2/pokemon/${id}`);
      
      // Calculate a base price based on stats
      const statTotal = response.data.stats.reduce((sum, stat) => sum + stat.base_stat, 0);
      
      // Calculate base price (between 100-1000)
      // Higher stat total = higher price
      // Formula: Maps stat total (typically 200-600) to price range 100-1000
      const basePrice = Math.floor(statTotal * 1.8 / 50) * 50;
      
      return {
        id: response.data.id,
        name: response.data.name,
        image: response.data.sprites.other['official-artwork'].front_default || response.data.sprites.front_default,
        basePrice: basePrice, // Add base price to Pokemon object
        rarity: calculateRarity(response.data) // Optional: Add rarity calculation
      };
    });
    
    return await Promise.all(pokemonPromises);
  } catch (error) {
    console.error('Error fetching Pokemon:', error);
    return [];
  }
}

// เพิ่มฟังก์ชันใหม่เพื่อตรวจสอบว่าครบเงื่อนไขเริ่มประมูลหรือยัง
function checkCardsSelection() {
  if (gameState !== 'cardSelection') return;
  
  const connectedPlayers = players.filter(p => p.connected);
  const playersSelected = Array.from(playerCards.keys()).length;
  
  if (playersSelected >= connectedPlayers.length) {
    // แจ้งเตือนผู้เล่นว่าการประมูลกำลังจะเริ่ม
    io.emit('notification', 'All players have selected cards! Auction will begin in 5 seconds...');
    
    // ล้าง timeout เดิมถ้ามี
    if (cardSelectionTimeout) {
      clearTimeout(cardSelectionTimeout);
      cardSelectionTimeout = null;
    }
    
    // ตั้ง timeout ใหม่
    setTimeout(() => {
      gameState = 'auction';
      io.emit('gameState', 'auction');
      
      // จัดเรียงผู้เล่นตามค่าการ์ด
      playerPositions = [];
      for (const player of players) {
        if (playerCards.has(player.id)) {
          playerPositions.push(player.id);
        }
      }
      playerPositions.sort((a, b) => {
        return playerCards.get(a) - playerCards.get(b);
      });
      
      // กำหนดตำแหน่งการประมูลให้แต่ละผู้เล่น
      players.forEach(player => {
        const position = playerPositions.indexOf(player.id) + 1;
        player.bidPosition = position;
      });
      
      // เริ่มประมูล Pokemon ตัวแรก
      nextPokemon();
    }, 5000); // รอ 5 วินาทีก่อนเปลี่ยนสถานะเกม
  }
}

function calculateRarity(pokemonData) {
  // This is a simple implementation
  // You could make this more sophisticated based on:
  // - Legendary status
  // - Evolution stage
  // - Special categories
  
  // Basic calculation based on stats
  const statTotal = pokemonData.stats.reduce((sum, stat) => sum + stat.base_stat, 0);
  
  if (statTotal > 500) return 'Legendary'; // Likely a legendary
  if (statTotal > 300) return 'Pseudo-Legendary';
  if (statTotal > 200) return 'Rare';
  if (statTotal > 150) return 'Uncommon';
  return 'Common';
}

function startAuction() {
  console.log("Starting card selection phase with player count:", players.length);
  
  if (players.length < 3) {
    io.emit('notification', 'Need at least 3 players to start the auction.');
    return;
  }
  
  // Reset card selection variables
  playerCards = new Map();
  assignedPositions = new Set();
  
  gameState = 'cardSelection';
  io.emit('selectCardsPhase');
  io.emit('notification', 'Please select your cards to determine bidding order!');
  
  // ล้าง timeout เดิมถ้ามี
  if (cardSelectionTimeout) {
    clearTimeout(cardSelectionTimeout);
  }
  
  // ตั้ง timeout ใหม่สำหรับผู้เล่นที่ไม่เลือกการ์ด
  cardSelectionTimeout = setTimeout(() => {
    // ตรวจสอบว่ายังอยู่ในเฟสการเลือกการ์ดหรือไม่
    if (gameState !== 'cardSelection') {
      return;
    }
    
    // Assign random positions to players who didn't select
    players.filter(p => p.connected).forEach(player => {
      if (!playerCards.has(player.id)) {
        let position;
        do {
          position = Math.floor(Math.random() * 3) + 1;
        } while (assignedPositions.has(position));
        
        playerCards.set(player.id, position);
        assignedPositions.add(position);
        
        // Notify player of their random assignment
        io.to(player.id).emit('cardRevealed', {
          playerId: player.id,
          cardIndex: 0, // Just use first card for random assignment
          value: position
        });
      }
    });
    
    // เรียกใช้ checkCardsSelection เพื่อเริ่มการประมูล
    checkCardsSelection();
  }, 30000); // ให้เวลาผู้เล่น 30 วินาทีในการเลือกการ์ด
}

// Function to get the next bidder in the cycle
function getNextBidder() {
  // If there are no positions or no players, return null
  if (!playerPositions.length || !players.length) {
    return null;
  }
  
  // If all players have had a turn, reset to the first player
  if (currentBidderIndex >= playerPositions.length) {
    currentBidderIndex = 0;
  }
  
  // Get player ID from position array
  const nextBidderId = playerPositions[currentBidderIndex];
  
  // Move to next bidder for the next call
  currentBidderIndex++;
  
  // Find player object
  const player = players.find(p => p.id === nextBidderId);
  
  // Return the player or null if not found
  return player || null;
}
// Update the nextPokemon function to reset skipped players
function nextPokemon() {
  if (auctionPool.length === 0) {
    endGame();
    return;
  }
  
  // แจ้งเตือนว่ากำลังจะเริ่มประมูล Pokemon ตัวใหม่
  io.emit('bidNotification', 'Next Pokemon will be revealed in 5 seconds...');
  
  // รอ 5 วินาทีก่อนแสดง Pokemon ตัวต่อไป
  setTimeout(() => {
    // Reset skipped players for the new Pokemon
    skippedPlayers = [];
    
    // Get the next Pokemon
    currentPokemon = auctionPool.pop();
    currentBid = currentPokemon.basePrice || 100;
    currentBidder = null;
    
    // Check if any player can afford the current Pokemon
    const anyPlayerCanAfford = players.some(player => player.balance >= currentBid);
    
    // Set preview mode if no player can afford this Pokemon
    const isPreviewMode = !anyPlayerCanAfford;
    timeLeft = isPreviewMode ? 10 : 30; // Shorter preview time if no one can afford
    
    // Reset bidder index for new Pokemon
    currentBidderIndex = 0;
    
    // Notify clients about preview mode if active
    if (isPreviewMode) {
      io.emit('bidNotification', `No player can afford ${currentPokemon.name}. Preview mode activated (10s).`);
    } else {
      io.emit('bidNotification', `${currentPokemon.name} is now up for auction! Starting bid: ${currentBid} coins.`);
    }
    
    // Start the auction for this Pokemon
    updateAuctionState();
    
    // Start timer - THIS IS WHERE THE AUCTION TIMER ACTUALLY STARTS
    clearInterval(auctionTimer);
    auctionTimer = setInterval(() => {
      if (timeLeft <= 0) {
        clearInterval(auctionTimer);
        endAuction();
        return;
      }
      timeLeft--;
      updateAuctionState();
    }, 1000);
    
    // Only set next bidder if not in preview mode
    if (!isPreviewMode) {
      setNextBidder();
    } else {
      // In preview mode, we don't set a bidder
      currentBidderTurn = null;
      io.emit('auctionUpdate', getAuctionState());
    }
  }, 5000); // รอ 5 วินาทีก่อนแสดง Pokemon
}

function handlePass(player) {
  // Only allow passing if it's the player's turn
  if (currentBidderTurn !== player.name) {
    return;
  }
  
  io.emit('bidNotification', `${player.name} passed their turn.`);
  
  // Move to the next bidder
  setNextBidder();
}
// Update setNextBidder to handle skipped players
function setNextBidder() {
  // ค้นหาผู้ประมูลที่มีสิทธิ์คนถัดไป
  let nextEligibleBidder = null;
  let loopCheck = 0;
  let checkCount = 0;
  
  // วนหาผู้ประมูลจนกว่าจะพบคนที่มีสิทธิ์หรือตรวจสอบผู้เล่นทั้งหมด
  while (nextEligibleBidder === null && checkCount < players.length) {
    const potentialBidder = getNextBidder();
    checkCount++;
    
    // ตรวจสอบว่า potentialBidder มีค่าหรือไม่
    if (!potentialBidder) {
      continue;
    }
    
    // ข้ามผู้เล่นที่ไม่ได้เชื่อมต่อ
    if (!potentialBidder.connected) {
      continue;
    }
    
    // ข้ามผู้เล่นที่ไม่สามารถประมูลได้ (เงินไม่เพียงพอสำหรับการประมูลขั้นต่ำ)
    // รวมถึงข้ามผู้เล่นที่เลือกข้ามการประมูลนี้
    if (potentialBidder.balance >= currentBid && 
        (!skippedPlayers || !skippedPlayers.includes(potentialBidder.id))) {
      nextEligibleBidder = potentialBidder;
    } else if (potentialBidder.balance < currentBid) {
      // ข้ามอัตโนมัติสำหรับผู้เล่นที่ไม่สามารถจ่ายราคาประมูลปัจจุบันได้
      io.emit('bidNotification', `${potentialBidder.name} can't afford the minimum bid and was skipped.`);
    }
    
    loopCheck++;
    if (loopCheck > players.length * 2) {
      // ป้องกัน infinite loop
      break;
    }
  }
  
  if (nextEligibleBidder) {
    // อัปเดตตาประมูลปัจจุบัน
    currentBidderTurn = nextEligibleBidder.name;
    
    // แจ้งเตือนทุกคนว่าใครกำลังประมูล
    io.emit('auctionUpdate', getAuctionState());
    
    // แจ้งเตือนผู้ประมูลเฉพาะว่าถึงตาของพวกเขา
    io.to(nextEligibleBidder.id).emit('yourTurnToBid');
    
    // ล้าง timeout ที่มีอยู่
    clearTimeout(bidderTimeout);
  } else {
     // ไม่มีผู้ประมูลที่มีสิทธิ์เหลืออีกแล้ว แต่ไม่จบการประมูลทันที
    // แทนที่จะทำเช่นนั้น ให้เวลาเดินต่อไปในโหมด "preview"
    currentBidderTurn = null;
    io.emit('bidNotification', `No players can afford ${currentPokemon.name}. Preview mode active.`);
    io.emit('auctionUpdate', getAuctionState());
  }
}
// Function to end the current auction
// Function to end the current auction
function endAuction() {
  // Clear timer and any pending timeouts
  clearInterval(auctionTimer);
  clearTimeout(bidderTimeout);
  
  if (currentBidder) {
    // Find the winning player
    const winner = players.find(p => p.name === currentBidder);
    
    if (winner) {
      // Set confirmation phase flag to true
      isConfirmationPhase = true;
      
      // Update auction state to show we're in confirmation phase
      updateAuctionState();
      
      // Ask the winner to confirm purchase
      io.to(winner.id).emit('confirmPurchase');
      
      // Set a timeout for confirmation (10 seconds)
      clearTimeout(confirmTimeout);
      confirmTimeout = setTimeout(() => {
        // Auto-confirm if player doesn't respond
        handlePurchaseConfirmation(winner, true);
      }, 10000);
      
      // Notify everyone that winner is confirming
      io.emit('bidNotification', `${winner.name} is confirming purchase of ${currentPokemon.name}...`);
    } else {
      // No winner found (shouldn't happen), move to next Pokemon
      nextPokemon();
    }
  } else {
    // No one bid, move to next Pokemon
    io.emit('bidNotification', `No bids for ${currentPokemon.name}. Moving to next Pokémon.`);
    // Add the unpurchased Pokemon to the pool
    if (currentPokemon) {
      poolPokemon.push(currentPokemon);
    }
    nextPokemon();
  }
}

// Function to handle purchase confirmation
// Modify handlePurchaseConfirmation to respect the confirmation phase
function handlePurchaseConfirmation(player, confirm) {
  clearTimeout(confirmTimeout);
  
  // Only proceed if we were in confirmation phase
  if (!isConfirmationPhase) return;
  
  // Reset confirmation phase flag
  isConfirmationPhase = false;
  
  if (confirm) {
    // Check if player can still afford it
    if (player.balance >= currentBid) {
       // Process the purchase
  player.balance -= currentBid;
  player.collection.push(currentPokemon);
  
  // ลบ Pokemon ที่ถูกซื้อออกจาก poolPokemon
  const index = poolPokemon.findIndex(p => p && p.id === currentPokemon.id);
  if (index !== -1) {
    poolPokemon.splice(index, 1);
  }
  
  // Notify everyone about the purchase
  io.emit('bidNotification', `${player.name} purchased ${currentPokemon.name} for ${currentBid} coins!`);
  
  // Update player state
  io.emit('playerUpdate', player);
    } else {
      // Player can't afford it anymore
      io.emit('bidNotification', `${player.name} couldn't afford ${currentPokemon.name}. Moving to next Pokémon.`);
      // Add to pool since it wasn't purchased
      poolPokemon.push(currentPokemon);
    }
  } else {
    // Player declined the purchase
    io.emit('bidNotification', `${player.name} declined to purchase ${currentPokemon.name}. It's added to the mystery pool.`);
    poolPokemon.push(currentPokemon);
  }
  
  // Now that confirmation is complete, move to next Pokemon
  nextPokemon();
}
// Update getAuctionState to include the preview mode flag
function getAuctionState() {
  const anyPlayerCanAfford = players.some(player => player.balance >= currentBid);
  const isPreviewMode = !anyPlayerCanAfford && currentPokemon;
  
  return {
    currentPokemon,
    currentBid,
    currentBidder,
    timeLeft,
    players,
    pokemonLeft: auctionPool.length,
    biddingOrder: playerPositions.map(id => players.find(p => p.id === id)?.name || 'Unknown'),
    currentBidderTurn,
    isPreviewMode
  };
}

// Function to update auction state
// Modify updateAuctionState to include preview mode status
function updateAuctionState() {
  const anyPlayerCanAfford = players.some(player => player.balance >= currentBid);
  const isPreviewMode = !anyPlayerCanAfford && currentPokemon;
  
  io.emit('auctionUpdate', {
    ...getAuctionState(),
    isPreviewMode
  });
  
  // Also update the game state in the database
  try {
    Game.findOneAndUpdate(
      {}, 
      { 
        state: gameState,
        players,
        currentPokemon,
        currentBid,
        currentBidder,
        timeLeft,
        isPreviewMode
      },
      { new: true }
    ).exec();
  } catch (error) {
    console.error('Error updating game state in database:', error);
  }
}

// Update to handleSkip function
function handleSkip(player) {
  // Only allow skipping if it's the player's turn
  if (currentBidderTurn !== player.name) {
    return;
  }
  
  // Use up a skip if the player has any left
  if (player.skipsLeft > 0) {
    player.skipsLeft--;
    io.emit('bidNotification', `${player.name} skipped their turn and is out for this auction. (${player.skipsLeft} skips left)`);
    
    // Send the updated player data to all clients
    io.emit('playerUpdate', player);
    
    // Remove this player from the current auction cycle
    const playerIndex = playerPositions.indexOf(player.id);
    if (playerIndex !== -1) {
      // Store skipped players in a temporary array for this auction
      if (!skippedPlayers) skippedPlayers = [];
      skippedPlayers.push(player.id);
    }
    
    // Move to the next bidder
    setNextBidder();
  } else {
    io.emit('bidNotification', `${player.name} has no skips left and must bid or pass.`);
  }
}
function handleBid(player, amount) {
  // Validate that it's the player's turn
  if (currentBidderTurn !== player.name) {
    return { success: false, message: "It's not your turn to bid" };
  }
  
  // Validate bid amount is in allowed range (50, 100, 150, 200)
  if (![50, 100, 150, 200].includes(amount)) {
    return { success: false, message: "Bid amount must be 50, 100, 150, or 200" };
  }
  
  const newBid = currentBid + amount;
  
  // Check if player can afford the bid
  if (newBid > player.balance) {
    return { success: false, message: "You don't have enough balance for this bid" };
  }
  
  // Update current bid and bidder
  currentBid = newBid;
  currentBidder = player.name;
  timeLeft = 30; // Reset timer on new bid
  
  // Clear the bidder timeout since a bid was placed
  clearTimeout(bidderTimeout);
  
  // Notify everyone about the bid
  io.emit('bidNotification', `${player.name} bid ${amount} coins. Total: ${currentBid}`);
  updateAuctionState();
  
  // Set next bidder - เพิ่มบรรทัดนี้เพื่อให้เปลี่ยนคนประมูลทันที
  setNextBidder();
  
  return { success: true };
}
// Broadcast current auction state to all clients
function broadcastAuctionUpdate() {
  io.emit('auctionUpdate', {
    currentPokemon,
    currentBid,
    currentBidder: currentBidder ? currentBidder.name : null,
    timeLeft,
    players: players.map(player => ({
      id: player.id,
      name: player.name,
      balance: player.balance,
      collection: player.collection
    })),
    pokemonLeft: auctionPool.length
  });
}

// Handle end of an auction for a specific Pokemon
function finishAuction() {
  if (currentBidder) {
    // Someone bid on this Pokemon
    isConfirmationPhase = true; // เพิ่มบรรทัดนี้
    io.to(currentBidder.id).emit('confirmPurchase');
  } else {
    // No one bid, add to pool and move to next Pokemon
    poolPokemon.push(currentPokemon);
    nextPokemon();
  }
}

// We also need to make sure endGame correctly sets up the pool
function endGame() {
  gameState = 'gameOver';
  io.emit('gameState', 'gameOver');
  clearInterval(auctionTimer);
  
  // Calculate final scores
  players.forEach(player => {
    let collectionValue = 0;
    player.collection.forEach(pokemon => {
      collectionValue += pokemon.basePrice || 100;
    });
    player.finalScore = collectionValue + player.balance;
  });
  
  // Sort players by score
  const rankings = [...players].sort((a, b) => b.finalScore - a.finalScore);
  
  // Make sure poolPokemon only includes Pokemon that were not purchased
  // This ensures purchased Pokemon aren't in the Wonder Pick pool
  poolPokemon = poolPokemon.filter(pokemon => pokemon !== null);
  
  // Send game results
  io.emit('gameResults', {
    rankings,
    leader: rankings.length > 0 ? rankings[0].name : null
  });
  
  // Start the pool picking phase
  startPoolPicking();
}
// Send current game results to all clients
function sendGameResults(pool = null) {
  io.emit('gameResults', {
    players: players.map(player => ({
      id: player.id,
      name: player.name,
      balance: player.balance,
      collection: player.collection
    })),
    poolPokemon: pool || poolPokemon.map(() => null),
    currentPickingPlayer: players.length > 0 ? {
      id: players[0].id,
      name: players[0].name
    } : null,
    winner: players.length > 0 ? {
      id: players[0].id,
      name: players[0].name
    } : null
  });
}
// Update this function to initialize the player order for Wonder Pick
function startPoolPicking() {
  // กรอง Pokemon ที่ซ้ำกันออกโดยใช้ ID
  const uniquePoolIds = new Set();
  poolPokemon = poolPokemon.filter(p => {
    if (p === null || uniquePoolIds.has(p.id)) return false;
    uniquePoolIds.add(p.id);
    return true;
  });
  // by filtering out null entries (this is just to be safe)
  poolPokemon = poolPokemon.filter(p => p !== null);
  
  // Sort players by balance (highest to lowest)
  players.sort((a, b) => b.balance - a.balance);
  
  // Filter eligible players (those with < 6 Pokemon)
  const eligiblePlayers = players.filter(p => p.connected && p.collection.length < 6);
  
  // Reset the bidding index for Wonder Pick phase
  currentBidderIndex = 0;
  
  // Set player positions for Wonder Pick, starting with highest balance
  playerPositions = eligiblePlayers.map(p => p.id);
  
  // Determine the first player to pick
  const currentPickingPlayer = eligiblePlayers.length > 0 ? eligiblePlayers[0] : null;
  
  // Send the pool picking state to all clients
  sendPoolPickingState(poolPokemon, currentPickingPlayer);
  
  // Log to confirm the phase has started
  console.log('Pool picking phase started with player:', currentPickingPlayer?.name);
}
function handlePick(socket, data) {
  // Check if we're in the game over state
  if (gameState !== 'gameOver') {
    console.log('Not in gameOver state');
    return;
  }
  
  // Find the player who wants to pick a card
  const player = players.find(p => p.id === socket.id);
  if (!player) {
    console.log('Player not found');
    return;
  }
  
  // Sort players by remaining balance (highest to lowest)
  const eligiblePlayers = [...players]
    .filter(p => p.connected && p.collection.length < 6)  // Only players with less than 6 Pokemon
    .sort((a, b) => b.balance - a.balance);  // Sort by balance
  
  // Check if there are any eligible players left
  if (eligiblePlayers.length === 0) {
    console.log('No eligible players left');
    finalizeGame();
    return;
  }
  
  // Get the current picking player by position
  const currentPickingPlayerIndex = playerPositions.indexOf(socket.id);
  
  // Verify it's the requesting player's turn
  if (currentPickingPlayerIndex === -1 || currentPickingPlayerIndex !== currentBidderIndex % playerPositions.length) {
    socket.emit('bidNotification', 'It\'s not your turn to pick a card.');
    console.log(`Not ${player.name}'s turn to pick. Current picking index: ${currentBidderIndex % playerPositions.length}`);
    return;
  }
  
  // Check if player already has 6 Pokemon
  if (player.collection.length >= 6) {
    socket.emit('bidNotification', 'You already have 6 Pokémon. Cannot pick more.');
    console.log(`${player.name} already has 6 Pokémon`);
    return;
  }
  
  const { index } = data;
  // Validate index
  if (index < 0 || index >= poolPokemon.length) {
    socket.emit('bidNotification', 'Invalid card selection.');
    console.log('Invalid card index');
    return;
  }
  
  // Get the selected Pokemon
  const selectedPokemon = poolPokemon[index];
  
  // Verify this card hasn't been picked yet
  if (!selectedPokemon) {
    socket.emit('bidNotification', 'This card has already been picked.');
    console.log('Null card selected');
    return;
  }
  
  console.log(`${player.name} picked ${selectedPokemon.name}`);
  
  // Add Pokemon to player's collection
  player.collection.push(selectedPokemon);
  
  // Remove Pokemon from pool
  poolPokemon[index] = null;
  
  // Show the picked Pokemon to everyone
  io.emit('pokemonRevealed', {
    pokemon: selectedPokemon,
    playerName: player.name
  });
  
  // Update player info for everyone
  io.emit('playerUpdate', player);
  
  // Check if all Pokemon have been picked
  const remainingPokemon = poolPokemon.filter(p => p !== null);
  if (remainingPokemon.length === 0) {
    // All Pokemon picked, end game
    setTimeout(() => {
      finalizeGame();
    }, 2000);
    return;
  }
  
  // Move to the next player's turn after a short delay
  setTimeout(() => {
    // Get the next eligible players in round-robin order
    // Increment the current bidder index for next turn (round-robin)
    currentBidderIndex++;
    
    // Filter players who are still eligible to pick
    const nextEligiblePlayers = [...players]
      .filter(p => p.connected && p.collection.length < 6);
    
    if (nextEligiblePlayers.length === 0) {
      // No eligible players left, end game
      finalizeGame();
      return;
    }
    
    // Find the next player to pick in the rotation
    let nextPickingIndex = currentBidderIndex % playerPositions.length;
    let nextPickingPlayer = null;
    let loopCount = 0;
    
    // Find next eligible player in the rotation order
    while (nextPickingPlayer === null && loopCount < playerPositions.length) {
      const playerId = playerPositions[nextPickingIndex];
      const player = players.find(p => p.id === playerId && p.connected && p.collection.length < 6);
      
      if (player) {
        nextPickingPlayer = player;
      } else {
        // Move to next player in rotation
        nextPickingIndex = (nextPickingIndex + 1) % playerPositions.length;
        currentBidderIndex++;
      }
      
      loopCount++;
    }
    
    if (!nextPickingPlayer && nextEligiblePlayers.length > 0) {
      // Fallback: if we couldn't find an eligible player in position order,
      // just take the first eligible player by balance
      nextPickingPlayer = nextEligiblePlayers[0];
    }
    
    console.log(`Next player to pick: ${nextPickingPlayer?.name || 'None'}`);
    
    // Send updated picking state to all clients
    sendPoolPickingState(poolPokemon, nextPickingPlayer);
  }, 1000);
}
// We need to modify this function to properly send pool picking state
function sendPoolPickingState(currentPool = null, currentPickingPlayer = null) {
  // Sort and filter eligible players (connected and with < 6 Pokemon)
  const eligiblePlayers = [...players]
    .filter(p => p.connected && p.collection.length < 6)
    .sort((a, b) => b.balance - a.balance);
  
  // If no eligible players left, end game
  if (eligiblePlayers.length === 0) {
    finalizeGame();
    return;
  }
  
  // If no picking player was specified, use the first eligible player
  if (!currentPickingPlayer) {
    currentPickingPlayer = eligiblePlayers[0];
  }
  
  // Send game results with picking state
  io.emit('gameResults', {
    players: players.map(player => ({
      id: player.id,
      name: player.name,
      balance: player.balance,
      collection: player.collection,
      pokemonCount: player.collection.length // Add Pokemon count
    })),
    poolPokemon: currentPool || poolPokemon,
    currentPickingPlayer: currentPickingPlayer ? {
      id: currentPickingPlayer.id,
      name: currentPickingPlayer.name
    } : null,
    // Highlight who has the highest score but don't call them winner yet
    leadingPlayer: players.length > 0 ? {
      id: players[0].id,
      name: players[0].name
    } : null
  });
  
  // Notify the current picking player it's their turn
  if (currentPickingPlayer) {
    io.to(currentPickingPlayer.id).emit('yourTurnToPick');
  }
}
// Add a new function to finalize the game
// Fix the finalizeGame function
function finalizeGame() {
  // Calculate total value of each player's collection
  players.forEach(player => {
    let collectionValue = 0;
    player.collection.forEach(pokemon => {
      collectionValue += pokemon.basePrice || 100;
    });
    player.collectionValue = collectionValue;
    player.finalScore = collectionValue + player.balance;
  });
  
  // Sort players by final score
  const sortedPlayers = [...players].sort((a, b) => b.finalScore - a.finalScore);
  
  // Send final game results
  io.emit('gameFinal', {
    players: sortedPlayers.map(player => ({
      id: player.id,
      name: player.name,
      balance: player.balance,
      collection: player.collection,
      collectionValue: player.collectionValue,
      finalScore: player.finalScore
    })),
    winner: sortedPlayers.length > 0 ? {
      id: sortedPlayers[0].id,
      name: sortedPlayers[0].name,
      collection: sortedPlayers[0].collection,
      finalScore: sortedPlayers[0].finalScore
    } : null,
    remainingPoolPokemon: poolPokemon.filter(p => p !== null) // Only include remaining pool Pokemon
  });
  
  // Start a new game after delay
  setTimeout(() => {
    resetGame();
  }, 15000);
}
// Add to the server code to check for empty games
function checkEmptyGame() {
  // If no game in progress, nothing to do
  if (gameState === 'waiting') return;
  
  // Check if at least 2 players are disconnected
  const connectedPlayers = players.filter(p => p.connected);
  
  if (players.length - connectedPlayers.length >= 2) {
    console.log('Two or more players disconnected, ending and resetting game');
    
    // Reset game state completely
    gameState = 'waiting';
    players = [];
    currentPokemon = null;
    currentBid = 0;
    currentBidder = null;
    currentBidderTurn = null;
    
    // Clear timers
    clearInterval(auctionTimer);
    clearTimeout(bidderTimeout);
    clearTimeout(confirmTimeout);
    
    // Initialize a fresh game
    initializeGame();
    
    // Notify any remaining players
    io.emit('notification', 'Game ended due to players leaving. Starting a new game.');
  }
}

// Run this check more frequently
setInterval(checkEmptyGame, 10000); // Check every 10 seconds
// Add to your server code
function checkGameStatus() {
  // Check if game is stuck
  if (gameState === 'auction' && players.filter(p => p.connected).length < 2) {
    console.log('Not enough players for auction, returning to waiting state');
    gameState = 'waiting';
    io.emit('notification', 'Not enough players to continue. Game paused.');
  }
  
  // ลบโค้ดที่บังคับเริ่ม auction ออก
  // ไม่ต้องมีส่วนนี้แล้ว:
  // if (gameState === 'cardSelection' && playerCards.size === players.filter(p => p.connected).length) {
  //   console.log('All connected players have selected cards, starting auction');
  //   gameState = 'auction';
  //   io.emit('gameState', 'auction');
  //   nextPokemon();
  // }
}

// Run every 30 seconds
setInterval(checkGameStatus, 30000);
// Add a function to reset the game
// Function to reset the game
// Function to reset the game
function resetGame() {
  // Clear votes
  resetVotes.clear();
  externalVoters.clear();
  clearTimeout(resetVoteTimeout);
  
  // Keep player data but reset game state
  players.forEach(player => {
    player.balance = 5000;
    player.collection = [];
    player.skipsLeft = 2;
    // Reset other player-specific game data as needed
  });
  
  // Reset game variables
  gameState = 'waiting';
  currentPokemon = null;
  currentBid = 0;
  currentBidder = null;
  currentBidderTurn = null;
  skipCount = 0;
  playerPositions = [];
  playerCards.clear();
  
  // Clear any active timers
  if (auctionTimer) clearInterval(auctionTimer);
  if (bidderTimeout) clearTimeout(bidderTimeout);
  if (confirmTimeout) clearTimeout(confirmTimeout);
  
  // Notify all clients
  io.emit('gameState', 'waiting');
  io.emit('notification', 'Game has been reset. Players can join now.');
}

// Process votes and check if reset should happen
// Process votes and check if reset should happen
function processResetVotes() {
  // Calculate how many votes are needed
  const connectedPlayers = players.filter(p => p.connected);
  const totalVoters = connectedPlayers.length + externalVoters.size;
  const votesNeeded = Math.max(2, Math.ceil(totalVoters / 2)); // At least 2 votes required
  
  // Notify all players and clients about the vote
  io.emit('resetVoteUpdate', {
    votes: resetVotes.size,
    needed: votesNeeded,
    voters: Array.from(resetVotes)
  });
  
  // If we have enough votes, reset the game
  if (resetVotes.size >= votesNeeded) {
    io.emit('notification', 'Game reset vote passed! Starting new game...');
    resetGame();
  }
  
  // Clear existing timeout and set a new one
  clearTimeout(resetVoteTimeout);
  resetVoteTimeout = setTimeout(() => {
    resetVotes.clear();
    externalVoters.clear();
    io.emit('resetVoteUpdate', { votes: 0, needed: votesNeeded, voters: [] });
    io.emit('notification', 'Reset vote expired.');
  }, 60000); // Votes expire after 1 minute
}


// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);
 // Setup heartbeat
 let heartbeatInterval = setInterval(() => {
  socket.emit('ping');
}, 30000);

// Add this in your io.on('connection', ...) handler
socket.on('yourTurnToPick', () => {
  const player = players.find(p => p.id === socket.id);
  if (!player) return;
  
  // Re-check if it's really this player's turn
  const eligiblePlayers = [...players]
    .filter(p => p.connected && p.collection.length < 6)
    .sort((a, b) => b.balance - a.balance);
  
  if (eligiblePlayers.length > 0 && eligiblePlayers[0].id === player.id) {
    socket.emit('yourTurnToPick');
  }
});

socket.on('pong', () => {
  // Player is still connected
  const player = players.find(p => p.id === socket.id);
  if (player) {
    player.lastHeartbeat = Date.now();
  }
});

 // Handle votes from players already in the game
 socket.on('voteReset', () => {
  const player = players.find(p => p.id === socket.id);
  if (!player) return;
  
  // Add this player's vote
  resetVotes.add(player.name);
  
  processResetVotes();
});
 // Handle votes from players on the login screen
 socket.on('voteResetFromJoinScreen', ({ playerName }) => {
  if (!playerName || playerName.trim() === '') return;
  
  // Add this player's vote (using name since they don't have a socket ID yet)
  resetVotes.add(playerName);
  externalVoters.add(playerName);
  
  processResetVotes();
});



socket.on('login', ({ name }, callback) => {
  // ตรวจสอบว่าเกมอยู่ในระหว่างดำเนินการหรือไม่
  const existingPlayerIndex = players.findIndex(p => p.name === name);
  
  if (existingPlayerIndex >= 0) {
    // ผู้เล่นที่มีอยู่กำลังเชื่อมต่อใหม่
    const reconnectingPlayer = players[existingPlayerIndex];
    reconnectingPlayer.id = socket.id; // อัปเดต socket ID
    
    // ส่งข้อมูลเกมปัจจุบันให้ผู้เล่น
    callback({ 
      success: true, 
      player: reconnectingPlayer,
      gameState,
      auctionState: gameState === 'auction' ? getAuctionState() : null,
      // ส่งข้อมูลการเลือกการ์ด ถ้าผู้เล่นเคยเลือกแล้ว
      cardValue: playerCards.has(reconnectingPlayer.id) ? playerCards.get(reconnectingPlayer.id) : null
    });
    
    // ถ้าอยู่ในช่วงเลือกการ์ดและผู้เล่นนี้เคยเลือกแล้ว ส่งข้อมูลการ์ดกลับไป
    if (gameState === 'cardSelection' && playerCards.has(reconnectingPlayer.id)) {
      socket.emit('cardRevealed', {
        playerId: reconnectingPlayer.id,
        cardIndex: 0, // ค่า default
        value: playerCards.get(reconnectingPlayer.id)
      });
    }
    
    console.log(`Player ${name} reconnected`);
  } else if (gameState !== 'waiting') {
    // ไม่อนุญาตให้ผู้เล่นใหม่เข้าร่วมระหว่างเกม
    callback({ success: false, message: 'Game already in progress. Please wait for the next round.' });
    return;
  } else {
    // สร้างผู้เล่นใหม่
    const newPlayer = {
      id: socket.id,
      name,
      balance: 5000,
      collection: [],
      skipsLeft: 2,
      bidPosition: null
    };
    players.push(newPlayer);
    callback({ success: true, player: newPlayer });
  }
});
  // เพิ่ม event listener สำหรับ pickPokemon ตรงนี้
  socket.on('pickPokemon', (data) => {
    console.log(`${socket.id} is trying to pick pokemon at index ${data.index}`);
    if (gameState === 'gameOver') {
      handlePick(socket, data);
    } else {
      console.log('Game is not in gameOver state:', gameState);
    }
  });

// In the socket.io connection section, add this new handler for pass
socket.on('passBid', () => {
  if (gameState !== 'auction') return;
  
  // Find the player
  const player = players.find(p => p.id === socket.id);
  if (!player) return;
  
  // Call handlePass function
  handlePass(player);
});

// And add the handlePass function:
function handlePass(player) {
  // Only allow passing if it's the player's turn
  if (currentBidderTurn !== player.name) {
    return;
  }
  
  io.emit('bidNotification', `${player.name} passed their turn.`);
  
  // Move to the next bidder (without removing this player from future rounds)
  setNextBidder();
}
   // Handle card selection
  // Update the selectCard event handler
  socket.on('selectCard', ({ cardIndex }, callback) => {
    if (gameState !== 'cardSelection') {
      callback({ success: false, message: 'Not in card selection phase' });
      return;
    }
    
    const player = players.find(p => p.id === socket.id);
    if (!player) {
      callback({ success: false, message: 'Player not found' });
      return;
    }
    
    // If player already has a card, don't allow selecting another
    if (playerCards.has(socket.id)) {
      callback({ success: false, message: 'You already selected a card' });
      return;
    }
    
    // Generate a random position (1-3) that hasn't been assigned yet
    let position;
    do {
      position = Math.floor(Math.random() * 3) + 1;
    } while (assignedPositions.has(position));
    
    // Assign the position to the player
    playerCards.set(socket.id, position);
    assignedPositions.add(position);
    
    // Send the card value back to the player
    socket.emit('cardRevealed', {
      playerId: socket.id,
      cardIndex,
      value: position
    });
    
    // Notify all players that someone selected a card and how many are remaining
    const connectedPlayers = players.filter(p => p.connected);
    const playersSelected = Array.from(playerCards.keys()).length;
    const playersRemaining = connectedPlayers.length - playersSelected;
    
    io.emit('notification', `${player.name} has selected a card. Waiting for ${playersRemaining} more player(s).`);
    
    // Check if all connected players have selected cards
    if (playersSelected >= connectedPlayers.length) {
      // Call checkCardsSelection to handle auction start logic
      checkCardsSelection();
    }
    
    callback({ success: true });
  });

// เพิ่ม event handler นี้
socket.on('startGame', () => {
  // ตรวจสอบว่าอยู่ในสถานะ waiting หรือไม่
  if (gameState !== 'waiting') {
    socket.emit('notification', 'Game is already in progress.');
    return;
  }
  
  // ตรวจสอบผู้เล่นให้มีอย่างน้อย 3 คน
  if (players.filter(p => p.connected).length < 3) {
    socket.emit('notification', 'Need at least 3 players to start the game.');
    return;
  }
  
  // เริ่มเฟสการเลือกการ์ด
  startAuction();
});

// Update the joinGame handler to ensure it doesn't trigger the timer prematurely
socket.on('joinGame', async ({ name }, callback) => {
  // Check for existing player by name
  const existingPlayerIndex = players.findIndex(p => p.name === name);
  
  if (existingPlayerIndex >= 0) {
    // Player is reconnecting
    const reconnectingPlayer = players[existingPlayerIndex];
    
    // Update socket ID and connection status
    const oldId = reconnectingPlayer.id;
    reconnectingPlayer.id = socket.id;
    reconnectingPlayer.connected = true;
    
    // Update player ID in playerPositions array if needed
    const posIndex = playerPositions.indexOf(oldId);
    if (posIndex >= 0) {
      playerPositions[posIndex] = socket.id;
    }
    
    // Update player ID in playerCards map if needed
    if (playerCards.has(oldId)) {
      const cardValue = playerCards.get(oldId);
      playerCards.delete(oldId);
      playerCards.set(socket.id, cardValue);
    }
    
    // If this player was the current bidder, update references
    if (currentBidder === reconnectingPlayer.name) {
      currentBidderTurn = reconnectingPlayer.name;
    }
    
    // Send current game state to reconnected player
    callback({ 
      success: true, 
      player: reconnectingPlayer,
      gameState,
      auctionState: gameState === 'auction' ? getAuctionState() : null,
      cardValue: playerCards.has(socket.id) ? playerCards.get(socket.id) : null
    });
    
    // If in card selection and player already selected, send card data
    if (gameState === 'cardSelection' && playerCards.has(socket.id)) {
      socket.emit('cardRevealed', {
        playerId: socket.id,
        cardIndex: 0, // Default value
        value: playerCards.get(socket.id)
      });
    }
    
    // If in auction and it was this player's turn, send turn notification
    if (gameState === 'auction' && currentBidderTurn === reconnectingPlayer.name) {
      socket.emit('yourTurnToBid');
    }
    
    console.log(`Player ${name} reconnected`);
    io.emit('notification', `${name} has reconnected to the game.`);
    
    return;
  } else if (gameState !== 'waiting') {
    // Don't allow new players to join during game
    callback({ success: false, message: 'Game already in progress. Please wait for the next round.' });
    return;
  } else {
    // Create new player
    const newPlayer = {
      id: socket.id,
      name,
      balance: 5000,
      collection: [],
      skipsLeft: 2,
      bidPosition: null,
      connected: true
    };
    
    players.push(newPlayer);
    callback({ success: true, player: newPlayer });
    
    // Notify all clients about new player
    io.emit('playerJoined', { 
      playerId: newPlayer.id, 
      playerName: newPlayer.name, 
      playerCount: players.length 
    });
  }
});
  
// Socket event handler for placeBid
socket.on('placeBid', ({ amount }) => {
  // Prevent bidding during confirmation phase
  if (gameState !== 'auction' || isConfirmationPhase) {
    if (isConfirmationPhase) {
      socket.emit('bidNotification', 'Bidding is paused during purchase confirmation.');
    }
    return;
  }
  
  // Find the player
  const player = players.find(p => p.id === socket.id);
  if (!player) return;
  
  // Use the handleBid function
  const result = handleBid(player, amount);
  
  // If there's an error, notify the player
  if (result && !result.success) {
    socket.emit('bidNotification', result.message);
  }
});
  
  // Handle player skipping an auction
  socket.on('skipBid', () => {
    if (gameState !== 'auction') return;
    
    // Find the player
    const player = players.find(p => p.id === socket.id);
    if (!player) return;
    
    // Call handleSkip function
    handleSkip(player);
  });
  
 // Fix the confirmPurchase socket event handler
socket.on('confirmPurchase', ({ confirm }) => {
  if (gameState !== 'auction') return;
  
  // Find the player
  const player = players.find(p => p.id === socket.id);
  if (!player) return;
  
  // Call the proper handler function and let it manage everything
  handlePurchaseConfirmation(player, confirm);
  
  // Remove all the duplicate code from here - don't process the purchase again
  // Don't call nextPokemon() here - it's already called in handlePurchaseConfirmation()
});
socket.on('disconnect', () => {
  console.log('User disconnected:', socket.id);
  clearInterval(heartbeatInterval);
  
  // Find and remove the player immediately
  const playerIndex = players.findIndex(p => p.id === socket.id);
  if (playerIndex >= 0) {
    const player = players[playerIndex];
    
    // Handle disconnection during auction if it's their turn
    if (gameState === 'auction' && currentBidderTurn === player.name) {
      // Auto-pass if it's their turn
      handlePass(player);
    }
    
    // Mark player as disconnected
    player.connected = false;
    
    // Remove immediately from players array
    players.splice(playerIndex, 1);
    
    // Remove from bidding order if present
    const posIndex = playerPositions.indexOf(socket.id);
    if (posIndex >= 0) {
      playerPositions.splice(posIndex, 1);
    }
    
    io.emit('bidNotification', `${player.name} has left the game.`);
    updateAuctionState();
    
    // Check if we should end the game immediately
    checkEmptyGame();
  }
});
});

// API routes
app.get('/api/game/status', (req, res) => {
  res.json({
    gameState,
    playerCount: players.length,
    pokemonLeft: auctionPool.length,
    poolPokemonCount: poolPokemon.length
  });
});

// Initialize the game when the server starts
initializeGame();

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
