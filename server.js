const WebSocket = require('ws');
const http = require('http');

const PORT = 4000;

// Binary protocol — event type IDs
const EVT = {
    SYNC: 1, TILT: 2,
    MY_ID: 10, ERROR_MSG: 11, JOINED: 12, ROOM_UPDATE: 13,
    LEFT_ROOM: 14, GAME_STARTED: 15, GAME_OVER: 16, ROOM_LIST: 17,
    CREATE_ROOM: 20, JOIN_ROOM: 21, READY: 22, START_GAME: 23,
    GET_ROOMS: 24, LEAVE_ROOM: 25,
};
const EVT_BY_NAME = Object.fromEntries(Object.entries(EVT).map(([k, v]) => [k.toLowerCase(), v]));
const EVT_BY_ID = Object.fromEntries(Object.entries(EVT).map(([k, v]) => [v, k.toLowerCase()]));

function packJson(evtId, data) {
    if (data === undefined) return Buffer.from([evtId]);
    const json = Buffer.from(JSON.stringify(data), 'utf8');
    const buf = Buffer.alloc(1 + json.length);
    buf[0] = evtId;
    json.copy(buf, 1);
    return buf;
}

function packSync(players, timeLeft) {
    const entries = Object.entries(players);
    const buf = Buffer.alloc(3 + entries.length * 16);
    buf[0] = EVT.SYNC;
    buf[1] = timeLeft;
    buf[2] = entries.length;
    let off = 3;
    for (const [id, p] of entries) {
        buf.writeUInt32LE(Number(id), off);
        buf.writeFloatLE(p.x, off + 4);
        buf.writeFloatLE(p.y, off + 8);
        buf.writeFloatLE(p.score, off + 12);
        off += 16;
    }
    return buf;
}
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket server is active.');
});
const wss = new WebSocket.Server({ server });

const ROOMS = {};
const BALL_RADIUS = 10;
const MAX_PLAYERS = 4;
const COLORS = ['#F43F5E', '#38BDF8', '#10B981', '#F59E0B'];

