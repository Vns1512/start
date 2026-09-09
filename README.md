# World Map Domination Game

Browser-based WMDG with online multiplayer and single-player mode against four AI commanders.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000

## Deploy on Render

- Build command: `npm install`
- Start command: `npm start`

The server uses `process.env.PORT || 3000`.

## Current WMDG Constitution alignment

The digital game follows the implemented core Constitution rules: 10 starting gold, 100 starting reserve infantry, capital income of 2 gold/turn, country-specific 1/2/3-gold economies, one attack per turn, player-vs-player attacks from round 10, 3-defence maximum, the listed infantry/country values, 4,000-mile ship range, Constitution costs, coin-flip combat in 10-infantry steps, capital elimination, and the city limits/income rules.

The country hover panel shows current owner, infantry, gold/turn, defences, cities, and starting values. Countries whose infantry status is explicitly described as debated in the Constitution are marked as debated rather than presented as an official fixed value.

The Constitution also contains sections explicitly marked as not-yet-rules or still debated (such as rebellion rounds and canal blocking), so those are not silently invented as mandatory game mechanics. Negotiated deals, loans, sales, surrendering, and peace treaties remain multiplayer/social rules rather than automatic AI mechanics.

## Modes

- Online multiplayer: create a room and share its code.
- Single player: play as one commander against four AI commanders.
- Player chat is available in online rooms.
