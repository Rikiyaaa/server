const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');

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

mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://pokemons:20762newsa@cluster0.8uspm5l.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0', { 
  useNewUrlParser: true, 
  useUnifiedTopology: true
})
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('Could not connect to MongoDB', err));

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
let playerCards = new Map(); // Maps player IDs to their card values (1-3)
let playerPositions = []; // Array containing player IDs in bidding order
let assignedPositions = new Set(); // Keep track of assigned positions
let currentBidderIndex = 0; // Current bidder in the bidding cycle
let skippedPlayers = [];
let resetVotes = new Set();
let resetVoteTimeout = null;
let externalVoters = new Set(); // For players who voted from login screen
let cardSelectionTimeout = null;
let startAuctionVotes = new Set(); // เก็บรายชื่อผู้เล่นที่โหวตเริ่มประมูล
let auctionVoteTimeout = null; // timeout สำหรับการโหวต
let consecutivePasses = 0;

function initializeGame() {
  // รีเซ็ตสถานะเกม
  gameState = 'waiting';
  players = []; // ล้างข้อมูลผู้เล่นทั้งหมด
  currentPokemon = null;
  auctionPool = [];
  poolPokemon = [];
  currentBid = 0;
  currentBidder = null;
  currentBidderTurn = null;
  playerPositions = [];
  playerCards = new Map();
  assignedPositions = new Set();
  currentBidderIndex = 0;
  skippedPlayers = [];
  
  clearInterval(auctionTimer);
  clearTimeout(bidderTimeout);
  clearTimeout(confirmTimeout);
  if (cardSelectionTimeout) {
    clearTimeout(cardSelectionTimeout);
    cardSelectionTimeout = null;
  }
  
  fetchRandomPokemon(18).then(pokemon => {
    auctionPool = pokemon;
    
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
  
  io.emit('gameState', 'waiting');
  io.emit('notification', 'A new game is ready. Players can join now.');
}

async function fetchRandomPokemon(count = 18) {
  try {
    const totalPokemon = 898; // Total number of Pokemon in PokeAPI
    const randomIds = new Set();
    
    while (randomIds.size < count) {
      const id = Math.floor(Math.random() * totalPokemon) + 1;
      randomIds.add(id);
    }
    
    const pokemonPromises = Array.from(randomIds).map(async (id) => {
      const response = await axios.get(`https://pokeapi.co/api/v2/pokemon/${id}`);
      
      const statTotal = response.data.stats.reduce((sum, stat) => sum + stat.base_stat, 0);
      
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
function processStartAuctionVotes() {
  // ตรวจสอบว่าอยู่ในเฟสการเลือกการ์ดหรือไม่
  if (gameState !== 'cardSelection') return;
  
  const connectedPlayers = players.filter(p => p.connected);
  const votesNeeded = connectedPlayers.length; // Changed to require all players
  
  io.emit('auctionVoteUpdate', {
    votes: startAuctionVotes.size,
    needed: votesNeeded,
    voters: Array.from(startAuctionVotes)
  });
  
  if (startAuctionVotes.size >= votesNeeded) {
    // แจ้งเตือนว่าการโหวตสำเร็จ
    io.emit('notification', 'Vote passed! Auction will begin in 5 seconds...');
    
    clearTimeout(auctionVoteTimeout);
    
    setTimeout(() => {
      // เริ่มเฟสการประมูล
      gameState = 'auction';
      io.emit('gameState', 'auction');
      
      playerPositions = [];
      for (const player of players) {
        if (playerCards.has(player.id)) {
          playerPositions.push(player.id);
        }
      }
      playerPositions.sort((a, b) => {
        return playerCards.get(a) - playerCards.get(b);
      });
      
      players.forEach(player => {
        const position = playerPositions.indexOf(player.id) + 1;
        player.bidPosition = position;
      });
      // ล้างข้อมูลการโหวต
      startAuctionVotes.clear();

      nextPokemon();
    }, 5000);
  }
}
// เพิ่มฟังก์ชันใหม่เพื่อตรวจสอบว่าครบเงื่อนไขเริ่มประมูลหรือยัง
function checkCardsSelection() {
  if (gameState !== 'cardSelection') return;
  
  const connectedPlayers = players.filter(p => p.connected);
  const playersSelected = Array.from(playerCards.keys()).length;
  
  // Debug log to help diagnose the issue
  console.log(`Players selected cards: ${playersSelected}/${connectedPlayers.length}`);
  console.log('Player cards:', Array.from(playerCards.entries()));
  
  if (playersSelected >= connectedPlayers.length) {
    // All connected players have selected cards
    io.emit('notification', 'All players have selected cards! Vote to start the auction.');
    
    if (cardSelectionTimeout) {
      clearTimeout(cardSelectionTimeout);
      cardSelectionTimeout = null;
    }
    
    io.emit('showStartAuctionVote');
  }
}

function calculateRarity(pokemonData) {
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
  
  playerCards = new Map();
  assignedPositions = new Set();
  
  gameState = 'cardSelection';
  io.emit('selectCardsPhase');
  
  io.emit('notification', 'Please select your cards to determine bidding order!');
  
}

function getNextBidder() {

  if (!playerPositions.length || !players.length) {
    return null;
  }

  playerPositions = playerPositions.filter(id => players.some(p => p.id === id));
  
  if (playerPositions.length === 0) {
    playerPositions = players.map(p => p.id);
    currentBidderIndex = 0;
  }
  
  if (currentBidderIndex >= playerPositions.length) {
    currentBidderIndex = 0;
  }
  
  if (currentBidderIndex < 0 || currentBidderIndex >= playerPositions.length) {
    currentBidderIndex = 0;
  }
  
  const nextBidderId = playerPositions[currentBidderIndex];
  
  currentBidderIndex++;
  
  const player = players.find(p => p.id === nextBidderId);
  
  return player || null;
}

function nextPokemon() {
  if (auctionPool.length === 0) {
    endGame();
    return;
  }
  consecutivePasses = 0;

  io.emit('bidNotification', 'Next Pokemon will be revealed in 5 seconds...');
  
  setTimeout(() => {

    skippedPlayers = [];

    currentPokemon = auctionPool.pop();
    currentBid = currentPokemon.basePrice || 100;
    currentBidder = null;
    
    const anyPlayerCanAfford = players.some(player => player.balance >= currentBid);
    
    const isPreviewMode = !anyPlayerCanAfford;
    timeLeft = isPreviewMode ? 10 : 30; // Shorter preview time if no one can afford

    currentBidderIndex = 0;

    if (isPreviewMode) {
      io.emit('bidNotification', `No player can afford ${currentPokemon.name}. Preview mode activated (10s).`);
    } else {
      io.emit('bidNotification', `${currentPokemon.name} is now up for auction! Starting bid: ${currentBid} coins.`);
    }

    updateAuctionState();
    
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
    
    if (!isPreviewMode) {
      setNextBidder();
    } else {

      currentBidderTurn = null;
      io.emit('auctionUpdate', getAuctionState());
    }
  }, 3000); 
}

function handlePass(player) {

  if (currentBidderTurn !== player.name) {
    return;
  }
  
  io.emit('bidNotification', `${player.name} passed their turn.`);
  
  setNextBidder();
}

function setNextBidder() {
  if (players.length < 3) {
    io.emit('notification', 'Not enough players to continue. Game will be reset.');
    resetGame();
    return;
  }
  
  let nextEligibleBidder = null;
  let loopCheck = 0;
  let checkCount = 0;
  
  if (playerPositions.length > players.length) {
    playerPositions = players.map(p => p.id);
  }
  
  while (nextEligibleBidder === null && checkCount < players.length) {
    const potentialBidder = getNextBidder();
    checkCount++;
    
    if (!potentialBidder) {
      continue;
    }
    
    if (potentialBidder.balance >= currentBid && 
        (!skippedPlayers || !skippedPlayers.includes(potentialBidder.id))) {
      nextEligibleBidder = potentialBidder;
    } else if (potentialBidder.balance < currentBid) {
      io.emit('bidNotification', `${potentialBidder.name} can't afford the minimum bid and was skipped.`);
    }
    
    loopCheck++;
    if (loopCheck > players.length * 2) {
      break;
    }
  }
  
  if (nextEligibleBidder) {
    currentBidderTurn = nextEligibleBidder.name;

    io.emit('auctionUpdate', getAuctionState());

    io.to(nextEligibleBidder.id).emit('yourTurnToBid');

    clearTimeout(bidderTimeout);
  } else {

    currentBidderTurn = null;
    io.emit('bidNotification', `No players can afford ${currentPokemon?.name || 'this Pokemon'}. Preview mode active.`);
    io.emit('auctionUpdate', getAuctionState());
  }
}
function endAuction() {

  clearInterval(auctionTimer);
  clearTimeout(bidderTimeout);
  
  if (currentBidder) {

    const winner = players.find(p => p.name === currentBidder);
    
    if (winner) {

      isConfirmationPhase = true;

      updateAuctionState();

      io.to(winner.id).emit('confirmPurchase');

      clearTimeout(confirmTimeout);
      confirmTimeout = setTimeout(() => {

        handlePurchaseConfirmation(winner, true);
      }, 10000);

      io.emit('bidNotification', `${winner.name} is confirming purchase of ${currentPokemon.name}...`);
    } else {

      nextPokemon();
    }
  } else {
    io.emit('bidNotification', `No bids for ${currentPokemon.name}. Moving to next Pokémon.`);

    if (currentPokemon) {
      poolPokemon.push(currentPokemon);
    }
    nextPokemon();
  }
}

function handlePurchaseConfirmation(player, confirm) {
  clearTimeout(confirmTimeout);
  
  if (!isConfirmationPhase) return;
  
  isConfirmationPhase = false;
  
  if (confirm) {
    if (player.balance >= currentBid) {
  player.balance -= currentBid;
  player.collection.push(currentPokemon);
  
  const index = poolPokemon.findIndex(p => p && p.id === currentPokemon.id);
  if (index !== -1) {
    poolPokemon.splice(index, 1);
  }
  io.emit('bidNotification', `${player.name} purchased ${currentPokemon.name} for ${currentBid} coins!`);
  
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
    return { success: false, message: "It's not your turn to skip" };
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
  consecutivePasses = 0;
  
  // Update current bid and bidder
  currentBid = newBid;
  currentBidder = player.name;
  timeLeft = 30; // Reset timer on new bid
  
  // Clear the bidder timeout since a bid was placed
  clearTimeout(bidderTimeout);
  
  // Notify everyone about the bid
  io.emit('bidNotification', `${player.name} bid ${amount} coins. Total: ${currentBid}`);
  updateAuctionState();
  
  // Set next bidder
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
  // คำนวณมูลค่ารวมของคอลเลกชันของแต่ละผู้เล่น
  players.forEach(player => {
    let collectionValue = 0;
    player.collection.forEach(pokemon => {
      collectionValue += pokemon.basePrice || 100;
    });
    player.collectionValue = collectionValue;
    player.finalScore = collectionValue + player.balance;
  });
  
  // เรียงลำดับผู้เล่นตามคะแนนสุดท้าย
  const sortedPlayers = [...players].sort((a, b) => b.finalScore - a.finalScore);
  
  // ส่งผลลัพธ์เกมสุดท้าย
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
    remainingPoolPokemon: poolPokemon.filter(p => p !== null) // รวมเฉพาะ Pokemon ที่เหลือในพูล
  });
  
  // แจ้งผู้เล่นว่าเกมใหม่จะเริ่มในไม่ช้า
  io.emit('notification', 'Game complete! A new game will start shortly. You will need to join again.');
  
  // เริ่มเกมใหม่หลังจากดีเลย์
  setTimeout(() => {
    // ล้างข้อมูลเกมทั้งหมด รวมถึงผู้เล่น
    players = [];
    resetGame();
  }, 15000);
}
// Add to the server code to check for empty games
// แก้ไขฟังก์ชัน checkEmptyGame 
function checkEmptyGame() {
  // If no game is in progress, no need to check
  if (gameState === 'waiting') return;
  
  // If fewer than 3 players remaining, cancel the game
  if (players.length < 3) {
    console.log('Less than 3 players remaining, resetting game but keeping players');
    
    // Reset game but keep remaining players
    resetGame(true);
    
    // Notify remaining players
    io.emit('notification', 'Not enough players to continue. Game has been reset to waiting state.');
  }
}

// Run this check more frequently
setInterval(checkEmptyGame, 10000); // Check every 10 seconds
// Add to your server code
function checkGameStatus() {
  // Check if game is stuck
  if (gameState === 'auction' && players.filter(p => p.connected).length < 3) {
    console.log('Not enough players for auction, returning to waiting state');
    gameState = 'waiting';
    io.emit('notification', 'Not enough players to continue. Game paused.');
  }
  
  if (gameState === 'auction' && currentPokemon) {
    // ตรวจสอบว่ามีผู้เล่นที่สามารถประมูลได้หรือไม่
    const anyPlayerCanBid = players.some(p => p.balance >= currentBid);
    
    // ถ้าไม่มีผู้เล่นใดสามารถประมูลได้และเวลาน้อยกว่า 5 วินาที
    if (!anyPlayerCanBid && timeLeft < 5) {
      // บังคับให้เวลาหมดเพื่อไปยัง Pokemon ตัวถัดไป
      timeLeft = 0;
    }
  }
}

// Run every 30 seconds
setInterval(checkGameStatus, 10000);
// เพิ่มฟังก์ชันใหม่สำหรับการตรวจสอบการเชื่อมต่อของผู้เล่น
function checkPlayerConnections() {
  // ตรวจสอบเฉพาะเมื่อเกมกำลังดำเนินอยู่
  if (gameState === 'waiting') return;
  
  // กรองผู้เล่นที่ยังเชื่อมต่ออยู่
  const connectedPlayerIds = new Set(players.map(p => p.id));
  
  // ตรวจสอบว่าผู้ประมูลปัจจุบันยังคงเชื่อมต่ออยู่หรือไม่
  if (currentBidderTurn) {
    const currentPlayer = players.find(p => p.name === currentBidderTurn);
    if (!currentPlayer || !connectedPlayerIds.has(currentPlayer.id)) {
      // ผู้ประมูลปัจจุบันไม่ได้เชื่อมต่อแล้ว ให้เลื่อนไปยังผู้เล่นถัดไป
      io.emit('bidNotification', `${currentBidderTurn} is no longer connected. Moving to next player.`);
      setNextBidder();
    }
  }
}

// ตรวจสอบการเชื่อมต่อของผู้เล่นทุก 5 วินาที
setInterval(checkPlayerConnections, 5000);
// แก้ไขฟังก์ชัน resetGame 
function resetGame(keepPlayers = false) {
  // Clear votes
  resetVotes.clear();
  externalVoters.clear();
  startAuctionVotes.clear();
  clearTimeout(resetVoteTimeout);
  clearTimeout(auctionVoteTimeout);
  
  if (!keepPlayers) {
    // Clear all player data
    players = [];
  }
  
  // Reset game variables
  gameState = 'waiting';
  currentPokemon = null;
  auctionPool = [];
  poolPokemon = [];
  currentBid = 0;
  currentBidder = null;
  currentBidderTurn = null;
  skipCount = 0;
  playerPositions = [];
  playerCards.clear();
  assignedPositions.clear();
  skippedPlayers = [];
  consecutivePasses = 0;
  
  // Clear all running timers
  if (auctionTimer) clearInterval(auctionTimer);
  if (bidderTimeout) clearTimeout(bidderTimeout);
  if (confirmTimeout) clearTimeout(confirmTimeout);
  if (cardSelectionTimeout) clearTimeout(cardSelectionTimeout);
  cardSelectionTimeout = null;
  
  // Start new game
  if (keepPlayers) {
    initializeGameKeepPlayers();
  } else {
    initializeGame();
    // Notify everyone
    io.emit('gameState', 'waiting');
    io.emit('notification', 'Game has been reset. All players need to join again.');
  }
}

// Process votes and check if reset should happen
// Process votes and check if reset should happen
function processResetVotes() {
  // Always require exactly 2 votes to reset the game
  const votesNeeded = 2;
  
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

function initializeGameKeepPlayers() {
  // Reset game state but keep players
  gameState = 'waiting';
  currentPokemon = null;
  auctionPool = [];
  poolPokemon = [];
  currentBid = 0;
  currentBidder = null;
  currentBidderTurn = null;
  playerPositions = [];
  playerCards = new Map();
  assignedPositions = new Set();
  currentBidderIndex = 0;
  skippedPlayers = [];
  resetVotes.clear();
  startAuctionVotes.clear();
  
  clearInterval(auctionTimer);
  clearTimeout(bidderTimeout);
  clearTimeout(confirmTimeout);
  if (cardSelectionTimeout) {
    clearTimeout(cardSelectionTimeout);
    cardSelectionTimeout = null;
  }
  
  fetchRandomPokemon(18).then(pokemon => {
    auctionPool = pokemon;
    
    try {
      Game.findOneAndUpdate(
        {}, 
        { 
          state: gameState,
          players, // Keep existing players
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
  
  // Notify players the game is ready to start
  io.emit('gameState', 'waiting');
  io.emit('notification', 'The game has reset. Ready to start when you are!');
  
  // Tell remaining players how many more players needed
  const remainingPlayers = players.length;
  if (remainingPlayers < 3) {
    io.emit('notification', `We need ${3 - remainingPlayers} more player(s) to start.`);
  } else {
    io.emit('notification', 'We have enough players to start a new game!');
  }
}
function checkGameState() {
  const connectedPlayers = players.filter(p => p.connected);
  
  if (gameState === 'waiting' && connectedPlayers.length >= 3) {
    io.emit('notification', 'Enough players have joined. The game can start now!');
  } else if (gameState !== 'waiting' && connectedPlayers.length < 3) {
    io.emit('notification', 'Not enough players to continue. Game paused until more players join.');
    gameState = 'waiting';
    io.emit('gameState', 'waiting');
    io.emit('forceRejoin', true);
  }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);
 // Setup heartbeat
 let heartbeatInterval = setInterval(() => {
  socket.emit('ping');
}, 30000);
socket.on('voteStartAuction', () => {
  // ตรวจสอบว่าอยู่ในเฟสการเลือกการ์ดหรือไม่
  if (gameState !== 'cardSelection') {
    socket.emit('notification', 'Not in card selection phase');
    return;
  }
  
  // หาผู้เล่นที่โหวต
  const player = players.find(p => p.id === socket.id);
  if (!player) return;
  
  // เพิ่มการโหวตของผู้เล่นนี้
  startAuctionVotes.add(player.name);
  
  // แจ้งเตือนทุกคนว่ามีผู้เล่นโหวตเริ่มประมูล
  io.emit('notification', `${player.name} voted to start the auction.`);
  
  // ตั้ง timeout ให้การโหวตหมดอายุใน 60 วินาที
  clearTimeout(auctionVoteTimeout);
  auctionVoteTimeout = setTimeout(() => {
    startAuctionVotes.clear();
    io.emit('auctionVoteUpdate', { votes: 0, needed: 0, voters: [] });
    io.emit('notification', 'Start auction vote expired.');
  }, 60000);
  
  // ประมวลผลการโหวต
  processStartAuctionVotes();
});
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

  checkGameState();
  // Try to find an existing player by name (connected or disconnected)
  const existingPlayerIndex = players.findIndex(p => p.name === name);
  
  if (existingPlayerIndex >= 0) {
    // Existing player is reconnecting
    const reconnectingPlayer = players[existingPlayerIndex];
    reconnectingPlayer.id = socket.id; // Update socket ID
    reconnectingPlayer.connected = true; // Mark as connected again
    
    // Send current game data to the player
    callback({ 
      success: true, 
      player: reconnectingPlayer,
      gameState,
      auctionState: gameState === 'auction' ? getAuctionState() : null,
      // Send card selection data if player had selected a card
      cardValue: playerCards.has(reconnectingPlayer.name) ? playerCards.get(reconnectingPlayer.name) : null
    });
    
    // If in card selection phase and player had selected a card, send it back
    if (gameState === 'cardSelection' && playerCards.has(reconnectingPlayer.name)) {
      socket.emit('cardRevealed', {
        playerId: reconnectingPlayer.id,
        cardIndex: 0, // default value
        value: playerCards.get(reconnectingPlayer.name)
      });
    }
    
    // Update other players about reconnection
    io.emit('notification', `${reconnectingPlayer.name} has reconnected to the game.`);
    console.log(`Player ${name} reconnected`);
  } else if (gameState !== 'waiting') {
    // Don't allow new players during game
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
    io.emit('notification', `${name} has joined the game.`);
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

socket.on('passBid', () => {
  if (gameState !== 'auction') return;
  
  const player = players.find(p => p.id === socket.id);
  if (!player) return;
  
  handlePass(player);
});

function handlePass(player) {
  if (currentBidderTurn !== player.name) {
    return;
  }
  
  consecutivePasses++;
  
  io.emit('bidNotification', `${player.name} passed their turn. (${consecutivePasses}/3 consecutive passes)`);
  
  if (consecutivePasses >= 3) {
    io.emit('bidNotification', `No interest in ${currentPokemon.name} after 3 consecutive passes. Moving to pool.`);
    
    if (currentPokemon) {
      poolPokemon.push(currentPokemon);
    }
    
    clearInterval(auctionTimer);
    nextPokemon();
    return;
  }
  
  setNextBidder();
}
 // Change how selectCard stores card values
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
  
  // Use player name instead of socket.id
  if (playerCards.has(player.name)) {
    callback({ success: false, message: 'You already selected a card' });
    return;
  }
  
  let position;
  do {
    position = Math.floor(Math.random() * 3) + 1;
  } while (assignedPositions.has(position));
  
  // Store by player name, not socket ID
  playerCards.set(player.name, position);
  assignedPositions.add(position);
  
  socket.emit('cardRevealed', {
    playerId: socket.id,
    cardIndex,
    value: position
  });
  
  const connectedPlayers = players.filter(p => p.connected);
  const playersSelected = Array.from(playerCards.keys()).length;
  const playersRemaining = connectedPlayers.length - playersSelected;
  
  io.emit('notification', `${player.name} has selected a card. Waiting for ${playersRemaining} more player(s).`);
  
  if (playersSelected >= connectedPlayers.length) {
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
  
  if (players.filter(p => p.connected).length < 3) {
    socket.emit('notification', 'Need at least 3 players to start the game.');
    return;
  }
  
  startAuction();
});

socket.on('joinGame', async ({ name }, callback) => {

  
  if (gameState !== 'waiting') {
    // ไม่อนุญาตให้ผู้เล่นเข้าร่วมระหว่างเกม
    callback({ success: false, message: 'Game already in progress. Please wait for the next round.' });
    return;
  } else {
    // สร้างผู้เล่นใหม่เสม
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
    
    io.emit('playerJoined', { 
      playerId: newPlayer.id, 
      playerName: newPlayer.name, 
      playerCount: players.length 
    });
  }
  
   if (gameState === 'waiting' && players.length >= 3) {
    // เพิ่มดีเลย์เล็กน้อยก่อนเริ่มเกม
    setTimeout(() => {
      if (gameState === 'waiting' && players.length >= 3) {
        startAuction();
      }
    }, 5000);  // รอ 5 วินาทีเพื่อให้ผู้เล่นเพิ่มเติมสามารถเข้าร่วมได้
  }
});
  
socket.on('placeBid', ({ amount }) => {
  if (gameState !== 'auction' || isConfirmationPhase) {
    if (isConfirmationPhase) {
      socket.emit('bidNotification', 'Bidding is paused during purchase confirmation.');
    }
    return;
  }
  
  const player = players.find(p => p.id === socket.id);
  if (!player) return;
  
  const result = handleBid(player, amount);
  
  if (result && !result.success) {
    socket.emit('bidNotification', result.message);
  }
});
  
  socket.on('skipBid', () => {
    if (gameState !== 'auction') return;
    
    const player = players.find(p => p.id === socket.id);
    if (!player) return;
    
    handleSkip(player);
  });
  
socket.on('confirmPurchase', ({ confirm }) => {
  if (gameState !== 'auction') return;
  
  const player = players.find(p => p.id === socket.id);
  if (!player) return;
  
  handlePurchaseConfirmation(player, confirm);
  
});

socket.on('disconnect', () => {
  console.log('User disconnected:', socket.id);
  checkGameState();
  clearInterval(heartbeatInterval);
  
  // Find the disconnected player
  const playerIndex = players.findIndex(p => p.id === socket.id);
  if (playerIndex >= 0) {
    const player = players[playerIndex];
    
    // Instead of removing, just mark as disconnected
    player.connected = false;
    
    // Notify other players about the departure
    io.emit('bidNotification', `${player.name} has disconnected from the game.`);
    
    // If it's the current bidder's turn, move to next bidder
    if (currentBidderTurn === player.name) {
      io.emit('bidNotification', `${player.name} was the current bidder and has disconnected. Moving to next player.`);
      setNextBidder();
    }
    
    // Count active players
    const activePlayerCount = players.filter(p => p.connected).length;
    
    // Check if there are still enough players to continue the game
    if (activePlayerCount < 3 && gameState !== 'waiting') {
      io.emit('notification', 'Not enough active players to continue. Game will reset to waiting state.');
      
      // Transition to waiting state
      gameState = 'waiting';
      currentPokemon = null;
      auctionPool = [];
      poolPokemon = [];
      currentBid = 0;
      currentBidder = null;
      currentBidderTurn = null;
      playerPositions = [];
      skippedPlayers = [];
      
      // Clear any active timers
      clearInterval(auctionTimer);
      clearTimeout(bidderTimeout);
      clearTimeout(confirmTimeout);
      if (cardSelectionTimeout) {
        clearTimeout(cardSelectionTimeout);
        cardSelectionTimeout = null;
      }
      
      // Reset the game but KEEP THE REMAINING PLAYERS
      initializeGameKeepPlayers();
      
      // Tell ALL clients to go back to the waiting state
      io.emit('gameState', 'waiting');
      io.emit('forceRejoin', true);
    } else {
      // If still enough players, just update the auction state
      updateAuctionState();
    }
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
