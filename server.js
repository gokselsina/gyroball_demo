const WebSocket = require('ws');
const http = require('http');

const PORT = 4000;

// Binary protocol — event type IDs
const EVT = {
    SYNC: 1, TILT: 2,
    MY_ID: 10, ERROR_MSG: 11, JOINED: 12, ROOM_UPDATE: 13,
    LEFT_ROOM: 14, GAME_STARTED: 15, GAME_OVER: 16, ROOM_LIST: 17,
    ZONE_UPDATE: 18, ULTI_UPDATE: 19,
    CREATE_ROOM: 20, JOIN_ROOM: 21, READY: 22, START_GAME: 23,
    GET_ROOMS: 24, LEAVE_ROOM: 25, FIRE_ULTI: 26, AIM_ULTI: 27,
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

const ULTI_COOLDOWN = 200; // 5s at 40Hz
const PROJECTILE_SPEED = 12; // Faster sweep
const PROJECTILE_RADIUS = 45; // Wide cone reach
const PROJ_WALL_HITBOX = 8; // Small collision point for walls
const ULTI_TYPES = {
    shockwave: { maxDistance: 180, projectile: true },
    freeze: { maxDistance: 200, projectile: true },
    cage: { maxDistance: 160, projectile: true },
    speedburst: { maxDistance: 180, projectile: false },
};

const GAME_MODES = {
    labyrinth: { name: 'Labirent', generate: () => generateLabyrinthMap() },
    arena: { name: 'Arena', generate: () => generateArenaMap() },
};

function generateLabyrinthMap() {
    let MAP_WIDTH = 800;
    let MAP_HEIGHT = 600;
    let GRID_SIZE = 40;

    let kingZone = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2, radius: GRID_SIZE, name: 'Kale' };
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
        kingZones: [kingZone]
    };
}

