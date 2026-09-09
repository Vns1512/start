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
const RANGE = 5000;

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
    territories: room.territories, selectedBy: room.selectedBy, log: room.log
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
}
function owned(room, p) {
  return Object.values(room.territories).filter(t => t.owner === p.name);
}
function income(room, p) {
  return 2 + owned(room,p).reduce((s,t) => s + (t.name === p.capital ? 0 : t.gold + (t.city||0)), 0);
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

io.on("connection", socket => {
  socket.on("createRoom", ({name}) => {
    name = String(name||"Player").trim().slice(0,24) || "Player";
    const room = {
      code: code(), hostId: socket.id, phase: "lobby", round: 1, current: 0,
      players: [{id:socket.id,name,color:COLORS[0],gold:10,reserve:100,small:0,large:0,alive:true,attacked:false,capital:null}],
      territories: {}, selectedBy: {}, log: ["Lobby created. Share the room code and wait for players."]
    };
    rooms.set(room.code, room);
    socket.join(room.code);
    socket.emit("joined", {code:room.code});
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
    room.players.push({id:socket.id,name,color:COLORS[room.players.length],gold:10,reserve:100,small:0,large:0,alive:true,attacked:false,capital:null});
    socket.join(room.code);
    socket.emit("joined", {code:room.code});
    addLog(room, `${name} joined the lobby.`);
    broadcast(room);
  });

  socket.on("startGame", ({code, territories}) => {
    const room = rooms.get(code);
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit("errorMessage","Only the host can start the game.");
    if (room.players.length < 2) return socket.emit("errorMessage","At least 2 players are required.");
    room.territories = territories || {};
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
    if (room.capitalIndex >= room.players.length) {
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
      const cost=type==="city1"?8:15, size=type==="city1"?1:2;
      if (p.gold<cost || t.city) return socket.emit("errorMessage","Not enough gold or a city already exists there.");
      p.gold-=cost; t.city=size; addLog(room,`${p.name} built a ${size===1?"small":"large"} city in ${country}.`);
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
