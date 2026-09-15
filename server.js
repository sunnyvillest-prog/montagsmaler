const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Erlaubt Verbindungen von deiner Foren-Domain
});

app.use(express.static('public')); // Hier liegen später HTML/JS für das Spiel

io.on('connection', (socket) => {
    console.log('Ein Spieler verbunden:', socket.id);

    // Mal-Daten an alle anderen im Raum senden
    socket.on('draw', (data) => {
        socket.broadcast.emit('draw', data);
    });

    // Canvas leeren
    socket.on('clear', () => {
        socket.broadcast.emit('clear');
    });

    // Chat / Raten
    socket.on('chat-message', (data) => {
        io.emit('chat-message', data); // An alle im Raum senden
    });

    socket.on('disconnect', () => {
        console.log('Spieler hat verlassen:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Montagsmaler läuft auf Port ${PORT}`);
});
