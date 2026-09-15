const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

let words = ["Apfel", "Auto", "Gitarre", "Haus", "Sonne", "Baum", "Computer", "Katze"];
let rooms = {}; 

io.on('connection', (socket) => {
    console.log('Spieler verbunden:', socket.id);

    socket.on('get-rooms', () => {
        let roomList = {};
        for (let rName in rooms) {
            roomList[rName] = {
                playerCount: io.sockets.adapter.rooms.get(rName)?.size || 0,
                maxRounds: rooms[rName].maxRounds,
                maxPlayers: rooms[rName].maxPlayers,
                currentRound: rooms[rName].currentRound,
                hasPassword: !!rooms[rName].password
            };
        }
        socket.emit('room-list', roomList);
    });

    socket.on('join-room', ({ roomName, password, totalRounds, maxPlayers }) => {
        socket.roomName = roomName || 'lobby';
        socket.join(socket.roomName);

        if (!rooms[socket.roomName]) {
            rooms[socket.roomName] = {
                password: password || '',
                maxRounds: Math.min(Math.max(parseInt(totalRounds) || 5, 5), 20),
                maxPlayers: Math.min(Math.max(parseInt(maxPlayers) || 2, 2), 10),
                currentRound: 0,
                currentDrawer: null,
                currentWord: '',
                scores: {},
                guessedCount: 0,
                timer: null
            };
            io.emit('room-list-update');
        }

        const room = rooms[socket.roomName];

        if (room.password && room.password !== password) {
            socket.emit('error-msg', 'Falsches Passwort für diesen Raum!');
            socket.leave(socket.roomName);
            return;
        }

        room.scores[socket.id] = { username: socket.username || 'Gast', points: 0 };
        io.to(socket.roomName).emit('update-scores', room.scores);

        const playerCount = Object.keys(room.scores).length;

        if (!room.currentDrawer && playerCount >= room.maxPlayers) {
            startRound(socket.roomName);
        } else if (!room.currentDrawer) {
            io.to(socket.roomName).emit('waiting-status', { current: playerCount, target: room.maxPlayers });
        }
        
        io.emit('room-list-update');
    });

    socket.on('set-username', (data) => {
        if (!data || !data.username || data.username.startsWith('Gast_')) {
            socket.disconnect();
            return;
        }
        socket.username = data.username;
        socket.isAdmin = data.isAdmin || false;
    });

    socket.on('draw', (data) => {
        if (!socket.roomName) return;
        socket.to(socket.roomName).emit('draw', data);
    });

    socket.on('clear', () => {
        if (!socket.roomName) return;
        socket.to(socket.roomName).emit('clear');
    });

    socket.on('chat-message', (data) => {
        if (!socket.username || !socket.roomName) return;
        const room = rooms[socket.roomName];
        if (!room) return;

        const messageText = data.message.trim();

        if (socket.isAdmin && messageText.startsWith('/ban ')) {
            const targetName = messageText.substring(5).trim().toLowerCase();
            for (let [id, targetSocket] of io.of('/').sockets) {
                if (targetSocket.username && targetSocket.username.toLowerCase() === targetName) {
                    targetSocket.emit('banned', 'Du wurdest von einem Admin gebannt.');
                    targetSocket.disconnect();
                    io.to(socket.roomName).emit('chat-message', { username: 'System', message: `🚫 ${targetSocket.username} wurde gebannt.` });
                    break;
                }
            }
            return;
        }

        const guess = messageText.toLowerCase();
        const correctWord = room.currentWord.toLowerCase();

        if (guess === correctWord && socket.id !== room.currentDrawer) {
            io.to(socket.roomName).emit('chat-message', { username: 'System', message: `🎉 ${socket.username} hat das Wort erraten!` });

            room.guessedCount++;
            
            let earnedPoints = room.guessedCount === 1 ? 15 : (room.guessedCount === 2 ? 10 : 5);
            room.scores[socket.id].points += earnedPoints;

            if (room.guessedCount === 1 && room.scores[room.currentDrawer]) {
                room.scores[room.currentDrawer].points += earnedPoints;
            }

            io.to(socket.roomName).emit('update-scores', room.scores);

            if (room.guessedCount >= Object.keys(room.scores).length - 1) {
                clearTimeout(room.timer);
                nextRound(socket.roomName);
            }
        } else {
            io.to(socket.roomName).emit('chat-message', { username: socket.username, message: data.message });
        }
    });

    socket.on('disconnect', () => {
        handlePlayerLeave(socket);
    });
});

