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
    round: room.round, current: room.current, capitalIndex: room.capitalIndex ?? null,
    players: room.players,
    chat: room.chat || [],
    territories: room.territories, selectedBy: room.selectedBy, log: room.log, singlePlayer: !!room.singlePlayer
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
  if (target.defences > 0) {
    if (Math.random() < 0.5) target.defences--;
    else { addLog(room, `TAILS — ${target.name}'s defence held against ${p.name}.`); return; }
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
    endTurn(room);
    broadcast(room);
    runAI(room);
  }, 700);
}

io.on("connection", socket => {
  socket.on("createRoom", ({name}) => {
    name = String(name||"Player").trim().slice(0,24) || "Player";
    const room = {
      code: code(), hostId: socket.id, phase: "lobby", round: 1, current: 0,
      players: [{id:socket.id,name,color:COLORS[0],gold:10,reserve:100,small:0,large:0,alive:true,attacked:false,capital:null,smallCities:0,largeCities:0}],
      territories: {}, selectedBy: {}, chat: [], log: ["Lobby created. Share the room code and wait for players."]
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
    const room = {code:code(),hostId:socket.id,phase:"capital",round:1,current:0,capitalIndex:0,players,territories:territories||{},adjacency:adjacency||{},selectedBy:{},chat:[],log:["Single-player campaign started. You are facing four AI commanders."],singlePlayer:true};
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
    addLog(room, "Game started. Players are choosing capitals.");
    broadcast(room);
  });

  socket.on("chooseCapital", ({code,country}) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "capital") return;
    const p = room.players[room.capitalIndex];
    if (!p || p.id !== socket.id) return socket.emit("errorMessage","It is not your turn to choose a capital.");
    const t = room.territories[country];
    if (!t || t.owner || ["USA","Russia","China"].includes(country)) return socket.emit("errorMessage","That country cannot be chosen as a capital.");
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
    if (!(type in costs) || p.gold < costs[type]) return socket.emit("errorMessage","Not enough gold.");
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
      if (p.gold<2 || t.defences>=3) return socket.emit("errorMessage","Need 2 gold and fewer than 3 defences.");
      p.gold-=2; t.defences++; addLog(room,`${p.name} built a defence in ${country}.`);
    } else {
      const cost=type==="city1"?8:15, key=type==="city1"?"smallCities":"largeCities";
      const countryQuota=t.gold>=2?2:1;
      const countryCityCount=(t.smallCities||0)+(t.largeCities||0);
      const playerCityCount=Object.values(room.territories).reduce((sum,x)=>sum+(x.owner===p.name?(x[key]||0):0),0);
      if (p.gold<cost) return socket.emit("errorMessage","Not enough gold.");
      if (playerCityCount>=5) return socket.emit("errorMessage",`You can build a maximum of 5 ${type==="city1"?"small":"large"} cities.`);
      if (countryCityCount>=countryQuota) return socket.emit("errorMessage","This country has reached its city limit under the Constitution.");
      p.gold-=cost;
      t[key]=(t[key]||0)+1;
      t.city=(t.smallCities||0)+(t.largeCities||0);
      addLog(room,`${p.name} built a ${type==="city1"?"small":"large"} city in ${country}.`);
    }
    broadcast(room);
  });

  socket.on("attack", ({code,target,access}) => {
    const room=rooms.get(code), err=room && requireTurn(socket,room);
    if (!room) return;
    if (err) return socket.emit("errorMessage",err);
    const p=currentPlayer(room), t=room.territories[target];
    if (!t || t.owner===p.name || p.attacked || p.reserve<=0) return socket.emit("errorMessage","This attack is not available.");
    if (room.round<10 && t.owner) return socket.emit("errorMessage","Player-versus-player attacks begin in round 10.");
    // The browser supplies the map geometry calculation. Server validates that it is
    // either a bordering route or an owned-territory ship route within 5,000 miles.
    if (!access || (access.kind!=="border" && access.kind!=="ship"))
      return socket.emit("errorMessage","Invalid attack route.");
    if (access.kind==="ship" && (p.small+p.large<1 || access.distance>RANGE))
      return socket.emit("errorMessage","Ship attack is out of range or no ship is available.");

    p.attacked=true;
    if (t.defences>0) {
      if (Math.random()<0.5) { t.defences--; addLog(room,`HEADS — ${target}'s defence was destroyed.`); }
      else { addLog(room,`TAILS — ${target}'s defence held. Attack ended.`); broadcast(room); return; }
    }
    while (p.reserve>0 && t.infantry>0) {
      if (Math.random()<0.5) { t.infantry=Math.max(0,t.infantry-10); }
      else { p.reserve=Math.max(0,p.reserve-10); }
    }
    if (t.infantry<=0) {
      const old=t.owner; t.owner=p.name;
      addLog(room,`★ ${p.name} captured ${target}! ★`);
      if (old) eliminateIfCapitalLost(room,old,target);
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
