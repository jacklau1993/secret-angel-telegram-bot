/**
 * Simple rate limiting utility for the Secret Angel Telegram Bot
 */

// In-memory store for rate limiting (in production, use Redis or similar)
const rateLimitStore = new Map();

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute window
const RATE_LIMIT_MAX_REQUESTS = 10; // Max 10 requests per window

/**
 * Check if a user has exceeded the rate limit
 * @param {number} userId - Telegram user ID
 * @returns {boolean} - True if user is rate limited, false otherwise
 */
function isRateLimited(userId) {
    const now = Date.now();
    const userKey = `user:${userId}`;
    
    // Get user's rate limit data
    let userData = rateLimitStore.get(userKey);
    
    // If no data or window has expired, reset
    if (!userData || userData.resetTime <= now) {
        userData = {
            count: 1,
            resetTime: now + RATE_LIMIT_WINDOW
        };
        rateLimitStore.set(userKey, userData);
        return false;
    }
    
    // Increment count
    userData.count++;
    rateLimitStore.set(userKey, userData);
    
    // Check if limit exceeded
    return userData.count > RATE_LIMIT_MAX_REQUESTS;
}

/**
 * Clear old rate limit data to prevent memory leaks
 */
function cleanupRateLimitStore() {
    const now = Date.now();
    
    for (const [key, userData] of rateLimitStore.entries()) {
        if (userData.resetTime <= now) {
            rateLimitStore.delete(key);
        }
    }
}

// Periodically clean up old data (every 5 minutes)
setInterval(cleanupRateLimitStore, 5 * 60 * 1000);

module.exports = {
    isRateLimited
};