function generateMap() {
    let MAP_WIDTH = 800;
    let MAP_HEIGHT = 600;
    let GRID_SIZE = 40;

    let kingZone = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2, radius: GRID_SIZE };
    let mazeWalls = [];

    function defaultFrameWalls() {
        return [
            { id: '1', x: 0, y: 0, width: MAP_WIDTH, height: 40 },
            { id: '2', x: 0, y: MAP_HEIGHT - 40, width: MAP_WIDTH, height: 40 },
            { id: '3', x: 0, y: 0, width: 40, height: MAP_HEIGHT },
            { id: '4', x: MAP_WIDTH - 40, y: 0, width: 40, height: MAP_HEIGHT },
        ];
    }

    const cols = Math.floor(MAP_WIDTH / GRID_SIZE) - 2;
    const rows = Math.floor(MAP_HEIGHT / GRID_SIZE) - 2;
    const ENTRY_SIZE = 3;

    let grid = new Array(cols);
    for (let i = 0; i < cols; i++) {
        grid[i] = new Array(rows);
        for (let j = 0; j < rows; j++) {
            grid[i][j] = {
                x: i, y: j,
                visited: false,
                walls: { top: true, right: true, bottom: true, left: true }
            };
        }
    }

    let stack = [];
    let startX = Math.floor(cols / 2);
    let startY = Math.floor(rows / 2);
    grid[startX][startY].visited = true;
    stack.push(grid[startX][startY]);

    function getNeighbor(nx, ny) {
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) return null;
        return grid[nx][ny];
    }

    while (stack.length > 0) {
        let cell = stack[stack.length - 1];
        let neighbors = [];

        let t = getNeighbor(cell.x, cell.y - 1); if (t && !t.visited) neighbors.push({ cell: t, dir: 'top' });
        let r = getNeighbor(cell.x + 1, cell.y); if (r && !r.visited) neighbors.push({ cell: r, dir: 'right' });
        let b = getNeighbor(cell.x, cell.y + 1); if (b && !b.visited) neighbors.push({ cell: b, dir: 'bottom' });
        let l = getNeighbor(cell.x - 1, cell.y); if (l && !l.visited) neighbors.push({ cell: l, dir: 'left' });

        if (neighbors.length > 0) {
            let n = neighbors[Math.floor(Math.random() * neighbors.length)];
            if (n.dir === 'top') { cell.walls.top = false; n.cell.walls.bottom = false; }
            if (n.dir === 'right') { cell.walls.right = false; n.cell.walls.left = false; }
            if (n.dir === 'bottom') { cell.walls.bottom = false; n.cell.walls.top = false; }
            if (n.dir === 'left') { cell.walls.left = false; n.cell.walls.right = false; }

            n.cell.visited = true;
            stack.push(n.cell);
        } else {
            stack.pop();
        }
    }

    function carveRegion(sx, sy, w, h) {
        for (let i = sx; i < sx + w; i++) {
            for (let j = sy; j < sy + h; j++) {
                let cell = getNeighbor(i, j);
                if (!cell) continue;

                let rightCell = getNeighbor(i + 1, j);
                if (i < sx + w - 1 && rightCell) {
                    cell.walls.right = false;
                    rightCell.walls.left = false;
                }
                let bottomCell = getNeighbor(i, j + 1);
                if (j < sy + h - 1 && bottomCell) {
                    cell.walls.bottom = false;
                    bottomCell.walls.top = false;
                }
            }
        }
    }

    carveRegion(0, 0, ENTRY_SIZE, ENTRY_SIZE);
    carveRegion(0, rows - ENTRY_SIZE, ENTRY_SIZE, ENTRY_SIZE);
    carveRegion(cols - ENTRY_SIZE, 0, ENTRY_SIZE, ENTRY_SIZE);
    carveRegion(cols - ENTRY_SIZE, rows - ENTRY_SIZE, ENTRY_SIZE, ENTRY_SIZE);

    const kzSize = 4;
    carveRegion(Math.floor(cols / 2) - kzSize / 2, Math.floor(rows / 2) - kzSize / 2, kzSize, kzSize);

    let removalChance = 0.05;

    if (removalChance > 0) {
        for (let i = 1; i < cols - 1; i++) {
            for (let j = 1; j < rows - 1; j++) {
                if (Math.random() < removalChance) {
                    let cell = grid[i][j];
                    let dirs = [];
                    if (cell.walls.top) dirs.push('top');
                    if (cell.walls.right) dirs.push('right');
                    if (cell.walls.bottom) dirs.push('bottom');
                    if (cell.walls.left) dirs.push('left');

                    if (dirs.length > 0) {
                        let d = dirs[Math.floor(Math.random() * dirs.length)];
                        if (d === 'top') { cell.walls.top = false; grid[i][j - 1].walls.bottom = false; }
                        if (d === 'right') { cell.walls.right = false; grid[i + 1][j].walls.left = false; }
                        if (d === 'bottom') { cell.walls.bottom = false; grid[i][j + 1].walls.top = false; }
                        if (d === 'left') { cell.walls.left = false; grid[i - 1][j].walls.right = false; }
                    }
                }
            }
        }
    }

    let wallIdCounter = 5;
    for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
            let cell = grid[i][j];
            let px = (i + 1) * GRID_SIZE;
            let py = (j + 1) * GRID_SIZE;

            if (cell.walls.top) mazeWalls.push({ id: (wallIdCounter++).toString(), x: px, y: py, width: GRID_SIZE, height: 4 });
            if (cell.walls.left) mazeWalls.push({ id: (wallIdCounter++).toString(), x: px, y: py, width: 4, height: GRID_SIZE });
            if (j === rows - 1 && cell.walls.bottom) mazeWalls.push({ id: (wallIdCounter++).toString(), x: px, y: py + GRID_SIZE - 4, width: GRID_SIZE, height: 4 });
            if (i === cols - 1 && cell.walls.right) mazeWalls.push({ id: (wallIdCounter++).toString(), x: px + GRID_SIZE - 4, y: py, width: 4, height: GRID_SIZE });
        }
    }

    return {
        width: MAP_WIDTH,
        height: MAP_HEIGHT,
        walls: [...defaultFrameWalls(), ...mazeWalls],
        kingZone: kingZone
    };
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

