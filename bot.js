require('dotenv').config(); // Load environment variables from .env file

const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('pg');
const express = require('express');
const crypto = require('crypto');
const {
    validateName,
    validateWishlist,
    validateNumber,
    validateRestrictionsInput,
    verifyWebhookRequest
} = require('./security');
const { isRateLimited } = require('./rateLimit');
const app = express();

// Add body parser for webhook
app.use(express.json());

// --- Configuration ---
// Load from environment variables
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminIdString = process.env.ADMIN_TELEGRAM_ID;
const isDevelopment = !process.env.RENDER;

// Validate required environment variables
if (!token) {
    console.error('FATAL ERROR: TELEGRAM_BOT_TOKEN environment variable is not set.');
    process.exit(1); // Exit if token is missing
}
if (!adminIdString) {
    console.warn('WARNING: ADMIN_TELEGRAM_ID environment variable is not set. Admin commands will not work.');
}

const ADMIN_USER_ID = parseInt(adminIdString || '0', 10); // Default to 0 if not set, isAdmin check handles NaN/0

// Database Configuration
let dbConfig;
if (process.env.DATABASE_URL) {
    // Use the connection URL directly for Neon database
    dbConfig = {
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    };
} else {
    // For local development, require DB_PASSWORD
    const dbPassword = process.env.DB_PASSWORD;
    if (!dbPassword) {
        console.error('FATAL ERROR: DB_PASSWORD environment variable is not set and DATABASE_URL is not provided.');
        process.exit(1);
    }
    
    dbConfig = {
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'secret_angel',
        password: dbPassword,
        port: parseInt(process.env.DB_PORT || '5432', 10),
    };
}

// Initialize database client
const client = new Client(dbConfig);

client.connect((err) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Connected to database');
    // Ensure tables exist in the correct order due to foreign keys

    // 1. Participants Table
    client.query('CREATE TABLE IF NOT EXISTS tg_participants (id SERIAL PRIMARY KEY, name TEXT UNIQUE, wishlist TEXT)', (err) => {
        if (err) {
            console.error('Error creating/checking tg_participants table:', err);
        } else {
            console.log('tg_participants table checked/created.');
            // 2. Groups Table
            client.query('CREATE TABLE IF NOT EXISTS tg_groups (group_id SERIAL PRIMARY KEY, group_name TEXT NOT NULL)', (err) => {
                if (err) {
                    console.error('Error creating/checking tg_groups table:', err);
                } else {
                    console.log('tg_groups table checked/created.');
                    // 3. Group Members Table (Links participants to groups)
                    client.query(`
                        CREATE TABLE IF NOT EXISTS tg_group_members (
                            membership_id SERIAL PRIMARY KEY,
                            group_id INTEGER NOT NULL REFERENCES tg_groups(group_id) ON DELETE CASCADE,
                            participant_id INTEGER NOT NULL REFERENCES tg_participants(id) ON DELETE CASCADE,
                            UNIQUE (group_id, participant_id)
                        )
                    `, (err) => {
                        if (err) {
                            console.error('Error creating/checking tg_group_members table:', err);
                        } else {
                            console.log('tg_group_members table checked/created.');
                            // 4. Assignments Table
                            client.query(`
                                CREATE TABLE IF NOT EXISTS tg_assignments (
                                    assignment_id SERIAL PRIMARY KEY,
                                    group_id INTEGER NOT NULL REFERENCES tg_groups(group_id) ON DELETE CASCADE,
                                    giver_participant_id INTEGER NOT NULL REFERENCES tg_participants(id) ON DELETE CASCADE,
                                    receiver_participant_id INTEGER NOT NULL REFERENCES tg_participants(id) ON DELETE CASCADE,
                                    UNIQUE (group_id, giver_participant_id)
                                )
                            `, (err) => {
                                if (err) {
                                    console.error('Error creating/checking tg_assignments table:', err);
                                } else {
                                    console.log('tg_assignments table checked/created.');
                                }
                            });
                        }
                    });
                }
            });
        }
    });
  }
});

// Configure bot options based on environment
const botOptions = isDevelopment ? 
  { polling: true } : 
  { webHook: { port: process.env.PORT || 10000 } };

// Initialize bot with appropriate configuration
const bot = new TelegramBot(token, botOptions);

