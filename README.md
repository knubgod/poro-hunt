# Poro Hunt 🐾

A League of Legends–themed Discord minigame bot built with Discord.js.

Poros spawn in a configured channel. Players compete to catch them, earn XP and gold, collect rarities, and complete their Poro Dex.

This project is designed for self-hosting.

---

## ✨ Features

### 🎯 Core Gameplay

- Public poro spawns with **Catch** and **Toss Berry** buttons
- **Only one player can successfully catch each poro per spawn**
- If one player fails and another succeeds, only the successful catcher keeps it
- Spawn messages automatically resolve:
  - ✅ Caught → buttons disabled
  - 💨 Not caught → edits to “Poro ran away” after 15 minutes

### 🕒 Smart Spawn System

- Configurable **spawns per day** (default: 6)
- Randomized timing throughout the day
- Guaranteed daily quota distribution
- No spawns during **quiet hours (12:00am–6:00am local time)**
- Persistent scheduling (bot restarts do not reset timing)

### 🌟 Poro Rarities

- Common
- Rare
- Ultra Rare (including King Poro)

Each spawn rolls randomized stats:
- Size
- Weight
- Throw Distance
- Fluffiness
- Hunger

---

## 📈 Player Progression

- XP + leveling system
- Unlockable titles by level
- Gold economy:
  - Common catch: **1–7g**
  - Rare catch: **8–16g**
  - Ultra rare catch: **17–50g**
- Goal: collect **at least one of every poro**

---

## 🎒 Inventory & Items

### Nets (15g)
- Can be armed
- **100% guaranteed catch**
- Works while offline
- Catches go into a private **net stash**
- Does NOT end the public spawn

### Berries
- Used during a spawn
- +15% catch chance (applies to your next attempt on that spawn)

### Food
- Free food bag every 12 hours (+3 uses)
- Paid food bag: 5g (+3 uses)

---

## 🍽 Hunger System

- Cosmetic only (no penalties)
- Takes ~12 hours to go from 0 → fully hungry
- Updates based on real-world time
- Feeding handled via private UI

---

## 🖥 Private UI

Use `/poro menu` to open your personal UI (ephemeral, no channel spam):

- Home
- Collection
- Inventory
- Feed Hungry Poro
- Arm Net
- Titles
- Shop

Optional naming available after a successful catch.

---

## 🛠 Admin Commands

All admin commands require **Manage Server**.
`resetall` is **Server Owner only**.

### Quick Setup
```
/poro admin setup
```
Configure:
- Spawn channel
- Spawns per day
- Optional weekly showcase channel

### Individual Controls

```
/poro admin channel
/poro admin showcasechannel
/poro admin spawnsperday
/poro admin spawn
/poro admin clearspawn
/poro admin resetall
```

---

## 🏆 Weekly Showcase

Optional automated weekly post:

- Total poros caught by rarity
- Top catchers in server

---

## 🧰 Requirements

- Node.js **20+**
- Discord application + bot token
- SQLite (auto-managed)

---

## 🚀 Installation

### 1️⃣ Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/poro-hunt.git
cd poro-hunt
```

### 2️⃣ Install dependencies

```bash
npm install
```

### 3️⃣ Create environment file

```bash
cp .env.example .env
```

Fill in:

```
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_id_here
```

⚠️ Never commit your `.env` file.

---

### 4️⃣ Deploy Slash Commands (Global)

```bash
npm run deploy
```

Global commands may take a few minutes to appear.

---

### 5️⃣ Start the bot

```bash
npm start
```

For production servers, use a process manager like PM2:

```bash
pm2 start npm --name poro-hunt -- start
pm2 save
```

---

## 💾 Data Storage

- All game data stored in `poro.sqlite`
- File is git-ignored
- Deleting it resets all progress
- Safe to keep during updates

---

## 📌 Notes

- Spawns are per-server (data does NOT carry across servers)
- Commands are registered globally
- Designed for friend groups & small communities
- Fully self-hostable

---

## 📜 License

N/A