# Matrix Ollama Bot

A multi-bot framework for the [Matrix](https://matrix.org/) protocol that integrates with [Ollama](https://ollama.ai/) to provide AI-assisted chat responses, reactions, and conversation summarization.
Supports configurable personalities, response behavior, and message/reaction rules per bot.

---

## Features

- **Multiple Bots**: Run several Matrix bots from a single configuration.
- **Ollama Integration**: Uses Ollama for AI-generated chat and summaries.
- **Configurable Behavior**:
  - Always respond, only respond when mentioned, or respond sometimes.
  - Automatic emoji reactions.
  - Custom system prompts and aliases.
- **Conversation Summarization**:
  - Maintains a rolling summary for long conversations.
  - Summaries are updated automatically using Ollama.
- **Matrix SDK**:
  - Auto-joins rooms.
  - Reads messages and reactions.
  - Sends typing indicators.
- **JSON-based Output Control**:
  - AI responses follow a strict JSON schema for predictable behavior.

---

## How It Works

1. The bot logs into your Matrix homeserver using credentials from `bots.json`.
2. When a message is received:
   - It’s matched against sender aliases and regex-based message aliases.
   - Conversation history is appended and summarized when too long.
   - Ollama is queried for a response (and/or reaction) in JSON format.
   - The bot sends the response message and/or emoji reaction to the room.
3. Summaries ensure long-running conversations keep context without overwhelming the AI.

---

## Requirements

- Node.js 18+
- An [Ollama](https://ollama.ai/) server running locally (default: `http://localhost:11434`)
- An account on a matrix server

---

## Installation

```bash
git clone https://github.com/flackr/ollabot.git
cd matrix-ollama-bot
cp bots.sample.json bots.json
# Add your accesstoken to bots.json and modify config.
npm install
npm run build
npm run start
```