let connectionIdCounter = 1;

wss.on('connection', (ws) => {
    ws.id = connectionIdCounter++;
    let currentRoom = null;

    const sendToRoom = (roomId, event, data) => {
        const room = ROOMS[roomId];
        if (!room) return;
        const packed = event === 'sync'
            ? packSync(data.players, data.timeLeft)
            : packJson(EVT_BY_NAME[event], data);
        for (const pid in room.players) {
            const clientWs = room.players[pid].ws;
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(packed);
            }
        }
    };

    const sendToSelf = (event, data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(packJson(EVT_BY_NAME[event], data));
        }
    };

    ws.on('message', (message) => {
        try {
            const buf = Buffer.isBuffer(message) ? message : Buffer.from(message);
            const evtId = buf[0];

            if (evtId === EVT.TILT) {
                if (!currentRoom || !ROOMS[currentRoom]) return;
                const room = ROOMS[currentRoom];
                if (room.state === 'IN_GAME' && room.players[ws.id]) {
                    room.players[ws.id].tilt = {
                        x: buf.readFloatLE(1),
                        y: buf.readFloatLE(5),
                    };
                }
                return;
            }

            const event = EVT_BY_ID[evtId];
            const data = buf.length > 1 ? JSON.parse(buf.slice(1).toString('utf8')) : undefined;

            if (event === 'create_room') {
                const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
                ROOMS[roomId] = {
                    id: roomId,
                    hostId: ws.id,
                    state: 'LOBBY', // LOBBY or IN_GAME
                    players: {}, // id -> data
                    physicsLoop: null,
                    map: generateMap(),
                };
                joinRoom(ws, roomId, data.nick);
            }
            else if (event === 'join_room') {
                const { roomCode, nick } = data;
                const room = ROOMS[roomCode];
                if (room) {
                    if (Object.keys(room.players).length >= MAX_PLAYERS) {
                        return sendToSelf('error_msg', 'Oda dolu (Max 4).');
                    }
                    if (room.state !== 'LOBBY') {
                        return sendToSelf('error_msg', 'Oyun çoktan başlamış.');
                    }
                    joinRoom(ws, roomCode, nick);
                } else {
                    sendToSelf('error_msg', 'Oda bulunamadı.');
                }
            }
            else if (event === 'ready') {
                if (!currentRoom || !ROOMS[currentRoom]) return;
                const room = ROOMS[currentRoom];
                if (room.players[ws.id]) {
                    room.players[ws.id].ready = !room.players[ws.id].ready;
                    sendToRoom(currentRoom, 'room_update', getRoomData(room));
                }
            }
            else if (event === 'start_game') {
                if (!currentRoom || !ROOMS[currentRoom]) return;
                const room = ROOMS[currentRoom];
                if (room.hostId === ws.id) {
                    let allReady = true;
                    for (const pid in room.players) {
                        if (!room.players[pid].ready) allReady = false;
                    }
                    if (allReady) {
                        startGame(room, sendToRoom);
                    } else {
                        sendToSelf('error_msg', 'Herkes hazır olmadan başlatılamaz!');
                    }
                }
            }
            else if (event === 'get_rooms') {
                const availableRooms = Object.values(ROOMS)
                    .filter(r => r.state === 'LOBBY' && Object.keys(r.players).length < MAX_PLAYERS)
                    .map(r => ({ id: r.id, hostId: r.hostId, count: Object.keys(r.players).length }));
                sendToSelf('room_list', availableRooms);
            }
            else if (event === 'leave_room') {
                handleDisconnect();
                currentRoom = null;
                sendToSelf('left_room');
            }
        } catch (err) {
            // ignore malformed messages
        }
    });

    const handleDisconnect = () => {
        if (currentRoom && ROOMS[currentRoom]) {
            const room = ROOMS[currentRoom];
            delete room.players[ws.id];
            if (Object.keys(room.players).length === 0) {
                if (room.physicsLoop) clearInterval(room.physicsLoop);
                delete ROOMS[currentRoom];
            } else {
                if (room.hostId === ws.id) {
                    room.hostId = parseInt(Object.keys(room.players)[0], 10);
                }
                sendToRoom(currentRoom, 'room_update', getRoomData(room));
            }
        }
    };

    ws.on('close', handleDisconnect);
    ws.on('error', handleDisconnect);

    function joinRoom(wsReference, roomId, nick) {
        currentRoom = roomId;
        const room = ROOMS[roomId];

        // Assign color
        const usedColors = Object.values(room.players).map(p => p.color);
        const availableColors = COLORS.filter(c => !usedColors.includes(c));
        const color = availableColors.length > 0 ? availableColors[0] : '#ffffff';

        room.players[wsReference.id] = {
            ws: wsReference,
            id: wsReference.id,
            nick: nick || 'Guest',
            color: color,
            ready: room.hostId === wsReference.id ? true : false,
            score: 0,
            x: room.map.width / 2 + (Math.random() * 200 - 100),
            y: room.map.height / 2 + (Math.random() * 200 - 100),
            vx: 0,
            vy: 0,
            tilt: { x: 0, y: 0 },
            isHost: room.hostId === wsReference.id
        };

        sendToSelf('my_id', wsReference.id);
        sendToRoom(roomId, 'room_update', getRoomData(room));
        sendToSelf('joined', roomId);
    }
});

