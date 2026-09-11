const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const rooms = new Map();
const analytics = {
  connected: 0,
  totalConnections: 0,
  uniqueVisitors: new Set(),
  gamesStarted: 0,
  gamesCompleted: 0
};

function analyticsView() {
  return {
    onlineNow: analytics.connected,
    totalConnections: analytics.totalConnections,
    uniqueVisitors: analytics.uniqueVisitors.size,
    gamesStarted: analytics.gamesStarted,
    gamesCompleted: analytics.gamesCompleted,
    activeGames: [...rooms.values()].filter(r => r.phase !== "gameover").length
  };
}
const COLORS = ["#ff5d73","#3b82f6","#22c55e","#fbbf24","#a855f7","#fb923c","#14b8a6","#ec4899"];
const RANGE = 4000;

function code() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i=0;i<5;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return rooms.has(s) ? code() : s;
}
function roomView(room) {
  return {
    code: room.code, hostId: room.hostId, phase: room.phase,
    round: room.round, current: room.current, turnSeq: room.turnSeq || 0, capitalIndex: room.capitalIndex ?? null,
    players: room.players,
    chat: room.chat || [],
    treaties: room.treaties || [],
    treatyOffers: room.treatyOffers || [],
    territories: room.territories, selectedBy: room.selectedBy, log: room.log, singlePlayer: !!room.singlePlayer, analytics: analyticsView(), winner: room.winner || null
  };
}
function addLog(room, text) {
  room.log.push(text);
  if (room.log.length > 80) room.log.shift();
}
function broadcast(room) {
  io.to(room.code).emit("state", roomView(room));
}
function player(room, socketId) {
  return room.players.find(p => p.id === socketId);
}
function currentPlayer(room) {
  return room.players[room.current];
}
function livingPlayers(room) {
  return room.players.filter(p => p.alive !== false);
}
function requireTurn(socket, room) {
  if (room.phase !== "playing") return "The game has not started.";
  const p = currentPlayer(room);
  if (!p || p.id !== socket.id) return "It is not your turn.";
  return null;
}
function endTurn(room) {
  const p = currentPlayer(room);
  p.gold += income(room, p);
  p.attacked = false;
  room.selectedBy[p.id] = null;
  room.turnSeq = (room.turnSeq || 0) + 1;
  cleanupTreaties(room);
  let loops = 0;
  do {
    room.current = (room.current + 1) % room.players.length;
    if (room.current === 0) room.round++;
    loops++;
  } while (room.players[room.current].alive === false && loops <= room.players.length);
  addLog(room, `— Round ${room.round}: ${currentPlayer(room).name}'s turn. —`);
  runAI(room);
}
function owned(room, p) {
  return Object.values(room.territories).filter(t => t.owner === p.name);
}
function income(room, p) {
  return 2 + owned(room,p).reduce((sum,t) => {
    const cityIncome=(t.smallCities||0) + 2*(t.largeCities||0);
    return sum + (t.name === p.capital ? cityIncome : t.gold + cityIncome);
  }, 0);
}
function applyCityTransferQuota(room, newOwner, t) {
  if (!newOwner || !t) return;
  const p=room.players.find(x=>x.name===newOwner);
  if (!p) return;
  const quota=t.gold>=2?2:1;
  let total=(t.smallCities||0)+(t.largeCities||0);
  while (total>0 && Object.values(room.territories).reduce((sum,x)=>sum+(x.owner===newOwner?((x.smallCities||0)+(x.largeCities||0)):0),0)>10) {
    if (t.largeCities>0) t.largeCities--; else t.smallCities--;
    total--;
  }
  while ((t.smallCities||0)+(t.largeCities||0)>quota) {
    if (t.largeCities>0) t.largeCities--; else t.smallCities--;
    addLog(room, `${t.name} lost a city because its new owner already had the country's allowed city capacity.`);
  }
  t.city=(t.smallCities||0)+(t.largeCities||0);
}