function handlePlayerLeave(socket) {
    if (socket.roomName && rooms[socket.roomName]) {
        const room = rooms[socket.roomName];
        
        if (room.scores[socket.id]) {
            const leftName = room.scores[socket.id].username;
            delete room.scores[socket.id];
            
            io.to(socket.roomName).emit('update-scores', room.scores);
            io.to(socket.roomName).emit('chat-message', { username: 'System', message: `🚪 ${leftName} hat den Raum verlassen.` });
        }
        
        const playerCount = Object.keys(room.scores).length;

        if (playerCount < 2) {
            clearTimeout(room.timer);
            room.currentDrawer = null;
            room.currentRound = 0;
            io.to(socket.roomName).emit('game-stopped', 'Zu wenig Spieler im Raum. Das Spiel wurde unterbrochen.');
            io.to(socket.roomName).emit('waiting-status', { current: playerCount, target: room.maxPlayers });
        } else if (room.currentDrawer === socket.id) {
            clearTimeout(room.timer);
            io.to(socket.roomName).emit('chat-message', { username: 'System', message: `⚠️ Der Maler hat den Raum verlassen!` });
            nextRound(socket.roomName);
        }

        if (playerCount === 0) {
            clearTimeout(room.timer);
            delete rooms[socket.roomName];
        }
        
        io.emit('room-list-update');
    }
}

function startRound(roomName) {
    const room = rooms[roomName];
    if (!room) return;

    const playerCount = Object.keys(room.scores).length;
    if (playerCount < 2) {
        room.currentDrawer = null;
        io.to(roomName).emit('waiting-status', { current: playerCount, target: room.maxPlayers });
        return;
    }

    room.currentRound++;
    if (room.currentRound > room.maxRounds) {
        io.to(roomName).emit('chat-message', { username: 'System', message: `🏁 Spiel beendet nach ${room.maxRounds} Runden!` });
        io.to(roomName).emit('game-over');
        return;
    }

    room.guessedCount = 0;
    const playerIds = Object.keys(room.scores);
    
    const drawerIndex = (room.currentRound - 1) % playerIds.length;
    room.currentDrawer = playerIds[drawerIndex];
    room.currentWord = words[Math.floor(Math.random() * words.length)];

    io.to(room.currentDrawer).emit('your-word', room.currentWord);
    
    io.to(roomName).emit('new-round', { 
        drawerId: room.currentDrawer, 
        round: room.currentRound, 
        maxRounds: room.maxRounds,
        duration: 120 
    });

    clearTimeout(room.timer);
    room.timer = setTimeout(() => {
        io.to(roomName).emit('chat-message', { username: 'System', message: `⏰ Zeit abgelaufen! Das gesuchte Wort war: "${room.currentWord}"` });
        nextRound(roomName);
    }, 120000);
}

function nextRound(roomName) {
    setTimeout(() => {
        startRound(roomName);
    }, 3000);
}

app.use(express.json());
app.get('/api/words', (req, res) => res.json(words));
app.post('/api/words/add', (req, res) => {
    if (req.body.word) {
        words.push(req.body.word.trim());
        res.json({ success: true, words });
    }
});
app.post('/api/words/delete', (req, res) => {
    words = words.filter(w => w !== req.body.word);
    res.json({ success: true, words });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