// Set up webhook for production environment
if (!isDevelopment) {
  // Get the Render external URL and remove any trailing slash
  const externalUrl = process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  // Set webhook path
  const webhookPath = `/webhook/${token}`;
  // Construct the full webhook URL
  const webhookUrl = `https://${externalUrl}${webhookPath}`;
  
  // Set webhook
  bot.setWebHook(webhookUrl).then(() => {
    console.log(`Webhook set successfully to ${webhookUrl}`);
  }).catch((error) => {
    console.error('Failed to set webhook:', error);
  });

  // Handle webhook route with verification
  app.post(webhookPath, (req, res) => {
    // Verify the webhook request is from Telegram
    if (!verifyWebhookRequest(req, token)) {
      console.warn('Invalid webhook request received');
      res.status(403).send('Forbidden');
      return;
    }
    
    bot.handleUpdate(req.body);
    res.sendStatus(200);
  });
} else {
  console.log('Running in development mode with polling');
}

// --- Set Bot Commands for Telegram Menu ---
const userCommands = [
    { command: '/start', description: 'Show welcome message' },
    { command: '/register', description: 'Register as a participant' },
    { command: '/myassignment', description: 'Check who you are gifting to' },
    // Add /help later if needed
];

const adminCommands = [
    { command: '/participants', description: '(Admin) List all participants' },
    { command: '/creategroups', description: '(Admin) Create groups and assign angels' },
    { command: '/cleardata', description: '(Admin) Clear all bot data (requires confirmation)' },
];

// Combine commands - everyone sees all, but execution is restricted
const allCommands = [...userCommands, ...adminCommands];

bot.setMyCommands(allCommands)
    .then(() => console.log('Bot commands set successfully.'))
    .catch((error) => console.error('Error setting bot commands:', error));
// -----------------------------------------

// --- Helper Function for Admin Check ---
function isAdmin(userId) {
    if (!ADMIN_USER_ID || isNaN(ADMIN_USER_ID)) {
        console.warn('Admin User ID is not configured correctly in bot.js!');
        return false;
    }
    return userId === ADMIN_USER_ID;
}
// -------------------------------------

// --- Utility Functions (Copied from Web App Backend) ---

/**
 * Shuffles array in place using cryptographically secure randomness.
 * Uses crypto.randomInt() instead of Math.random() to prevent predictability attacks.
 * @param {Array} array items An array containing the items.
 */
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [array[i], array[j]] = [array[j], array[i]];
    }
}

/**
 * Assigns participants to groups randomly.
 * @param {string[]} participants - Array of participant names.
 * @param {number} numGroups - The number of groups to create.
 * @returns {Array<string[]>} - An array of groups, where each group is an array of participants.
 */
function assignParticipantsToGroups(participants, numGroups) {
    if (!participants || participants.length === 0) {
        return [];
    }

    if (numGroups < 1) {
        throw new Error('Number of groups must be at least 1.');
    }
    if (numGroups > participants.length) {
        // Ensure each group can have at least one member
        throw new Error('Number of groups cannot exceed the number of participants.');
    }

    const shuffledParticipants = [...participants];
    shuffle(shuffledParticipants);

    const groups = [];
    const baseParticipantsPerGroup = Math.floor(participants.length / numGroups);
    const remainder = participants.length % numGroups;

    let startIndex = 0;
    for (let i = 0; i < numGroups; i++) {
        let groupSize = baseParticipantsPerGroup + (i < remainder ? 1 : 0);
        // Ensure group size is at least 1 (should be guaranteed by initial checks)
        if (groupSize === 0 && participants.length > 0) groupSize = 1;

        const group = shuffledParticipants.slice(startIndex, startIndex + groupSize);
        if (group.length > 0) { // Only add non-empty groups
             groups.push(group);
        }
        startIndex += groupSize;
    }

    // Filter out any potentially empty groups if logic somehow allowed it
    return groups.filter(g => g.length > 0);
}

/**
 * Checks if a proposed assignment violates any restrictions.
 * @param {string} giver - The participant giving the gift.
 * @param {string} receiver - The participant receiving the gift.
 * @param {Array<string[]>} restrictions - Array of restricted pairs [ [p1, p2], ... ].
 * @returns {boolean} - True if the assignment is restricted, false otherwise.
 */