function eliminateIfCapitalLost(room, oldOwner, country) {
  const p = room.players.find(x => x.name === oldOwner);
  if (p && p.capital === country) {
    p.alive = false;
    for (const t of Object.values(room.territories))
      if (t.owner === oldOwner && t.name !== country) t.owner = null;
    addLog(room, `${oldOwner}'s capital fell. They are eliminated.`);
  }
}

function checkGameOver(room) {
  if (!room || room.phase === "gameover") return true;
  const living = livingPlayers(room);
  if (living.length > 1) return false;
  room.phase = "gameover";
  room.winner = living[0]?.name || null;
  analytics.gamesCompleted++;
  addLog(room, room.winner ? `🏆 ${room.winner} is the last empire standing. Game over!` : "Game over — there is no surviving empire.");
  return true;
}


function getTreaty(room, a, b) {
  return (room.treaties || []).find(t => t.active && ((t.a === a && t.b === b) || (t.a === b && t.b === a)));
}
function treatyOffer(room, from, to) {
  return (room.treatyOffers || []).find(o => o.from === from && o.to === to);
}
function treatyBlocksAttack(room, attacker, defender) {
  const t = getTreaty(room, attacker, defender);
  if (!t) return null;
  if (t.breakNoticeBy && t.breakAtSeq != null && (room.turnSeq || 0) >= t.breakAtSeq && t.breakNoticeBy === attacker) return null;
  return t;
}
function cleanupTreaties(room) {
  room.treaties = (room.treaties || []).filter(t => {
    if (!t.active) return false;
    if (t.breakAtSeq != null && (room.turnSeq || 0) >= t.breakAtSeq && t.breakNoticeBy) {
      addLog(room, `☮ Peace treaty between ${t.a} and ${t.b} has ended after the one-turn notice.`);
      return false;
    }
    return true;
  });
}
function makeTreaty(room, a, b, scope) {
  room.treaties = room.treaties || [];
  room.treaties.push({id:`t-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,a,b,scope:scope === 'wide' ? 'wide' : 'direct',active:true,createdRound:room.round,breakNoticeBy:null,breakAtSeq:null});
}

function aiPlayers() { return true; }
function isAI(p) { return !!p && p.ai === true; }
function randomItem(arr) { return arr[Math.floor(Math.random()*arr.length)]; }
function chooseAICapital(room, p) {
  const choices = Object.values(room.territories).filter(t => !t.owner && !["USA","Russia","China"].includes(t.name));
  if (!choices.length) return;
  const t = randomItem(choices);
  t.owner = p.name; t.infantry = 100; p.capital = t.name;
  addLog(room, `${p.name} chose ${t.name} as their capital.`);
}
function finishCapitalIfReady(room) {
  if (room.capitalIndex >= room.players.length) {
    room.phase = "playing"; room.current = 0;
    addLog(room, `${room.players[0].name}'s turn begins.`);
    broadcast(room);
    return true;
  }
  return false;
}
function continueCapital(room) {
  while (room.phase === "capital" && room.capitalIndex < room.players.length) {
    const p = room.players[room.capitalIndex];
    if (!isAI(p)) break;
    chooseAICapital(room,p);
    room.capitalIndex++;
  }
  finishCapitalIfReady(room);
}
function aiAttack(room,p) {
  if (p.attacked || p.reserve <= 0) return;
  const ownedNames = owned(room,p).map(t=>t.name);
  let targets = [];
  for (const from of ownedNames) {
    for (const name of (room.adjacency?.[from]||[])) {
      const t=room.territories[name];
      if (t && t.owner!==p.name && (room.round>=10 || !t.owner)) targets.push(t);
    }
  }
  targets = [...new Map(targets.map(t=>[t.name,t])).values()];
  if (!targets.length) return;
  const target = randomItem(targets);
  p.attacked = true;
  while (target.defences > 0) {
    if (Math.random() < 0.5) {
      target.defences--;
      addLog(room, `HEADS — ${target.name}'s defence was destroyed.`);
    } else {
      addLog(room, `TAILS — ${target.name}'s defence held against ${p.name}. Attack ended.`);
      return;
    }
  }
  while (p.reserve > 0 && target.infantry > 0) {
    if (Math.random() < 0.5) target.infantry = Math.max(0,target.infantry-10);
    else p.reserve = Math.max(0,p.reserve-10);
  }
  if (target.infantry <= 0) {
    const old = target.owner; target.owner = p.name;
    applyCityTransferQuota(room,p.name,target);
    addLog(room, `★ ${p.name} captured ${target.name}! ★`);
    if (old) eliminateIfCapitalLost(room,old,target.name);
    checkGameOver(room);
  } else addLog(room, `${p.name}'s attack on ${target.name} failed.`);
}
function aiAction(room,p) {
  if (!p || !p.alive) return;
  // Spend some income on reinforcements and capital/territory defence.
  if (p.gold >= 2 && Math.random() < 0.65) {
    p.gold -= 2;
    const own = owned(room,p);
    if (own.length) { const fort = randomItem(own); fort.defences = Math.min(3, fort.defences + 1); }
    addLog(room, `${p.name} strengthened its defences.`);
  } else if (p.gold >= 1 && Math.random() < 0.8) {
    p.gold -= 1; p.reserve += 5;
    addLog(room, `${p.name} bought 5 infantry.`);
  }
  aiAttack(room,p);
}
function runAI(room) {
  if (!room || !room.singlePlayer || room.phase !== "playing") return;
  const p = currentPlayer(room);
  if (!isAI(p)) return;
  setTimeout(() => {
    if (!rooms.has(room.code) || room.phase !== "playing" || currentPlayer(room) !== p || !p.alive) return;
    aiAction(room,p);
    if (room.phase === "gameover") { broadcast(room); return; }
    endTurn(room);
    broadcast(room);
    runAI(room);
  }, 700);
}

io.on("connection", socket => {
  analytics.connected++;
  analytics.totalConnections++;
  socket.on("identifyAnalytics", visitorId => {
    if (typeof visitorId === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(visitorId)) analytics.uniqueVisitors.add(visitorId);
    socket.emit("analytics", analyticsView());
  });
  socket.on("createRoom", ({name}) => {
    name = String(name||"Player").trim().slice(0,24) || "Player";
    const room = {
      code: code(), hostId: socket.id, phase: "lobby", round: 1, current: 0,
      players: [{id:socket.id,name,color:COLORS[0],gold:10,reserve:100,small:0,large:0,alive:true,attacked:false,capital:null,smallCities:0,largeCities:0}],
      territories: {}, selectedBy: {}, chat: [], treaties: [], treatyOffers: [], turnSeq: 0, log: ["Lobby created. Share the room code and wait for players."]
    };
    rooms.set(room.code, room);
    socket.join(room.code);
    socket.emit("joined", {code:room.code});
    broadcast(room);
  });

  socket.on("createSinglePlayer", ({name, territories, adjacency}) => {
    name = String(name||"Player").trim().slice(0,24) || "Player";
    const aiNames = ["Atlas AI","Europa AI","Orion AI","Titan AI"];
    const players = [{id:socket.id,name,color:COLORS[0],gold:10,reserve:100,small:0,large:0,alive:true,attacked:false,capital:null,smallCities:0,largeCities:0,ai:false}];
    aiNames.forEach((n,i)=>players.push({id:`ai-${i+1}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,name:n,color:COLORS[i+1],gold:10,reserve:100,small:0,large:0,alive:true,attacked:false,capital:null,ai:true}));
    const room = {code:code(),hostId:socket.id,phase:"capital",round:1,current:0,capitalIndex:0,players,territories:territories||{},adjacency:adjacency||{},selectedBy:{},chat:[],treaties:[],treatyOffers:[],turnSeq:0,log:["Single-player campaign started. You are facing four AI commanders."],singlePlayer:true};
    analytics.gamesStarted++;
    rooms.set(room.code,room); socket.join(room.code); socket.emit("joined",{code:room.code,single:true});
    broadcast(room);
  });

  socket.on("joinRoom", ({name, code:joinCode}) => {
    const room = rooms.get(String(joinCode||"").toUpperCase());
    if (!room) return socket.emit("errorMessage", "Room not found.");
    if (room.phase !== "lobby") return socket.emit("errorMessage", "That game has already started.");
    if (room.players.length >= 8) return socket.emit("errorMessage", "That room is full.");
    name = String(name||"Player").trim().slice(0,24) || "Player";
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase()))
      return socket.emit("errorMessage", "That player name is already in use.");
    room.players.push({id:socket.id,name,color:COLORS[room.players.length],gold:10,reserve:100,small:0,large:0,alive:true,attacked:false,capital:null,smallCities:0,largeCities:0});
    socket.join(room.code);
    socket.emit("joined", {code:room.code});
    addLog(room, `${name} joined the lobby.`);
    broadcast(room);
  });

  socket.on("startGame", ({code, territories, adjacency}) => {
    const room = rooms.get(code);
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit("errorMessage","Only the host can start the game.");
    if (room.players.length < 2) return socket.emit("errorMessage","At least 2 players are required.");
    room.territories = territories || {};
    room.adjacency = adjacency || {};
    room.phase = "capital";
    room.capitalIndex = 0;
    analytics.gamesStarted++;
    addLog(room, "Game started. Players are choosing capitals.");
    broadcast(room);
  });

  socket.on("chooseCapital", ({code,country}) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "capital") return;
    const p = room.players[room.capitalIndex];
    if (!p || p.id !== socket.id) return socket.emit("errorMessage","You cannot choose a capital yet because it is another player's capital-selection turn.");
    const t = room.territories[country];
    if (!t) return socket.emit("errorMessage","That location is not a playable country on this map.");
    if (t.owner) return socket.emit("errorMessage",`${country} is already controlled by ${t.owner}, so you must choose a neutral country.`);
    if (["USA","Russia","China"].includes(country)) return socket.emit("errorMessage",`${country} is a 3-golder and cannot be selected as a starting capital.`);
    t.owner = p.name; t.infantry = 100; p.capital = country;
    addLog(room, `${p.name} chose ${country} as their capital.`);
    room.capitalIndex++;
    if (room.singlePlayer) continueCapital(room);
    else if (room.capitalIndex >= room.players.length) {
      room.phase = "playing"; room.current = 0;
      addLog(room, `${room.players[0].name}'s turn begins.`);
    }
    broadcast(room);
  });

  socket.on("selectCountry", ({code,country}) => {
    const room = rooms.get(code);
    if (!room || !room.territories[country]) return;
    room.selectedBy[socket.id] = country;
    broadcast(room);
  });

  socket.on("buy", ({code,type}) => {
    const room = rooms.get(code), err = room && requireTurn(socket,room);
    if (!room) return;
    if (err) return socket.emit("errorMessage",err);
    const p = currentPlayer(room);
    const costs = {infantry:1,small:1,large:2};
    if (!(type in costs)) return socket.emit("errorMessage","That purchase is not a valid Command Centre option.");
    if (p.gold < costs[type]) return socket.emit("errorMessage",`You need ${costs[type]} gold for that purchase, but you only have ${p.gold}.`);
    p.gold -= costs[type];
    if (type==="infantry") p.reserve += 5;
    else p[type] += 1;
    addLog(room, `${p.name} bought ${type==="infantry"?"5 infantry":`a ${type} ship`}.`);
    broadcast(room);
  });

  socket.on("build", ({code,type,country}) => {
    const room = rooms.get(code), err = room && requireTurn(socket,room);
    if (!room) return;
    if (err) return socket.emit("errorMessage",err);
    const p=currentPlayer(room), t=room.territories[country];
    if (!t || t.owner!==p.name) return socket.emit("errorMessage","You can only build on your own territory.");
    if (type==="defence") {
      if (p.gold<2) return socket.emit("errorMessage",`A defence costs 2 gold, but you only have ${p.gold}.`);
      if (t.defences>=3) return socket.emit("errorMessage",`${country} already has the maximum 3 defences allowed.`);
      p.gold-=2; t.defences++; addLog(room,`${p.name} built a defence in ${country}.`);
    } else {
      const cost=type==="city1"?8:15, key=type==="city1"?"smallCities":"largeCities";
      const countryQuota=t.gold>=2?2:1;
      const countryCityCount=(t.smallCities||0)+(t.largeCities||0);
      const playerCityCount=Object.values(room.territories).reduce((sum,x)=>sum+(x.owner===p.name?(x[key]||0):0),0);
      if (p.gold<cost) return socket.emit("errorMessage",`That city costs ${cost} gold, but you only have ${p.gold}.`);
      if (playerCityCount>=5) return socket.emit("errorMessage",`You already have 5 ${type==="city1"?"small":"large"} cities, which is the maximum allowed.`);
      if (countryCityCount>=countryQuota) return socket.emit("errorMessage",`${country} can hold only ${countryQuota} city${countryQuota===1?"":"ies"} under the Constitution.`);
      p.gold-=cost;
      t[key]=(t[key]||0)+1;
      t.city=(t.smallCities||0)+(t.largeCities||0);
      addLog(room,`${p.name} built a ${type==="city1"?"small":"large"} city in ${country}.`);
    }
    broadcast(room);
  });

  socket.on("proposeTreaty", ({code, toId, scope}) => {
    const room = rooms.get(code);
    if (!room) return;
    const from = player(room, socket.id);
    const to = room.players.find(p => p.id === toId);
    if (!from || !to || from.id === to.id) return socket.emit("errorMessage", "Choose another living player for the treaty.");
    if (from.alive === false || to.alive === false) return socket.emit("errorMessage", "Eliminated players cannot make peace treaties.");
    if (room.phase !== "playing") return socket.emit("errorMessage", "Peace treaties can be made once the game is underway.");
    if (getTreaty(room, from.name, to.name)) return socket.emit("errorMessage", `You already have a peace treaty with ${to.name}.`);
    if (treatyOffer(room, from.name, to.name)) return socket.emit("errorMessage", `A treaty offer to ${to.name} is already waiting for them.`);
    room.treatyOffers = room.treatyOffers || [];
    room.treatyOffers.push({id:`o-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,from:from.name,fromId:from.id,to:to.name,toId:to.id,scope:scope === "wide" ? "wide" : "direct",round:room.round});
    addLog(room, `${from.name} proposed a peace treaty to ${to.name}.`);
    broadcast(room);
  });

  socket.on("respondTreaty", ({code, offerId, accept}) => {
    const room = rooms.get(code);
    if (!room) return;
    const me = player(room, socket.id);
    const offer = (room.treatyOffers || []).find(o => o.id === offerId && o.toId === socket.id);
    if (!me || !offer) return socket.emit("errorMessage", "That treaty offer is no longer available.");
    room.treatyOffers = room.treatyOffers.filter(o => o.id !== offerId);
    if (accept) {
      if (getTreaty(room, offer.from, offer.to)) return socket.emit("errorMessage", "A peace treaty already exists between you.");
      makeTreaty(room, offer.from, offer.to, offer.scope);
      addLog(room, `☮ ${offer.from} and ${offer.to} agreed to a ${offer.scope === "wide" ? "wide" : "direct-attack"} peace treaty.`);
    } else {
      addLog(room, `${me.name} declined the peace treaty proposed by ${offer.from}.`);
    }
    broadcast(room);
  });

  socket.on("breakTreaty", ({code, treatyId}) => {
    const room = rooms.get(code);
    if (!room) return;
    const me = player(room, socket.id);
    const treaty = (room.treaties || []).find(t => t.id === treatyId && t.active && (t.a === me?.name || t.b === me?.name));
    if (!me || !treaty) return socket.emit("errorMessage", "That peace treaty is no longer active.");
    if (treaty.breakNoticeBy) return socket.emit("errorMessage", `A one-turn break notice has already been given by ${treaty.breakNoticeBy}.`);
    treaty.breakNoticeBy = me.name;
    treaty.breakAtSeq = (room.turnSeq || 0) + 2;
    addLog(room, `⚠ ${me.name} gave ${t.a === me.name ? treaty.b : treaty.a} one-turn notice to end their peace treaty.`);
    broadcast(room);
  });

  socket.on("attack", ({code,target,access}) => {
    const room=rooms.get(code), err=room && requireTurn(socket,room);
    if (!room) return;
    if (err) return socket.emit("errorMessage",err);
    const p=currentPlayer(room), t=room.territories[target];
    if (!t) return socket.emit("errorMessage","That target does not exist on the game map.");
    if (t.owner===p.name) return socket.emit("errorMessage",`You already control ${target}; you cannot attack your own territory.`);
    if (p.attacked) return socket.emit("errorMessage","You have already used your one attack this turn. End your turn to attack again.");
    if (p.reserve<=0) return socket.emit("errorMessage","You have no reserve infantry left, so you cannot start an attack.");
    if (room.round<10 && t.owner) return socket.emit("errorMessage",`${target} belongs to ${t.owner}. Player wars are locked until round 10; before then you may only attack neutral countries.`);
    if (t.owner) { const treaty = treatyBlocksAttack(room, p.name, t.owner); if (treaty) return socket.emit("errorMessage",`Peace treaty with ${t.owner} blocks this attack. A one-turn notice must be given before the treaty can end.`); }
    // The browser supplies the map geometry calculation. Server validates that it is
    // either a bordering route or an owned-territory ship route within 4,000 miles.
    if (!access || (access.kind!=="border" && access.kind!=="ship"))
      return socket.emit("errorMessage","That move is not possible because the target is neither a bordering country nor a valid ship route from your territory.");
    if (access.kind==="ship" && p.small+p.large<1)
      return socket.emit("errorMessage","That country does not border your empire, and you do not own a ship to reach it.");
    if (access.kind==="ship" && access.distance>RANGE)
      return socket.emit("errorMessage",`That ship route is ${Math.round(access.distance)} miles, beyond the 4,000-mile maximum.`);

    p.attacked=true;
    while (t.defences>0) {
      if (Math.random()<0.5) {
        t.defences--;
        addLog(room,`HEADS — ${target}'s defence was destroyed.`);
      } else {
        addLog(room,`TAILS — ${target}'s defence held. Attack ended.`);
        broadcast(room); return;
      }
    }
    while (p.reserve>0 && t.infantry>0) {
      if (Math.random()<0.5) { t.infantry=Math.max(0,t.infantry-10); }
      else { p.reserve=Math.max(0,p.reserve-10); }
    }
    if (t.infantry<=0) {
      const old=t.owner; t.owner=p.name;
      addLog(room,`★ ${p.name} captured ${target}! ★`);
      if (old) eliminateIfCapitalLost(room,old,target);
      checkGameOver(room);
    } else addLog(room,`${p.name}'s attack on ${target} failed.`);
    broadcast(room);
  });

  socket.on("endTurn", ({code}) => {
    const room=rooms.get(code), err=room && requireTurn(socket,room);
    if (!room) return;
    if (err) return socket.emit("errorMessage",err);
    endTurn(room); broadcast(room);
  });

  socket.on("chat", ({code,text}) => {
    const room=rooms.get(String(code||""));
    const p=room && player(room,socket.id);
    if(!room || !p) return;
    text=String(text||"").trim().slice(0,180);
    if(!text) return;
    const message={name:p.name,text,at:Date.now()};
    room.chat=room.chat||[]; room.chat.push(message);
    if(room.chat.length>100) room.chat.shift();
    io.to(room.code).emit("chat",message);
  });

  socket.on("disconnect", () => {
    analytics.connected = Math.max(0, analytics.connected - 1);
    for (const room of rooms.values()) {
      const p=player(room,socket.id);
      if (!p) continue;
      p.connected=false;
      if (room.hostId===socket.id) {
        const next=room.players.find(x=>x.id!==socket.id && x.connected!==false);
        if (next) room.hostId=next.id;
      }
      addLog(room, `${p.name} disconnected.`);
      broadcast(room);
    }
  });
});

server.listen(process.env.PORT || 3000, () => console.log("World Map Domination running on port 3000"));
