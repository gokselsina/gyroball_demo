const WebSocket = require('ws');
const http = require('http');

const PORT = 4000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket server is active.');
});
const wss = new WebSocket.Server({ server });

const ROOMS = {};
const MAP_WIDTH = 1200;
const MAP_HEIGHT = 1600;
const BALL_RADIUS = 10;
const MAX_PLAYERS = 4;
const COLORS = ['#F43F5E', '#38BDF8', '#10B981', '#F59E0B'];

const WALLS = [
    // Çerçeve (Sadece dış sınırlar)
    { id: '1', x: 0, y: 0, width: MAP_WIDTH, height: 40 },
    { id: '2', x: 0, y: MAP_HEIGHT - 40, width: MAP_WIDTH, height: 40 },
    { id: '3', x: 0, y: 0, width: 40, height: MAP_HEIGHT },
    { id: '4', x: MAP_WIDTH - 40, y: 0, width: 40, height: MAP_HEIGHT },

    // İç Duvarlar ve Siperler
    { id: '5', x: 250, y: 250, width: 200, height: 40 },
    { id: '6', x: MAP_WIDTH - 450, y: 250, width: 200, height: 40 },
    { id: '7', x: 250, y: MAP_HEIGHT - 290, width: 200, height: 40 },
    { id: '8', x: MAP_WIDTH - 450, y: MAP_HEIGHT - 290, width: 200, height: 40 },

    { id: '9', x: 350, y: 600, width: 40, height: 250 },
    { id: '10', x: MAP_WIDTH - 390, y: 600, width: 40, height: 250 },

    { id: '11', x: MAP_WIDTH / 2 - 150, y: 400, width: 300, height: 40 },
    { id: '12', x: MAP_WIDTH / 2 - 150, y: MAP_HEIGHT - 440, width: 300, height: 40 },
];

const KING_ZONE = {
    x: MAP_WIDTH / 2,
    y: MAP_HEIGHT / 2,
    radius: 120
};

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
        for (const pid in room.players) {
            const clientWs = room.players[pid].ws;
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ event, data }));
            }
        }
    };

    const sendToSelf = (event, data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event, data }));
        }
    };

    ws.on('message', (messageStr) => {
        try {
            const parsed = JSON.parse(messageStr);
            const { event, data } = parsed;

            if (event === 'create_room') {
                const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
                ROOMS[roomId] = {
                    id: roomId,
                    hostId: ws.id,
                    state: 'LOBBY', // LOBBY or IN_GAME
                    players: {}, // id -> data
                    physicsLoop: null,
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
            else if (event === 'tilt') {
                if (!currentRoom || !ROOMS[currentRoom]) return;
                const room = ROOMS[currentRoom];
                if (room.state === 'IN_GAME' && room.players[ws.id]) {
                    room.players[ws.id].tilt = data;
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
            // ignore non-json
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
            x: MAP_WIDTH / 2 + (Math.random() * 200 - 100),
            y: MAP_HEIGHT / 2 + (Math.random() * 200 - 100),
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
        { x: MAP_WIDTH - 80, y: 80 },
        { x: 80, y: MAP_HEIGHT - 80 },
        { x: MAP_WIDTH - 80, y: MAP_HEIGHT - 80 },
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
        map_width: MAP_WIDTH,
        map_height: MAP_HEIGHT,
        walls: WALLS,
        king_zone: KING_ZONE,
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
        const kDx = p.x - KING_ZONE.x;
        const kDy = p.y - KING_ZONE.y;
        if (Math.sqrt(kDx * kDx + kDy * kDy) < KING_ZONE.radius) {
            p.score += 100 / 40; // ~100 points per sec
        }
    }

    // Walls applied LAST so PvP bounces can't push someone inside a wall
    for (const p of players) {
        for (const wall of WALLS) {
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