function isRestricted(giver, receiver, restrictions) {
    if (!restrictions) return false;
    for (const pair of restrictions) {
        // Ensure pair is valid before checking
        if (pair && pair.length === 2) {
            if ((pair[0] === giver && pair[1] === receiver) || (pair[0] === receiver && pair[1] === giver)) {
                return true; // This specific assignment is restricted
            }
        }
    }
    return false;
}

/**
 * Assigns Secret Angels within a group, respecting restrictions.
 * Each participant is assigned to give a gift to exactly one other participant.
 * No participant is assigned to themselves.
 * No restricted pairs are assigned.
 * @param {string[]} group - An array of participant names in the group.
 * @param {Array<string[]>} [restrictions=[]] - Optional array of restricted pairs.
 * @returns {Array<{giver: string, receiver: string}>} - An array of assignment objects.
 * @throws {Error} if the group has fewer than 2 participants or if a valid assignment cannot be found within retry limits.
 */
function assignSecretAngels(group, restrictions = []) {
    if (!group || group.length < 2) {
        // If a group has 0 or 1 members, no assignments are possible. Return empty.
        // This can happen if numGroups is high relative to participants.
        // The calling logic should handle potentially empty assignment results.
        console.warn(`Skipping assignment for group with ${group ? group.length : 0} members.`);
        return []; // Return empty array for groups < 2
    }

    const n = group.length;
    const maxRetries = 100; // Limit attempts to avoid infinite loops with impossible restrictions
    let attempts = 0;

    while (attempts < maxRetries) {
        attempts++;
        const shuffledGroup = [...group];
        shuffle(shuffledGroup);

        const potentialMatches = [];
        let isValid = true;

        for (let i = 0; i < n; i++) {
            const giver = shuffledGroup[i];
            const receiver = shuffledGroup[(i + 1) % n]; // Assign to the next person

            // Check for self-assignment (shouldn't happen with % n if n >= 2, but good check)
            if (giver === receiver) {
                isValid = false;
                console.warn('Self-assignment detected during shuffle, retrying...');
                break;
            }

            // Check restrictions
            if (isRestricted(giver, receiver, restrictions)) {
                isValid = false;
                // console.log(`Restriction violated (${giver}, ${receiver}), retrying shuffle... Attempt ${attempts}`);
                break; // No need to check further, this shuffle is invalid
            }

            potentialMatches.push({ giver: giver, receiver: receiver });
        }

        if (isValid) {
            console.log(`Valid assignment found for group [${group.join(', ')}] after ${attempts} attempt(s).`);
            return potentialMatches; // Found a valid assignment
        }
    }

    // If loop finishes without returning, assignment failed
    throw new Error(`Could not find a valid assignment for group [${group.join(', ')}] respecting restrictions after ${maxRetries} attempts. Please review restrictions or participants.`);
}

// --- End Utility Functions ---

// --- State Management (Simple) ---
// To keep track of what the bot is asking the user
const userState = {}; // { chatId: { state: 'awaiting_name'/'awaiting_wishlist'/'awaiting_name_for_assignment'/'awaiting_num_groups'/'awaiting_restrictions', name: '...', participantCount: 0, numGroups: 0 } }
// ---------------------------------

// --- Basic Bot Logic ---
console.log('Telegram bot started...');

// Simple message handler to check if the bot is alive
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Welcome to the Secret Angel Bot! Use /register to sign up.');
  delete userState[chatId]; // Clear any previous state
});

// --- Registration Command ---
bot.onText(/\/register/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id; // Use Telegram User ID for potential future linking

    // Rate limiting check
    if (isRateLimited(userId)) {
        bot.sendMessage(chatId, "You're sending requests too quickly. Please wait a moment before trying again.");
        return;
    }

    // Check if user is already registered (using name for now, like web app)
    // A more robust check might involve storing telegram_id in the DB
    // For now, we just start the registration flow.

    bot.sendMessage(chatId, "Okay, let's get you registered! What's your name?");
    userState[chatId] = { state: 'awaiting_name' };
});
// --------------------------

// --- Assignment Command ---
bot.onText(/\/myassignment/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Rate limiting check
    if (isRateLimited(userId)) {
        bot.sendMessage(chatId, "You're sending requests too quickly. Please wait a moment before trying again.");
        return;
    }

    // Ask for the name they registered with
    bot.sendMessage(chatId, "Okay, let's find your assignment. What name did you register with?");
    userState[chatId] = { state: 'awaiting_name_for_assignment' };
});
// ------------------------

// --- Admin Commands ---

