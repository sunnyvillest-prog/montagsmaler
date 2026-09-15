const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

// Wortliste
let words = ["Apfel", "Auto", "Gitarre", "Haus", "Sonne", "Baum", "Computer", "Katze"];

// Aktive Räume
let rooms = {}; // roomId -> { password, maxRounds, maxPlayers, currentRound, currentDrawer, currentWord, scores, guessedCount, timer }

io.on('connection', (socket) => {
    console.log('Spieler verbunden:', socket.id);

    // Offene Räume für die Lobby abrufen
    socket.on('get-rooms', () => {
        let roomList = {};
        for (let rName in rooms) {
            roomList[rName] = {
                playerCount: io.sockets.adapter.rooms.get(rName)?.size || 0,
                maxRounds: rooms[rName].maxRounds,
                maxPlayers: rooms[rName].maxPlayers,
                currentRound: rooms[rName].currentRound
            };
        }
        socket.emit('room-list', roomList);
    });

    // Raum beitreten oder erstellen mit Rundenwahl, Passwort & Spielerlimit
    socket.on('join-room', ({ roomName, password, totalRounds, maxPlayers }) => {
        socket.roomName = roomName || 'lobby';
        socket.join(socket.roomName);

        if (!rooms[socket.roomName]) {
            rooms[socket.roomName] = {
                password: password || '',
                maxRounds: Math.min(Math.max(totalRounds || 5, 5), 15),
                maxPlayers: Math.min(Math.max(parseInt(maxPlayers) || 2, 2), 10), // Mind. 2, max. 10 Spieler
                currentRound: 0,
                currentDrawer: null,
                currentWord: '',
                scores: {},
                guessedCount: 0,
                timer: null
            };
        }

        const room = rooms[socket.roomName];

        // Passwort-Check falls gesetzt
        if (room.password && room.password !== password) {
            socket.emit('error-msg', 'Falsches Passwort für diesen Raum!');
            socket.leave(socket.roomName);
            return;
        }

        room.scores[socket.id] = { username: socket.username, points: 0 };
        io.to(socket.roomName).emit('update-scores', room.scores);

        const playerCount = Object.keys(room.scores).length;

        // Spiel starten, wenn die gewünschte Spieleranzahl erreicht ist und noch kein Spiel läuft
        if (!room.currentDrawer && playerCount >= room.maxPlayers) {
            startRound(socket.roomName);
        } else if (!room.currentDrawer) {
            // Warten-Status an alle im Raum senden
            io.to(socket.roomName).emit('waiting-status', { current: playerCount, target: room.maxPlayers });
        }
    });

    socket.on('set-username', (data) => {
        if (!data || !data.username || data.username.startsWith('Gast_')) {
            socket.disconnect();
            return;
        }
        socket.username = data.username;
        socket.isAdmin = data.isAdmin || false;
    });

    // Mal-Daten innerhalb des Raumes weiterleiten
    socket.on('draw', (data) => {
        if (!socket.roomName) return;
        socket.to(socket.roomName).emit('draw', data);
    });

    socket.on('clear', () => {
        if (!socket.roomName) return;
        socket.to(socket.roomName).emit('clear');
    });

    // Chat, Raten und Admin-Befehle
    socket.on('chat-message', (data) => {
        if (!socket.username || !socket.roomName) return;
        const room = rooms[socket.roomName];
        if (!room) return;

        const messageText = data.message.trim();

        // Admin Ban Befehl
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

        // Prüfen ob richtig geraten
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
        if (socket.roomName && rooms[socket.roomName]) {
            const room = rooms[socket.roomName];
            delete room.scores[socket.id];
            io.to(socket.roomName).emit('update-scores', room.scores);
            
            const playerCount = Object.keys(room.scores).length;
            if (!room.currentDrawer && playerCount > 0) {
                io.to(socket.roomName).emit('waiting-status', { current: playerCount, target: room.maxPlayers });
            }
            if (playerCount === 0) {
                clearTimeout(room.timer);
                delete rooms[socket.roomName];
            }
        }
    });
});

function startRound(roomName) {
    const room = rooms[roomName];
    if (!room) return;

    room.currentRound++;
    if (room.currentRound > room.maxRounds) {
        io.to(roomName).emit('chat-message', { username: 'System', message: `🏁 Spiel beendet nach ${room.maxRounds} Runden!` });
        return;
    }

    room.guessedCount = 0;
    const playerIds = Object.keys(room.scores);
    if (playerIds.length === 0) return;

    const drawerIndex = (room.currentRound - 1) % playerIds.length;
    room.currentDrawer = playerIds[drawerIndex];
    room.currentWord = words[Math.floor(Math.random() * words.length)];

    io.to(room.currentDrawer).emit('your-word', room.currentWord);
    io.to(roomName).emit('new-round', { drawerId: room.currentDrawer, round: room.currentRound, maxRounds: room.maxRounds });

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

// REST-API für Admin-Wörterverwaltung
app.use(express.json());
app.get('/api/words', (req, res) => res.json(words));
app.post('/api/words/add', (req, res) => {
    if (req.body.word) {
        words.push(req.body.word.trim()); // Korrigiert
        res.json({ success: true, words });
    }
});
app.post('/api/words/delete', (req, res) => {
    words = words.filter(w => w !== req.body.word);
    res.json({ success: true, words });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
