# Secret Angel Telegram Bot

A Telegram bot for organizing Secret Angel gift exchanges. The bot allows users to register, submit wishlists, and receive their Secret Angel assignments.

## Features

- User registration with optional wishlists
- Admin controls for managing participants and assignments
- Group creation with customizable restrictions
- Secure assignment distribution

## Environment Variables

Create a `.env` file with the following variables:

```env
# Telegram Bot Token from BotFather
TELEGRAM_BOT_TOKEN=your_bot_token

# Your numeric Telegram User ID (find using @userinfobot)
ADMIN_TELEGRAM_ID=your_admin_id

# For local development:
DB_USER=postgres
DB_HOST=localhost
DB_NAME=secret_angel_bot
DB_PASSWORD=your_password
DB_PORT=5432

# For production (Render deployment):
DATABASE_URL=your_neon_database_url
```

## Development Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a PostgreSQL database and configure the connection in `.env`

3. Run the bot:
   ```bash
   npm start
   ```

## Deployment

This bot is configured for deployment on Render.com with a Neon PostgreSQL database:

1. Create a Neon database and get the connection URL
2. In Render.com:
   - Connect this repository
   - Add environment variables:
     - TELEGRAM_BOT_TOKEN
     - ADMIN_TELEGRAM_ID
     - DATABASE_URL (from Neon)
   - Deploy!

## Security Features

This bot includes several security features to protect against common vulnerabilities:

- **Input Validation & Sanitization**: All user inputs are validated and sanitized to prevent injection attacks
- **SQL Injection Prevention**: All database queries use parameterized statements
- **Rate Limiting**: Prevents abuse by limiting the number of requests per user
- **Webhook Verification**: Ensures webhook requests are genuinely from Telegram
- **Admin Access Control**: Admin-only commands are protected by user ID verification

## Bot Commands

User Commands:
- `/start` - Show welcome message
- `/register` - Register as a participant
- `/myassignment` - Check your Secret Angel assignment

Admin Commands:
- `/participants` - List all registered participants
- `/creategroups` - Create groups and assign Secret Angels
- `/cleardata` - Clear all bot data (requires confirmation)