const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- ATC24 API CONFIG ---
const WS_URL = 'wss://24data.ptfs.app/wss';
const STUDS_PER_NMI = 3307.14286;

// Center Coordinates (Approximate - fine-tune these in-game)
const AIRPORTS = {
    "IRFD": { name: "Rockford", x: -10906, y: -23349 }, // Based on Shamrock-1337 example
    "ITKO": { name: "Tokyo", x: 45000, y: 12000 },
    "IMLR": { name: "Mellor", x: -5000, y: 40000 }
};

let aircraftMap = new Map();
let atisMap = {};
let controllers = [];

// --- WEBSOCKET CLIENT ---
const client = new WebSocket(WS_URL);

client.on('message', (data) => {
    const msg = JSON.parse(data);
    const now = new Date().toISOString();

    if (msg.t === 'ACFT_DATA') {
        for (const [cs, val] of Object.entries(msg.d)) {
            let entry = aircraftMap.get(cs) || { callsign: cs };
            aircraftMap.set(cs, { ...entry, ...val, lastSeen: now });
        }
    } else if (msg.t === 'FLIGHT_PLAN') {
        let entry = aircraftMap.get(msg.d.callsign) || { callsign: msg.d.callsign };
        aircraftMap.set(msg.d.callsign, { ...entry, plan: msg.d });
    } else if (msg.t === 'ATIS') {
        atisMap[msg.d.airport] = msg.d;
    } else if (msg.t === 'CONTROLLERS') {
        controllers = msg.d;
    }

    // Broadcast cleaned data to your users
    broadcastUpdate();
});

// --- COMPLIANCE: 14-DAY PURGE ---
// Since we store data in a Map (RAM), it clears on restart. 
// For safety, we clear inactive planes every hour.
setInterval(() => {
    const twentyMinsAgo = Date.now() - (20 * 60 * 1000);
    for (const [cs, data] of aircraftMap) {
        if (new Date(data.lastSeen).getTime() < twentyMinsAgo) aircraftMap.delete(cs);
    }
}, 3600000);

function broadcastUpdate() {
    const payload = Object.keys(AIRPORTS).map(icao => {
        const apt = AIRPORTS[icao];
        const arrivals = Array.from(aircraftMap.values())
            .filter(a => a.plan?.arriving === icao && !a.isOnGround)
            .map(a => {
                const dist = Math.sqrt(Math.pow(a.position.x - apt.x, 2) + Math.pow(a.position.y - apt.y, 2)) / STUDS_PER_NMI;
                const realKnots = a.groundSpeed * 0.5921;
                return { cs: a.callsign, type: a.aircraftType, dist: dist.toFixed(1), eta: Math.round((dist/realKnots)*60) || '--' };
            });

        return {
            icao,
            name: apt.name,
            atis: atisMap[icao]?.letter || 'A', // Default to 'A' if offline
            runways: atisMap[icao]?.lines[1] || 'VFR CONDITIONS', // Default text
            arrivalCount: arrivals.length,
            arrivals: arrivals.length > 0 ? arrivals : [{cs: "WAITING", type: "DATA", dist: "0", eta: "0"}] 
        };
    });
    io.emit('update', { airports: payload, controllers });
}

app.use(express.static('public'));
server.listen(3000, () => console.log('24Hub running on http://localhost:3000'));