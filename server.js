const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(__dirname));

// Eine kleine Beispiel-Wortliste
const words = ["Apfel", "Auto", "Gitarre", "Haus", "Sonne", "Baum", "Computer", "Katze"];

let gameState = {
    currentDrawer: null,
    currentWord: "",
    scores: {}
};

// Runden-Zähler für das Spielende
let roundsPlayed = 0;
const maxRounds = 5; // Nach 5 Runden werden die Highscores an dein Forum gesendet

io.on('connection', (socket) => {
    console.log('Spieler verbunden:', socket.id);

    // Spieler registrieren (mit Objekt aus Username und Admin-Status)
    socket.on('set-username', (data) => {
        // Absolute Sicherheit: Keine Gäste oder unvollständige Daten erlauben
        if (!data || !data.username || data.username.startsWith('Gast_')) {
            socket.disconnect();
            return;
        }

        socket.username = data.username;
        socket.isAdmin = data.isAdmin || false; // Admin-Status speichern
        
        gameState.scores[socket.id] = { username: socket.username, points: 0 };
        
        // Wenn das der erste Spieler ist, wird er gleich zum Maler
        if (!gameState.currentDrawer) {
            startNewRound(socket.id);
        }
        
        io.emit('update-scores', gameState.scores);
    });

    // Mal-Daten weiterleiten
    socket.on('draw', (data) => {
        socket.broadcast.emit('draw', data);
    });

    socket.on('clear', () => {
        socket.broadcast.emit('clear');
    });

    // Chat / Raten / Admin-Befehle
    socket.on('chat-message', (data) => {
        if (!socket.username) return;

        const messageText = data.message.trim();

        // Prüfen, ob ein Admin den Ban-Befehl nutzt: /ban Benutzername
        if (socket.isAdmin && messageText.startsWith('/ban ')) {
            const targetName = messageText.substring(5).trim().toLowerCase();
            
            // Nach dem Spieler unter den verbundenen Sockets suchen
            for (let [id, targetSocket] of io.of('/').sockets) {
                if (targetSocket.username && targetSocket.username.toLowerCase() === targetName) {
                    targetSocket.emit('banned', 'Du wurdest von einem Admin aus dem Spiel gebannt.');
                    targetSocket.disconnect();
                    io.emit('chat-message', { username: 'System', message: `🚫 ${targetSocket.username} wurde von einem Admin aus dem Spiel entfernt.` });
                    break;
                }
            }
            return; // Befehl nicht im Chat anzeigen
        }

        const guess = messageText.toLowerCase();
        const correctWord = gameState.currentWord.toLowerCase();

        if (guess === correctWord && socket.id !== gameState.currentDrawer) {
            // Richtig geraten! Punkte vergeben
            io.emit('chat-message', { username: 'System', message: `🎉 ${socket.username} hat das Wort "${gameState.currentWord}" erraten!` });
            
            gameState.scores[socket.id].points += 10; // 10 Punkte für das Raten
            io.emit('update-scores', gameState.scores);

            // Nächste Runde starten
            startNewRound(socket.id);
        } else {
            // Normaler Chat-Eintrag
            io.emit('chat-message', { username: socket.username, message: data.message });
        }
    });

    socket.on('disconnect', () => {
        console.log('Spieler verlassen:', socket.id);
        if (socket.id && gameState.scores[socket.id]) {
            delete gameState.scores[socket.id];
            if (socket.id === gameState.currentDrawer) {
                // Neuen Maler bestimmen, falls der aktuelle geht...
                const remainingPlayers = Object.keys(gameState.scores);
                if (remainingPlayers.length > 0) {
                    startNewRound(remainingPlayers[0]);
                } else {
                    gameState.currentDrawer = null;
                }
            }
            io.emit('update-scores', gameState.scores);
        }
    });
});

// Funktion für den Start einer neuen Runde
function startNewRound(newDrawerId) {
    roundsPlayed++;
    
    // Prüfen, ob das Spiel zu Ende ist (nach X Runden)
    if (roundsPlayed > maxRounds) {
        endGameAndSave();
        return;
    }

    gameState.currentDrawer = newDrawerId;
    gameState.currentWord = words[Math.floor(Math.random() * words.length)];

    // Dem neuen Maler sein geheimes Wort schicken
    io.to(newDrawerId).emit('your-word', gameState.currentWord);

    // Allen anderen sagen, dass eine neue Runde läuft
    io.emit('new-round', { drawerId: newDrawerId });
}

// Funktion zum Speichern der Highscores auf deiner InfinityFree-Domain
function endGameAndSave() {
    console.log('Spiel beendet. Sende Highscores an InfinityFree...');
    
    io.emit('chat-message', { username: 'System', message: '🏁 Spiel beendet! Highscores werden gespeichert...' });

    fetch('https://ratsel.gamer.gd/save_maler_score.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gameState.scores)
    })
    .then(res => res.json())
    .then(data => {
        console.log('Highscores erfolgreich aktualisiert!', data);
        
        // Spiel für die nächste Runde zurücksetzen
        roundsPlayed = 0;
        for (let id in gameState.scores) {
            gameState.scores[id].points = 0; // Punkte zurücksetzen
        }
        io.emit('update-scores', gameState.scores);
        
        // Neue Runde mit dem ersten verfügbaren Spieler starten
        const players = Object.keys(gameState.scores);
        if (players.length > 0) {
            startNewRound(players[0]);
        }
    })
    .catch(err => {
        console.error('Fehler beim Speichern der Highscores:', err);
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