function getRoomData(room) {
    return {
        id: room.id,
        hostId: room.hostId,
        state: room.state,
        players: Object.values(room.players).map(p => ({
            id: p.id,
            nick: p.nick,
            color: p.color,
            ready: p.ready,
            score: p.score,
            isHost: p.id === room.hostId
        }))
    };
}

function startGame(room, sendToRoomFunc) {
    room.state = 'IN_GAME';

    // Reset positions
    const spawns = [
        { x: 80, y: 80 },
        { x: room.map.width - 80, y: 80 },
        { x: 80, y: room.map.height - 80 },
        { x: room.map.width - 80, y: room.map.height - 80 },
    ];
    let i = 0;
    for (const pid in room.players) {
        room.players[pid].score = 0;
        room.players[pid].x = spawns[i % 4].x;
        room.players[pid].y = spawns[i % 4].y;
        room.players[pid].vx = 0;
        room.players[pid].vy = 0;
        i++;
    }

    room.ticksLeft = 60 * 40; // 60 seconds at 40 Hz

    sendToRoomFunc(room.id, 'game_started', {
        map_width: room.map.width,
        map_height: room.map.height,
        walls: room.map.walls,
        king_zone: room.map.kingZone,
        ball_radius: BALL_RADIUS
    });

    room.physicsLoop = setInterval(() => {
        updatePhysics(room);
        room.ticksLeft--;

        // Broadcast state
        const state = { players: {}, timeLeft: Math.ceil(room.ticksLeft / 40) };
        let maxScore = -1;
        let winnerNick = null;

        for (const pid in room.players) {
            const p = room.players[pid];
            state.players[pid] = {
                x: p.x,
                y: p.y,
                score: p.score
            };

            if (p.score > maxScore) {
                maxScore = p.score;
                winnerNick = p.nick;
            }
        }

        sendToRoomFunc(room.id, 'sync', state);

        if (room.ticksLeft <= 0) {
            clearInterval(room.physicsLoop);
            room.state = 'LOBBY';
            for (const pid in room.players) room.players[pid].ready = false;
            sendToRoomFunc(room.id, 'game_over', { winner: winnerNick || 'Beraberlik' });
            sendToRoomFunc(room.id, 'room_update', getRoomData(room));
        }

    }, 1000 / 40); // 40 Hz
}