// /participants - List all registered participants (Admin only)
bot.onText(/\/participants/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Rate limiting check
    if (isRateLimited(userId)) {
        bot.sendMessage(chatId, "You're sending requests too quickly. Please wait a moment before trying again.");
        return;
    }

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, "Sorry, this command is for admins only.");
        return;
    }

    try {
        const result = await client.query('SELECT name, wishlist FROM tg_participants ORDER BY name'); // Order alphabetically
        if (result.rows.length === 0) {
            bot.sendMessage(chatId, "No participants have registered yet.");
            return;
        }

        let message = "*Registered Participants:\n\n";
        result.rows.forEach((p, index) => {
            message += `${index + 1}. *${p.name}*\n   Wishlist: ${p.wishlist || '-'}\n`;
        });

        // Telegram messages have a length limit (4096 chars)
        // For very long lists, pagination would be needed.
        if (message.length > 4096) {
             message = message.substring(0, 4090) + "\n... (list truncated)";
        }

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('Error fetching tg_participants for admin:', error);
        bot.sendMessage(chatId, 'Sorry, something went wrong while fetching the participant list.');
    }
});

// /cleardata - Clear all participant, group, and assignment data (Admin only)
bot.onText(/\/cleardata/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Rate limiting check
    if (isRateLimited(userId)) {
        bot.sendMessage(chatId, "You're sending requests too quickly. Please wait a moment before trying again.");
        return;
    }

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, "Sorry, this command is for admins only.");
        return;
    }

    // Ask for confirmation
    bot.sendMessage(chatId, "⚠️ *WARNING:* Are you sure you want to clear ALL participant, group, and assignment data? This cannot be undone. Reply with 'yes' to confirm.", { parse_mode: 'Markdown' });
    userState[chatId] = { state: 'awaiting_clear_confirmation' };
});

// /creategroups - Create groups and assignments (Admin only)
bot.onText(/\/creategroups/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Rate limiting check
    if (isRateLimited(userId)) {
        bot.sendMessage(chatId, "You're sending requests too quickly. Please wait a moment before trying again.");
        return;
    }

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, "Sorry, this command is for admins only.");
        return;
    }

    // Check if there are enough participants first
    try {
        const countResult = await client.query('SELECT id, name FROM tg_participants'); // Fetch names too for validation later
        const participants = countResult.rows;
        const participantCount = participants.length;

        if (participantCount < 2) {
            bot.sendMessage(chatId, "You need at least 2 registered participants to create groups.");
            return;
        }

        bot.sendMessage(chatId, `There are ${participantCount} participants. How many groups do you want to create?`);
        userState[chatId] = { state: 'awaiting_num_groups', participantCount: participantCount, participants: participants }; // Store participants for later use

    } catch (error) {
        console.error('Error fetching tg_participants for /creategroups:', error);
        bot.sendMessage(chatId, 'Sorry, something went wrong before starting group creation.');
    }
});

// ---------------------