function generateArenaMap() {
    const MAP_WIDTH = 800;
    const MAP_HEIGHT = 600;

    // Frame walls
    const frameWalls = [
        { id: '1', x: 0, y: 0, width: MAP_WIDTH, height: 40 },
        { id: '2', x: 0, y: MAP_HEIGHT - 40, width: MAP_WIDTH, height: 40 },
        { id: '3', x: 0, y: 0, width: 40, height: MAP_HEIGHT },
        { id: '4', x: MAP_WIDTH - 40, y: 0, width: 40, height: MAP_HEIGHT },
    ];

    // Multiple king zones at strategic positions
    const kingZones = [
        { x: 200, y: 200, radius: 45, name: 'Kuzey' },
        { x: 600, y: 400, radius: 45, name: 'Güney' },
        { x: 400, y: 300, radius: 40, name: 'Merkez' },
    ];

    // Spawn corners to avoid (80px squares at each corner)
    const spawnCorners = [
        { x: 40, y: 40, w: 120, h: 120 },
        { x: MAP_WIDTH - 160, y: 40, w: 120, h: 120 },
        { x: 40, y: MAP_HEIGHT - 160, w: 120, h: 120 },
        { x: MAP_WIDTH - 160, y: MAP_HEIGHT - 160, w: 120, h: 120 },
    ];

    function overlapsZone(wx, wy, ww, wh) {
        // Check king zone overlap
        for (const kz of kingZones) {
            const closestX = clamp(kz.x, wx, wx + ww);
            const closestY = clamp(kz.y, wy, wy + wh);
            const dx = kz.x - closestX;
            const dy = kz.y - closestY;
            if (Math.sqrt(dx * dx + dy * dy) < kz.radius + 20) return true;
        }
        // Check spawn corner overlap
        for (const sc of spawnCorners) {
            if (wx < sc.x + sc.w && wx + ww > sc.x && wy < sc.y + sc.h && wy + wh > sc.y) return true;
        }
        return false;
    }

    // Generate random cover walls
    const coverWalls = [];
    let wallId = 5;
    const numWalls = 15 + Math.floor(Math.random() * 11); // 15-25 walls
    let attempts = 0;

    while (coverWalls.length < numWalls && attempts < 200) {
        attempts++;
        // Random wall dimensions: mix of horizontal and vertical cover
        const isHorizontal = Math.random() > 0.5;
        const w = isHorizontal ? (60 + Math.floor(Math.random() * 80)) : 8;
        const h = isHorizontal ? 8 : (60 + Math.floor(Math.random() * 80));
        const x = 50 + Math.floor(Math.random() * (MAP_WIDTH - 100 - w));
        const y = 50 + Math.floor(Math.random() * (MAP_HEIGHT - 100 - h));

        if (!overlapsZone(x, y, w, h)) {
            coverWalls.push({ id: (wallId++).toString(), x, y, width: w, height: h });
        }
    }

    return {
        width: MAP_WIDTH,
        height: MAP_HEIGHT,
        walls: [...frameWalls, ...coverWalls],
        kingZones: kingZones
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
                const mode = (data.gameMode && GAME_MODES[data.gameMode]) ? data.gameMode : 'labyrinth';
                ROOMS[roomId] = {
                    id: roomId,
                    hostId: ws.id,
                    state: 'LOBBY', // LOBBY or IN_GAME
                    gameMode: mode,
                    players: {}, // id -> data
                    physicsLoop: null,
                    map: GAME_MODES[mode].generate(),
                    projectiles: [], // For ultis
                    cageWalls: [],   // For ultis
                    nextProjId: 1,
                    nextCageId: 1,
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
            else if (event === 'fire_ulti') {
                if (!currentRoom || !ROOMS[currentRoom]) return;
                const room = ROOMS[currentRoom];
                const player = room.players[ws.id];
                if (room.state === 'IN_GAME' && player && player.ultiCooldown <= 0) {
                    const ultiType = data.type; // e.g., 'FREEZE_BOMB', 'CAGE_TRAP'
                    const ultiConfig = ULTI_TYPES[ultiType];
                    const dirX = data.dx;
                    const dirY = data.dy;

                    if (ultiConfig) {
                        player.activeAim = null; // Clear aim visually

                        // Normalize direction
                        const len = Math.sqrt(dirX * dirX + dirY * dirY);
                        if (len > 0.01) {
                            const nx = dirX / len;
                            const ny = dirY / len;

                            if (ultiType === 'speedburst') {
                                player.vx += nx * 12;
                                player.vy += ny * 12;
                            } else {
                                room.projectiles.push({
                                    id: room.nextProjId++,
                                    ownerId: ws.id,
                                    ownerColor: player.color, // Add owner color for rendering
                                    type: ultiType,
                                    x: player.x,
                                    y: player.y,
                                    vx: nx * PROJECTILE_SPEED,
                                    vy: ny * PROJECTILE_SPEED,
                                    facingAngle: Math.atan2(ny, nx),
                                    distanceTraveled: 0,
                                    maxDistance: ultiConfig.maxDistance,
                                });
                            }
                            player.ultiCooldown = ULTI_COOLDOWN;

                            // Immediately broadcast ulti_update to prevent short-lived projectiles from being missed
                            const activeAimsPacked = {};
                            for (const pid in room.players) {
                                if (room.players[pid].activeAim) {
                                    activeAimsPacked[pid] = room.players[pid].activeAim;
                                }
                            }

                            sendToRoom(currentRoom, 'ulti_update', {
                                projectiles: room.projectiles.map(p => ({
                                    id: p.id, type: p.type, x: p.x, y: p.y, radius: p.radius,
                                    ownerColor: p.ownerColor, facingAngle: p.facingAngle
                                })),
                                cageWalls: room.cageWalls.map(c => ({
                                    id: c.id, x: c.x, y: c.y, width: c.width, height: c.height
                                })),
                                cooldowns: Object.fromEntries(Object.entries(room.players).map(([k, v]) => [k, v.ultiCooldown])),
                                activeAims: activeAimsPacked
                            });
                        }
                    }
                }
            }
            else if (event === 'aim_ulti') {
                if (!currentRoom || !ROOMS[currentRoom]) return;
                const room = ROOMS[currentRoom];
                const player = room.players[ws.id];
                if (room.state === 'IN_GAME' && player) {
                    player.activeAim = data ? { type: data.type, dx: data.dx, dy: data.dy } : null;
                }
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
            ultiCooldown: 0,
            frozenTicks: 0,
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
        gameMode: room.gameMode,
        gameModeName: GAME_MODES[room.gameMode]?.name || room.gameMode,
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
        room.players[pid].tilt = { x: 0, y: 0 };
        room.players[pid].ultiCooldown = 0;
        room.players[pid].frozenTicks = 0;
        i++;
    }

    room.ticksLeft = 180 * 40; // 180 seconds at 40 Hz
    room.projectiles = [];
    room.cageWalls = [];
    room.nextProjId = 1;
    room.nextCageId = 1;

    // Initialize zone ownership state
    room.zoneStates = room.map.kingZones.map((kz, idx) => ({
        id: idx,
        name: kz.name || `Bölge ${idx + 1}`,
        x: kz.x,
        y: kz.y,
        radius: kz.radius,
        ownerId: null,     // player ID who owns this zone
        ownerColor: null,
        ownerNick: null,
        captureProgress: {},  // { playerId: progress (0-100) }
    }));

    sendToRoomFunc(room.id, 'game_started', {
        map_width: room.map.width,
        map_height: room.map.height,
        walls: room.map.walls,
        king_zones: room.map.kingZones,
        game_mode: room.gameMode,
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

        // Broadcast zone ownership state every 10 ticks (~4Hz)
        if (room.ticksLeft % 10 === 0 && room.zoneStates) {
            sendToRoomFunc(room.id, 'zone_update', room.zoneStates.map(z => ({
                id: z.id,
                name: z.name,
                ownerId: z.ownerId,
                ownerColor: z.ownerColor,
                ownerNick: z.ownerNick,
                captureProgress: z.captureProgress,
            })));
        }

        // Broadcast ulti state every 2 ticks (~20Hz)
        const hasProjectiles = room.projectiles.length > 0 || room.cageWalls.length > 0;
        const hasAims = Object.values(room.players).some(p => p.activeAim);
        const hasCooldowns = Object.values(room.players).some(p => p.ultiCooldown > 0);

        const needsUltiUpdate = hasProjectiles || hasAims || hasCooldowns;

        if (room.ticksLeft % 2 === 0 && (needsUltiUpdate || room.lastNeedsUltiUpdate)) {
            const activeAimsPacked = {};
            for (const pid in room.players) {
                if (room.players[pid].activeAim) {
                    activeAimsPacked[pid] = room.players[pid].activeAim;
                }
            }

            sendToRoomFunc(room.id, 'ulti_update', {
                projectiles: room.projectiles.map(p => ({
                    id: p.id, type: p.type, x: p.x, y: p.y, radius: p.radius,
                    ownerColor: p.ownerColor, facingAngle: p.facingAngle
                })),
                cageWalls: room.cageWalls.map(c => ({
                    id: c.id, x: c.x, y: c.y, width: c.width, height: c.height
                })),
                cooldowns: Object.fromEntries(Object.entries(room.players).map(([k, v]) => [k, v.ultiCooldown])),
                activeAims: activeAimsPacked
            });

            room.lastNeedsUltiUpdate = needsUltiUpdate;
        }

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

    const friction = room.gameMode === 'labyrinth' ? 1.0 : 0.98;

    // Apply freeze and cooldown
    for (const p of players) {
        if (p.frozenTicks > 0) {
            p.tilt = { x: 0, y: 0 }; // Disable tilt input
            p.frozenTicks--;
        }
        if (p.ultiCooldown > 0) p.ultiCooldown--;
    }

    // Apply tilt
    for (const p of players) {
        // Only apply tilt if not frozen
        if (p.frozenTicks <= 0) {
            const sensitivity = 0.6;
            p.vx += p.tilt.x * sensitivity;
            p.vy -= p.tilt.y * sensitivity; // Inverted y based on accel
        }

        p.vx *= friction;
        p.vy *= friction;
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

    // King Zone Ownership & Scoring logic
    if (room.zoneStates) {
        const CAPTURE_SPEED = 2.5; // progress per tick (100 = captured, ~1 sec)
        const CAPTURE_DECAY = 1.0; // decay per tick when not in zone
        const OWNER_SCORE_RATE = 50 / 40; // passive pts/sec for owning a zone
        const CONTEST_SCORE_RATE = 100 / 40; // active pts/sec for being in own zone

        for (const zone of room.zoneStates) {
            // Find which players are inside this zone
            const playersInZone = [];
            for (const p of players) {
                const kDx = p.x - zone.x;
                const kDy = p.y - zone.y;
                if (Math.sqrt(kDx * kDx + kDy * kDy) < zone.radius) {
                    playersInZone.push(p);
                }
            }

            // Update capture progress
            for (const p of players) {
                if (!zone.captureProgress[p.id]) zone.captureProgress[p.id] = 0;

                if (playersInZone.includes(p)) {
                    // Player is in zone: increase their capture progress
                    // If someone else owns it, they need to neutralize first
                    if (zone.ownerId && zone.ownerId !== p.id) {
                        // Decrease owner's progress instead
                        zone.captureProgress[zone.ownerId] = Math.max(0,
                            (zone.captureProgress[zone.ownerId] || 0) - CAPTURE_SPEED);
                        // If owner's progress hits 0, zone becomes neutral
                        if (zone.captureProgress[zone.ownerId] <= 0) {
                            zone.ownerId = null;
                            zone.ownerColor = null;
                            zone.ownerNick = null;
                        }
                    } else {
                        // Capture / reinforce own zone
                        zone.captureProgress[p.id] = Math.min(100,
                            zone.captureProgress[p.id] + CAPTURE_SPEED);
                    }

                    // Check if captured
                    if (!zone.ownerId && zone.captureProgress[p.id] >= 100) {
                        zone.ownerId = p.id;
                        zone.ownerColor = p.color;
                        zone.ownerNick = p.nick;
                    }
                } else {
                    // Player not in zone: slow decay (except owner keeps stable)
                    if (p.id !== zone.ownerId) {
                        zone.captureProgress[p.id] = Math.max(0,
                            zone.captureProgress[p.id] - CAPTURE_DECAY);
                    }
                }
            }

            // Scoring: owner gets passive points, bonus if physically present
            if (zone.ownerId && room.players[zone.ownerId]) {
                room.players[zone.ownerId].score += OWNER_SCORE_RATE;
                if (playersInZone.find(p => p.id === zone.ownerId)) {
                    room.players[zone.ownerId].score += CONTEST_SCORE_RATE;
                }
            }
        }
    }

    // Update Projectiles & Cage Walls
    const toRemoveProj = [];
    const activeWallsForProj = [...room.map.walls, ...room.cageWalls.map(c => ({ x: c.x, y: c.y, width: c.w, height: c.h }))];

    for (const proj of room.projectiles) {
        proj.x += proj.vx;
        proj.y += proj.vy;
        proj.distanceTraveled += PROJECTILE_SPEED;

        if (proj.distanceTraveled >= proj.maxDistance) { toRemoveProj.push(proj.id); continue; }

        let hitWall = false;
        for (const wall of activeWallsForProj) {
            const cx = clamp(proj.x, wall.x, wall.x + wall.width);
            const cy = clamp(proj.y, wall.y, wall.y + wall.height);
            const dx = proj.x - cx, dy = proj.y - cy;
            if (dx * dx + dy * dy < PROJ_WALL_HITBOX * PROJ_WALL_HITBOX) { hitWall = true; break; }
        }
        if (hitWall) { toRemoveProj.push(proj.id); continue; }

        for (const p of players) {
            // Player whose ID matches the ownerId should not be hit
            if (p === room.players[proj.ownerId]) continue;
            const dx = p.x - proj.x, dy = p.y - proj.y;
            const distSq = dx * dx + dy * dy;

            // Cone collision: check distance AND angle
            if (distSq < (BALL_RADIUS + PROJECTILE_RADIUS) ** 2) {
                const angleToTarget = Math.atan2(dy, dx);
                const angleDiff = Math.abs(angleToTarget - proj.facingAngle);

                // Normalize angleDiff to [0, PI]
                let normDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
                normDiff = Math.abs(normDiff);

                if (normDiff <= Math.PI / 4) { // within 45 degrees of facing = 90 deg cone
                    const dir = Math.sqrt(proj.vx * proj.vx + proj.vy * proj.vy);
                    const nx = dir > 0 ? proj.vx / dir : 0;
                    const ny = dir > 0 ? proj.vy / dir : 0;

                    if (proj.type === 'shockwave') {
                        p.vx += nx * 22; p.vy += ny * 22; // Stronger push
                    } else if (proj.type === 'freeze') {
                        p.frozenTicks = 80; p.vx = 0; p.vy = 0;
                    } else if (proj.type === 'cage') {
                        const cSize = 50, cx = p.x - 25, cy = p.y - 25;
                        const cId = `cage_${room.nextProjId++}`;
                        room.cageWalls.push(
                            { id: cId + '_t', x: cx, y: cy, w: cSize, h: 6, ticksLeft: 200 },
                            { id: cId + '_b', x: cx, y: cy + cSize - 6, w: cSize, h: 6, ticksLeft: 200 },
                            { id: cId + '_l', x: cx, y: cy, w: 6, h: cSize, ticksLeft: 200 },
                            { id: cId + '_r', x: cx + cSize - 6, y: cy, w: 6, h: cSize, ticksLeft: 200 }
                        );
                        p.vx = 0; p.vy = 0;
                    }
                    toRemoveProj.push(proj.id);
                    break; // Hit one player
                }
            }
        }
    }
    room.projectiles = room.projectiles.filter(p => !toRemoveProj.includes(p.id));

    // Update cage walls TTL
    for (const c of room.cageWalls) c.ticksLeft--;
    room.cageWalls = room.cageWalls.filter(c => c.ticksLeft > 0);

    // Walls applied LAST so PvP bounces can't push someone inside a wall
    const activeWalls = [...room.map.walls, ...room.cageWalls.map(c => ({ x: c.x, y: c.y, width: c.w, height: c.h }))];

    const SUBSTEPS = 4;
    for (let s = 0; s < SUBSTEPS; s++) {
        for (const p of players) {
            p.x += p.vx / SUBSTEPS;
            p.y += p.vy / SUBSTEPS;

            for (const wall of activeWalls) {
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
}

server.listen(PORT, () => {
    console.log(`WebSocket server listening on port ${PORT}`);
});