function updatePhysics(room) {
    const players = Object.values(room.players);

    for (const p of players) {
        // Apply tilt forces. Slower movement per request
        const sensitivity = 0.6;
        p.vx += p.tilt.x * sensitivity;
        p.vy -= p.tilt.y * sensitivity; // Inverted y based on accel

        p.vx *= 0.98; // Slower movement => more friction
        p.vy *= 0.98;

        p.x += p.vx;
        p.y += p.vy;
    }

    // Player vs Player collisions
    for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
            const p1 = players[i];
            const p2 = players[j];

            const dx = p1.x - p2.x;
            const dy = p1.y - p2.y;
            const distanceSq = dx * dx + dy * dy;

            if (distanceSq < (BALL_RADIUS * 2) * (BALL_RADIUS * 2)) {
                const distance = Math.sqrt(distanceSq);
                if (distance === 0) continue;

                const overlap = (BALL_RADIUS * 2) - distance;
                const nx = dx / distance;
                const ny = dy / distance;

                // Push apart (mass = 1)
                p1.x += nx * (overlap / 2);
                p1.y += ny * (overlap / 2);
                p2.x -= nx * (overlap / 2);
                p2.y -= ny * (overlap / 2);

                const rvx = p1.vx - p2.vx;
                const rvy = p1.vy - p2.vy;
                const rVelSq = rvx * rvx + rvy * rvy;
                const impactSpeed = Math.sqrt(rVelSq);

                const dot1 = p1.vx * nx + p1.vy * ny;
                const dot2 = p2.vx * nx + p2.vy * ny;

                const m1 = dot2;
                const m2 = dot1;

                p1.vx += (m1 - dot1) * nx * 1.5;
                p1.vy += (m1 - dot1) * ny * 1.5;
                p2.vx += (m2 - dot2) * nx * 1.5;
                p2.vy += (m2 - dot2) * ny * 1.5;
            }
        }
    }

    // King Zone Score check logic
    for (const p of players) {
        const kDx = p.x - room.map.kingZone.x;
        const kDy = p.y - room.map.kingZone.y;
        if (Math.sqrt(kDx * kDx + kDy * kDy) < room.map.kingZone.radius) {
            p.score += 100 / 40; // ~100 points per sec
        }
    }

    // Walls applied LAST so PvP bounces can't push someone inside a wall
    for (const p of players) {
        for (const wall of room.map.walls) {
            const closestX = clamp(p.x, wall.x, wall.x + wall.width);
            const closestY = clamp(p.y, wall.y, wall.y + wall.height);
            const dx = p.x - closestX;
            const dy = p.y - closestY;
            const distanceSq = dx * dx + dy * dy;

            if (distanceSq < BALL_RADIUS * BALL_RADIUS) {
                const distance = Math.sqrt(distanceSq);
                if (distance === 0) continue;
                const overlap = BALL_RADIUS - distance;
                const nx = dx / distance;
                const ny = dy / distance;

                p.x += nx * overlap;
                p.y += ny * overlap;

                const dot = p.vx * nx + p.vy * ny;
                const bounce = 0.5;
                p.vx = (p.vx - (1 + bounce) * dot * nx) * 0.9;
                p.vy = (p.vy - (1 + bounce) * dot * ny) * 0.9;
            }
        }
    }
}

server.listen(PORT, () => {
    console.log(`WebSocket server listening on port ${PORT}`);
});
