const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Damit der Server unsere Webseite (das Frontend) laden kann
app.use(express.static('public'));

// Wenn sich ein Spieler verbindet
io.on('connection', (socket) => {
    console.log('Ein Spieler hat sich verbunden: ' + socket.id);

    // Wenn ein Spieler malt, leite die Daten an alle anderen weiter
    socket.on('drawing', (data) => {
        socket.broadcast.emit('drawing', data);
    });

    // Wenn ein Spieler das Bild löscht
    socket.on('clear', () => {
        io.emit('clear');
    });

    // Wenn eine Chat-Nachricht geschickt wird
    socket.on('chat-message', (msg) => {
        io.emit('chat-message', msg);
    });

    socket.on('disconnect', () => {
        console.log('Ein Spieler hat das Spiel verlassen.');
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server läuft! Öffne im Browser: http://localhost:${PORT}`);
});