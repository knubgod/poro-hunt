# Poro Hunt 🐾
A League of Legends–themed Discord minigame bot built with Discord.js.


Poros spawn in a server channel at random intervals. Players compete to catch them, earn XP and gold, manage hunger, use nets and berries, and ultimately complete their Poro Dex by collecting one of each poro.


---


## ✨ Features


### Core Gameplay
- Public poro spawns with **Catch** and **Toss Berry** buttons
- Fully random spawn timing (minutes → hours, back-to-back spawns are rare)
- Multiple poro rarities:
  - Common
  - Rare
  - Ultra Rare (including King Poro)
- Each poro has randomized stats (within logical ranges):
  - Size
  - Weight
  - Throw distance
  - Fluffiness
  - Hunger


### Player Progression
- XP + leveling system
- Unlockable titles by level
- Gold economy:
  - Common catch: **1–7g**
  - Rare catch: **8–16g**
  - Ultra rare catch: **17–50g**
- End goal: collect **at least one of every poro**


### Inventory & Items
- Nets (15g) – can be armed to catch poros while offline
- Food:
  - Free food bag every 12 hours (+3 uses)
  - Paid food bag: 5g (+3 uses)
- Berries:
  - Used during a spawn to boost catch chance (+15%)


### Hunger System
- Hunger is cosmetic (no penalties)
- Takes ~12 hours to go from not hungry → fully hungry
- Hunger updates based on real time, not menu usage
- Feeding is handled via the private UI


### UI & Interaction Design
- Public messages only for spawns and showcases
- Private (ephemeral) UI menu for players:
  - Home
  - Collection
  - Inventory
  - Feed Hungry Poro
  - Arm Net
  - Titles
  - Shop
- Optional naming of poros after a successful catch


### Admin Tools
- Set spawn channel
- Set weekly showcase channel
- Force spawn (testing)
- Clear stuck spawns
- Reset all server progress (with confirmation)


### Weekly Showcase
- Automated weekly post (optional)
- Shows total poros caught by rarity
- Displays top catchers in the server


---


## 🧰 Requirements
- Node.js **20+** recommended
- A Discord application + bot token
- SQLite (handled automatically)


---


## 🚀 Setup (Local or Server)


### 1. Install dependencies
```bash
npm install
2. Environment variables

Copy the example file:

cp .env.example .env

Fill in:

DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_id_here

⚠️ Never commit your .env file.

3. Deploy slash commands
npm run deploy

Run this whenever slash commands change.

4. Start the bot
npm start
🛠 Discord Setup (Admin)

In your server, configure channels:

/poro admin channel #poro-spawns
/poro admin showcasechannel #poro-showcase   (optional)

Optional admin commands:

/poro admin spawn – force a spawn (testing)

/poro admin clearspawn – clears a stuck active spawn

/poro admin resetall – wipes all game data for the server

💾 Data Storage

Game state is stored in poro.sqlite

This file is ignored by git

Deleting it resets all progress

Safe to keep when pulling updates

📌 Notes

Spawns automatically resolve:

If caught → message disables buttons

If not caught → message edits to “Poro ran away”

Collection and showcase are synced using per-catch data

Designed for friend groups, not spammy public servers