// Listener for any message (for debugging and handling registration/assignment steps)
bot.on('message', async (msg) => { // Make the handler async to use await for DB queries
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from.id; // Get userId for admin checks in state handling

    // Rate limiting check
    if (isRateLimited(userId)) {
        bot.sendMessage(chatId, "You're sending requests too quickly. Please wait a moment before trying again.");
        return;
    }

    // Ignore commands in the general message handler
    if (text && text.startsWith('/')) {
        console.log(`Received command from ${msg.from.username || msg.from.first_name}: ${text}`);
        // Clear state if user issues a new command mid-flow
        if (userState[chatId]) {
             console.log(`Clearing state for chat ${chatId} due to new command.`);
             delete userState[chatId];
        }
        return;
    }

    console.log(`Received message from ${msg.from.username || msg.from.first_name}: ${text}`);

    // Handle steps based on state
    if (userState[chatId]) {
        const stateData = userState[chatId];
        const state = stateData.state;

        if (state === 'awaiting_name') {
            // Validate and sanitize the name
            const sanitizedName = validateName(text);
            
            if (!sanitizedName) {
                bot.sendMessage(chatId, "Please provide a valid name (alphanumeric characters, spaces, hyphens, and underscores only, max 100 characters).");
                return;
            }
            
            userState[chatId].name = sanitizedName;
            userState[chatId].state = 'awaiting_wishlist';
            bot.sendMessage(chatId, `Got it, ${sanitizedName}! Now, what's on your wishlist? (Optional, just press Enter or send 'skip' if none)`);
        } else if (state === 'awaiting_wishlist') {
            const name = userState[chatId].name;
            // Validate and sanitize the wishlist
            let sanitizedWishlist = '';
            if (text.toLowerCase() !== 'skip') {
                sanitizedWishlist = validateWishlist(text);
            }

            // --- Save to Database ---
            client.query('INSERT INTO tg_participants (name, wishlist) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET wishlist = EXCLUDED.wishlist', [name, sanitizedWishlist], (err, result) => { // Allow re-registering to update wishlist
                if (err) {
                    console.error('Error inserting tg_participant via bot:', err);
                    // Don't expose detailed DB errors to user
                    bot.sendMessage(chatId, 'Sorry, there was an error trying to register you. Please try again later.');
                // } else if (result.rowCount === 0) { // This check is no longer needed with DO UPDATE
                //      // This means the name already existed (ON CONFLICT DO NOTHING)
                //      bot.sendMessage(chatId, `It seems a participant named "${name}" is already registered. If this wasn't you, please use a different name or contact the admin.`);
                } else {
                    console.log(`Participant ${name} registered/updated via bot with wishlist: ${sanitizedWishlist || 'none'}.`);
                    bot.sendMessage(chatId, `Great! You're registered as "${name}". ${sanitizedWishlist ? 'Your wishlist is saved/updated.' : 'Your wishlist is cleared.'} You can use /myassignment later to check your Secret Angel.`);
                }
                // Clear state after completion or error
                delete userState[chatId];
            });
            // ------------------------
        } else if (state === 'awaiting_name_for_assignment') {
            // Validate and sanitize the name
            const sanitizedName = validateName(text);
            
            if (!sanitizedName) {
                bot.sendMessage(chatId, "Please provide a valid name (alphanumeric characters, spaces, hyphens, and underscores only, max 100 characters).");
                return;
            }

            // --- Query Database for Assignment ---
            try {
                const query = `
                    SELECT 
                        receiver.name AS receiver_name, 
                        receiver.wishlist AS receiver_wishlist
                    FROM tg_assignments a
                    JOIN tg_participants giver ON a.giver_participant_id = giver.id
                    JOIN tg_participants receiver ON a.receiver_participant_id = receiver.id
                    WHERE lower(giver.name) = lower($1); -- Case-insensitive check
                `;
                const result = await client.query(query, [sanitizedName]);

                if (result.rows.length > 0) {
                    const assignment = result.rows[0];
                    const receiverName = assignment.receiver_name;
                    const receiverWishlist = assignment.receiver_wishlist || 'No wishlist provided.'; // Handle empty wishlist
                    bot.sendMessage(chatId, `Okay, ${sanitizedName}, you are the Secret Angel for: *${receiverName}*!\n\nTheir wishlist: \n${receiverWishlist}`, { parse_mode: 'Markdown' });
                } else {
                    // Check if the participant exists but just doesn't have an assignment yet
                    const participantCheck = await client.query('SELECT 1 FROM tg_participants WHERE lower(name) = lower($1)', [sanitizedName]); // Case-insensitive check
                    if (participantCheck.rows.length > 0) {
                        bot.sendMessage(chatId, `Hi ${sanitizedName}, it looks like assignments haven't been made yet, or you weren't included in the latest round. Please check back later or contact the admin.`);
                    } else {
                        bot.sendMessage(chatId, `Sorry, I couldn't find a registration for the name "${sanitizedName}" (case-insensitive). Please make sure you entered it correctly or use /register first.`);
                    }
                }
            } catch (error) {
                console.error(`Error fetching assignment for ${sanitizedName} (chatId: ${chatId}):`, error);
                bot.sendMessage(chatId, 'Sorry, something went wrong while fetching your assignment. Please try again later.');
            }
            // -------------------------------------

            // Clear state after handling
            delete userState[chatId];
        } else if (state === 'awaiting_clear_confirmation') {
            if (!isAdmin(userId)) {
                // Safety check: only admin can confirm
                bot.sendMessage(chatId, "Confirmation error. Only the admin can confirm data clearing.");
                delete userState[chatId];
                return;
            }

            if (text && text.toLowerCase() === 'yes') {
                try {
                    // Use TRUNCATE on specific tables for the bot
                    await client.query('TRUNCATE TABLE tg_participants, tg_groups, tg_group_members, tg_assignments RESTART IDENTITY CASCADE');
                    bot.sendMessage(chatId, '✅ All Telegram bot participant, group, and assignment data has been cleared.');
                    console.log(`Admin ${userId} cleared all Telegram bot data.`);
                } catch (error) {
                    console.error('Error clearing Telegram bot data:', error);
                    bot.sendMessage(chatId, '❌ Failed to clear Telegram bot data. Please check the bot logs.');
                }
            } else {
                bot.sendMessage(chatId, 'Data clearing cancelled.');
            }
            // Clear state regardless of confirmation outcome
            delete userState[chatId];
        } else if (state === 'awaiting_num_groups') {
            if (!isAdmin(userId)) {
                bot.sendMessage(chatId, "State error. Only the admin can specify the number of groups.");
                delete userState[chatId];
                return;
            }

            // Validate the number of groups
            const numGroups = validateNumber(text, 1, stateData.participantCount);
            
            if (numGroups === null) {
                bot.sendMessage(chatId, `Please enter a valid number between 1 and ${stateData.participantCount} for the groups.`);
                return;
            }

            // Store numGroups and transition to asking for restrictions
            userState[chatId].numGroups = numGroups;
            userState[chatId].state = 'awaiting_restrictions';
            bot.sendMessage(chatId, `Okay, ${numGroups} groups. Now, please enter the restricted pairs, one pair per line, comma-separated (e.g., Alice, Bob). Send 'none' or just press Enter if there are no restrictions.`);

        } else if (state === 'awaiting_restrictions') {
             if (!isAdmin(userId)) {
                bot.sendMessage(chatId, "State error. Only the admin can provide restrictions.");
                delete userState[chatId];
                return;
            }

            const participants = stateData.participants; // Get participants fetched earlier {id, name}
            const participantNames = participants.map(p => p.name);
            const participantMap = new Map(participants.map(p => [p.name, p.id])); // Map name to ID
            const numGroups = stateData.numGroups;

            // Validate restrictions input
            const restrictions = validateRestrictionsInput(text, participantNames);
            
            if (restrictions === null) {
                bot.sendMessage(chatId, "Invalid restrictions format. Please enter pairs as 'Name1, Name2' (one per line), or send 'none'. Participant names must match exactly.");
                return; // Keep state as awaiting_restrictions
            }

            bot.sendMessage(chatId, `Got it. Processing ${numGroups} groups with ${restrictions.length} restriction pair(s)...`);
            delete userState[chatId]; // Clear state before starting the process

            // --- Perform Group Creation and Assignment ---
            try {
                // Clear previous groups and assignments first within a transaction
                await client.query('BEGIN'); // Start transaction
                await client.query('TRUNCATE TABLE tg_groups, tg_group_members, tg_assignments RESTART IDENTITY CASCADE');
                console.log(`Admin ${userId} cleared previous group/assignment data before creating new ones.`);

                // Split names into groups using the local function
                const createdGroupsByName = assignParticipantsToGroups(participantNames, numGroups);

                let assignmentsSummary = '';
                let totalAssignments = 0;
                let allGroupsProcessedSuccessfully = true;

                for (let i = 0; i < createdGroupsByName.length; i++) {
                    const groupNames = createdGroupsByName[i];
                    const groupName = `Secret Angel Group ${i + 1}`;

                    if (groupNames.length < 2) {
                        console.warn(`Skipping group ${i+1} because it has fewer than 2 members: [${groupNames.join(', ')}]`);
                        assignmentsSummary += `\n*${groupName}* (${groupNames.length} members): Skipped (requires at least 2 members for assignments)\n`;
                        continue; // Skip assignment and DB operations for this group
                    }

                    assignmentsSummary += `\n*${groupName}* (${groupNames.length} members):\n`;

                    // Match within the group using the local function and parsed restrictions
                    let matches; // Will be array of {giver, receiver} objects
                    try {
                        matches = assignSecretAngels(groupNames, restrictions);
                    } catch (matchError) {
                        // If matching fails for *any* group, abort the whole operation
                        await client.query('ROLLBACK'); // Rollback transaction on matching error
                        console.error(`Matching failed for group ${groupName} via bot:`, matchError);
                        bot.sendMessage(chatId, `❌ Failed to create assignments for group ${i + 1} (${groupNames.join(', ')}). Error: ${matchError.message}. No changes were saved.`);
                        allGroupsProcessedSuccessfully = false;
                        break; // Exit the loop
                    }

                    if (!allGroupsProcessedSuccessfully) break; // Exit if previous iteration failed

                    if (matches.length === 0 && groupNames.length >= 2) {
                         // This case should ideally be caught by assignSecretAngels throwing an error,
                         // but handle defensively. Abort the operation.
                         await client.query('ROLLBACK');
                         console.error(`Matching returned empty for group ${groupName} with ${groupNames.length} members.`);
                         bot.sendMessage(chatId, `❌ An unexpected error occurred during matching for group ${i + 1}. No changes were saved.`);
                         allGroupsProcessedSuccessfully = false;
                         break; // Exit the loop
                    }

                    // Insert group
                    const groupInsertResult = await client.query('INSERT INTO tg_groups (group_name) VALUES ($1) RETURNING group_id', [groupName]);
                    const groupId = groupInsertResult.rows[0].group_id;

                    // Insert members
                    for (const name of groupNames) {
                        const participantId = participantMap.get(name);
                        if (participantId === undefined) {
                             await client.query('ROLLBACK');
                             console.error(`Could not find ID for participant name "${name}" in map.`);
                             bot.sendMessage(chatId, `❌ Internal error: Could not map participant name "${name}" to ID. No changes were saved.`);
                             allGroupsProcessedSuccessfully = false;
                             break; // Exit inner loop
                        }
                        await client.query('INSERT INTO tg_group_members (group_id, participant_id) VALUES ($1, $2)', [groupId, participantId]);
                    }
                    if (!allGroupsProcessedSuccessfully) break; // Exit outer loop if inner loop failed

                    // Insert assignments
                    for (const match of matches) {
                        const giverId = participantMap.get(match.giver);
                        const receiverId = participantMap.get(match.receiver);
                         if (giverId === undefined || receiverId === undefined) {
                             await client.query('ROLLBACK');
                             console.error(`Could not find ID for giver "${match.giver}" or receiver "${match.receiver}" in map.`);
                             bot.sendMessage(chatId, `❌ Internal error: Could not map assignment names to IDs. No changes were saved.`);
                             allGroupsProcessedSuccessfully = false;
                             break; // Exit inner loop
                         }
                        await client.query('INSERT INTO tg_assignments (group_id, giver_participant_id, receiver_participant_id) VALUES ($1, $2, $3)', [groupId, giverId, receiverId]);
                        assignmentsSummary += `  - ${match.giver} -> ${match.receiver}\n`;
                        totalAssignments++;
                    }
                    if (!allGroupsProcessedSuccessfully) break; // Exit outer loop if inner loop failed

                } // End loop through groups

                // Only commit if all groups were processed without error
                if (allGroupsProcessedSuccessfully) {
                    await client.query('COMMIT'); // Commit transaction
                    console.log(`Admin ${userId} created ${createdGroupsByName.length} groups and ${totalAssignments} assignments via bot.`);
                    bot.sendMessage(chatId, `✅ Successfully created ${createdGroupsByName.length} groups and ${totalAssignments} assignments!\n${assignmentsSummary}`, { parse_mode: 'Markdown' });
                } else {
                    // Rollback should have happened already, but ensure state is clean
                    console.log("Group creation process aborted due to errors. Rollback attempted.");
                    // Message indicating failure was already sent inside the loop/catch block
                }

            } catch (error) {
                // Catch any unexpected errors during the process (e.g., DB connection issues)
                try { await client.query('ROLLBACK'); } catch (rbError) { console.error("Rollback failed:", rbError); }
                console.error('Error during group creation/assignment transaction via bot:', error);
                bot.sendMessage(chatId, `❌ An unexpected error occurred: ${error.message}. No changes were saved.`);
            }
            // -------------------------------------------------------------------
            // Clear state regardless of confirmation outcome
            delete userState[chatId];
        } else if (state === 'awaiting_num_groups') {
            if (!isAdmin(userId)) {
                bot.sendMessage(chatId, "State error. Only the admin can specify the number of groups.");
                delete userState[chatId];
                return;
            }

            const numGroups = parseInt(text.trim(), 10);
            const participantCount = stateData.participantCount;

            if (isNaN(numGroups) || numGroups <= 0) {
                bot.sendMessage(chatId, "Please enter a valid positive number for the groups.");
                return;
            }
            if (numGroups > participantCount) {
                bot.sendMessage(chatId, `You cannot create more groups (${numGroups}) than participants (${participantCount}). Please enter a smaller number.`);
                return;
            }

            bot.sendMessage(chatId, `Okay, creating ${numGroups} groups...`);
            delete userState[chatId]; // Clear state before starting the process

            // --- Perform Group Creation and Assignment (similar to server.js) ---
            try {
                // Import necessary functions (ensure paths are correct)
                // Note: Direct require might not work if bot.js is run from a different CWD.
                // Consider restructuring or using a shared module if issues arise.
                // TODO: Implement or import local grouping and matching logic
                // const { assignParticipantsToGroups } = require('./grouping'); // Example path
                // const { assignSecretAngels } = require('./matching'); // Example path

                // Retrieve participants with IDs
                const participantResult = await client.query('SELECT id, name FROM tg_participants ORDER BY id');
                const participants = participantResult.rows;
                const participantNames = participants.map(p => p.name);
                const participantMap = new Map(participants.map(p => [p.name, p.id]));

                // Split names into groups
                // TODO: Replace with actual grouping logic
                bot.sendMessage(chatId, "🚧 Grouping logic not yet implemented in standalone bot.");
                await client.query('ROLLBACK'); // Ensure transaction is closed
                return;
                // const createdGroupsByName = assignParticipantsToGroups(participantNames, numGroups);

                // Start DB Transaction
                await client.query('BEGIN');
                let assignmentsSummary = '';

                for (let i = 0; i < createdGroupsByName.length; i++) {
                    const groupNames = createdGroupsByName[i];
                    const groupName = `Secret Angel Group ${i + 1}`;
                    assignmentsSummary += `\n*${groupName}* (${groupNames.length} members):\n`;

                    // Match within the group (no restrictions passed from bot for now)
                    let matchesByName;
                    try {
                        // TODO: Replace with actual matching logic, including restrictions
                        bot.sendMessage(chatId, `🚧 Matching logic for group ${groupName} not yet implemented.`);
                        await client.query('ROLLBACK'); // Ensure transaction is closed
                        return; // Stop processing this group and the overall command
                        // matchesByName = assignSecretAngels(groupNames, []); // Pass empty restrictions
                    } catch (matchError) {
                        await client.query('ROLLBACK');
                        console.error(`Matching failed for group ${groupName} via bot:`, matchError);
                        bot.sendMessage(chatId, `❌ Failed to create assignments for group ${i + 1} (${groupNames.join(', ')}). Error: ${matchError.message}`);
                        return; // Stop the process
                    }

                    // Insert group
                    const groupInsertResult = await client.query('INSERT INTO tg_groups (group_name) VALUES ($1) RETURNING group_id', [groupName]);
                    const groupId = groupInsertResult.rows[0].group_id;

                    // Insert members
                    for (const name of groupNames) {
                        const participantId = participantMap.get(name);
                        await client.query('INSERT INTO tg_group_members (group_id, participant_id) VALUES ($1, $2)', [groupId, participantId]);
                    }

                    // Insert assignments
                    for (const [giverName, receiverName] of Object.entries(matchesByName)) {
                        const giverId = participantMap.get(giverName);
                        const receiverId = participantMap.get(receiverName);
                        await client.query('INSERT INTO tg_assignments (group_id, giver_participant_id, receiver_participant_id) VALUES ($1, $2, $3)', [groupId, giverId, receiverId]);
                        assignmentsSummary += `  - ${giverName} -> ${receiverName}\n`;
                    }
                }

                await client.query('COMMIT');
                console.log(`Admin ${userId} created ${numGroups} groups via bot.`);
                bot.sendMessage(chatId, `✅ Successfully created ${numGroups} groups and assignments!\n${assignmentsSummary}`, { parse_mode: 'Markdown' });

            } catch (error) {
                await client.query('ROLLBACK');
                console.error('Error during group creation via bot:', error);
                bot.sendMessage(chatId, `❌ An error occurred while creating groups: ${error.message}`);
            }
            // -------------------------------------------------------------------
        }
    }
});

// Add Express routes
app.get('/', (req, res) => {
  res.send('Secret Angel Bot is running!');
});

// Listen on the port Render provides, or default to 10000
const port = process.env.PORT || 10000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Express server is running on port ${port}`);
});

// Handle polling errors
bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});
