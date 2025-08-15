/**
 * Security utility functions for the Secret Angel Telegram Bot
 */

// Maximum lengths for various inputs to prevent DoS attacks
const MAX_NAME_LENGTH = 100;
const MAX_WISHLIST_LENGTH = 1000;
const MAX_RESTRICTIONS_INPUT_LENGTH = 5000;

/**
 * Sanitizes user input by escaping special characters
 * @param {string} input - The input string to sanitize
 * @returns {string} - The sanitized string
 */
function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    
    // Remove or escape potentially dangerous characters
    // This is a basic implementation - in production, consider using a library like validator.js
    return input
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;')
        .trim();
}

/**
 * Validates and sanitizes a participant name
 * @param {string} name - The name to validate
 * @returns {string|null} - The sanitized name or null if invalid
 */
function validateName(name) {
    if (!name || typeof name !== 'string') return null;
    
    // Trim and sanitize
    const sanitizedName = sanitizeInput(name.trim());
    
    // Check length
    if (sanitizedName.length === 0 || sanitizedName.length > MAX_NAME_LENGTH) {
        return null;
    }
    
    // Basic validation - only allow alphanumeric characters, spaces, hyphens, and underscores
    // This is restrictive but secure - adjust as needed for your use case
    if (!/^[\w\s\-']+$/u.test(sanitizedName)) {
        return null;
    }
    
    return sanitizedName;
}

/**
 * Validates and sanitizes a wishlist
 * @param {string} wishlist - The wishlist to validate
 * @returns {string} - The sanitized wishlist (empty string if invalid)
 */
function validateWishlist(wishlist) {
    if (!wishlist || typeof wishlist !== 'string') return '';
    
    // Trim and sanitize
    const sanitizedWishlist = sanitizeInput(wishlist.trim());
    
    // Check length
    if (sanitizedWishlist.length > MAX_WISHLIST_LENGTH) {
        return sanitizedWishlist.substring(0, MAX_WISHLIST_LENGTH);
    }
    
    return sanitizedWishlist;
}

/**
 * Validates a number input
 * @param {string|number} input - The input to validate
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @returns {number|null} - The validated number or null if invalid
 */
function validateNumber(input, min = 1, max = 1000) {
    const num = parseInt(input, 10);
    
    if (isNaN(num) || num < min || num > max) {
        return null;
    }
    
    return num;
}

/**
 * Validates restrictions input
 * @param {string} input - The restrictions input to validate
 * @param {string[]} validParticipants - Array of valid participant names
 * @returns {Array<Array<string>>|null} - Array of validated restriction pairs or null if invalid
 */
function validateRestrictionsInput(input, validParticipants) {
    if (!input || typeof input !== 'string') return [];
    
    // Check length
    if (input.length > MAX_RESTRICTIONS_INPUT_LENGTH) {
        return null; // Too long
    }
    
    // Handle special cases
    const trimmedInput = input.trim();
    if (trimmedInput.toLowerCase() === 'none' || trimmedInput === '') {
        return [];
    }
    
    try {
        const lines = trimmedInput.split('\n');
        const restrictions = [];
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine === '') continue;
            
            const pair = trimmedLine.split(',').map(name => name.trim());
            
            // Validate pair format
            if (pair.length !== 2 || pair.some(name => !name)) {
                return null; // Invalid format
            }
            
            // Validate names exist in participant list
            if (!validParticipants.includes(pair[0]) || !validParticipants.includes(pair[1])) {
                return null; // Invalid participant name
            }
            
            // Check for self-restriction
            if (pair[0] === pair[1]) {
                return null; // Cannot restrict oneself
            }
            
            restrictions.push(pair);
        }
        
        return restrictions;
    } catch (error) {
        return null; // Error in parsing
    }
}

/**
 * Verifies webhook requests from Telegram
 * @param {Object} req - Express request object
 * @param {string} token - Telegram bot token
 * @returns {boolean} - True if request is valid, false otherwise
 */
function verifyWebhookRequest(req, token) {
    // In a production environment, you should verify the request is from Telegram
    // by checking the request signature or using Telegram's certificate verification
    
    // For now, we'll do a basic check to ensure the request is properly formatted
    if (!req || !req.body) {
        console.warn('Webhook verification failed: Missing request or body');
        return false;
    }
    
    // Check for required fields in Telegram webhook updates
    const update = req.body;
    if (!update.update_id) {
        console.warn('Webhook verification failed: Missing update_id');
        return false;
    }
    
    // Additional verification could include:
    // 1. Checking the request origin (Telegram IP ranges)
    // 2. Verifying a secret token in the request headers
    // 3. Using Telegram's certificate verification
    
    return true;
}

module.exports = {
    sanitizeInput,
    validateName,
    validateWishlist,
    validateNumber,
    validateRestrictionsInput,
    verifyWebhookRequest,
    MAX_NAME_LENGTH,
    MAX_WISHLIST_LENGTH,
    MAX_RESTRICTIONS_INPUT_LENGTH
};