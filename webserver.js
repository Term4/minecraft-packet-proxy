//this module exposes functions and variables to control the HTTP server.
const http = require('http');
const fs = require('fs');
const path = require('path');

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

module.exports = {
    createServer: (port) => {
        const root = process.cwd();
        http.createServer(async (req, res) => {
            if (req.url === "/") { //main page of the web app
                res.writeHead(200, { 'Content-type': 'text/html' });
                res.write(fs.readFileSync(path.join(root, 'index.html')));
                res.end();
            } else if (req.url === "/index.css") { //css file to make it not look like too much shit
                res.writeHead(200, { 'Content-type': 'text/css' });
                res.write(fs.readFileSync(path.join(root, 'index.css')));
                res.end();
            } else if (req.url === "/start") { //API endpoint to start queuing
                res.writeHead(200);
                res.end();
                module.exports.onstartcallback();
            } else if (req.url === "/stop") { //API endpoint to stop queuing
                res.writeHead(200);
                res.end();
                module.exports.onstopcallback();
            } else if (req.url === "/config" && req.method === "GET") {
                res.writeHead(200, { 'Content-type': 'application/json' });
                const cfg = module.exports.getConfig ? module.exports.getConfig() : {};
                res.write(JSON.stringify(cfg));
                res.end();
            } else if (req.url === "/config" && req.method === "POST") {
                try {
                    const body = await readBody(req);
                    const { serverIp, serverPort, knockbackTracking } = JSON.parse(body);
                    if (serverIp != null || serverPort != null) {
                        if (module.exports.setServerConfig) module.exports.setServerConfig(serverIp, serverPort);
                    }
                    if (knockbackTracking !== undefined && module.exports.setKnockbackTracking) {
                        module.exports.setKnockbackTracking(knockbackTracking);
                    }
                    res.writeHead(200, { 'Content-type': 'application/json' });
                    res.write(JSON.stringify({ ok: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-type': 'application/json' });
                    res.write(JSON.stringify({ error: e.message }));
                }
                res.end();
            } else if (req.url === "/knockback-log" && req.method === "GET") {
                res.writeHead(200, { 'Content-type': 'application/json' });
                const log = module.exports.getKnockbackLog ? module.exports.getKnockbackLog() : [];
                res.write(JSON.stringify(log, null, 2));
                res.end();
            } else if (req.url === "/knockback-log" && req.method === "DELETE") {
                if (module.exports.clearKnockbackLog) module.exports.clearKnockbackLog();
                res.writeHead(200);
                res.end();
            } else if (req.url === "/update") {
                res.writeHead(200, { 'Content-type': 'application/json' });
                res.write(JSON.stringify({ connected: module.exports.connected }));
                res.end();
            } else if (req.url === "/packets" && req.method === "GET") {
                res.writeHead(200, { 'Content-type': 'application/json' });
                res.write(JSON.stringify(module.exports.getPackets ? module.exports.getPackets() : []));
                res.end();
            } else if (req.url === "/sendpacket" && req.method === "POST") {
                try {
                    const body = await readBody(req);
                    const { direction, name, data } = JSON.parse(body);
                    if (!direction || !name || data === undefined) throw new Error("direction, name, and data required");
                    if (direction !== "client" && direction !== "server") throw new Error("direction must be 'client' or 'server'");
                    module.exports.sendPacket(direction, name, data);
                    res.writeHead(200, { 'Content-type': 'application/json' });
                    res.write(JSON.stringify({ ok: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-type': 'application/json' });
                    res.write(JSON.stringify({ error: e.message }));
                }
                res.end();
            } else {
                res.writeHead(404);
                res.end();
            }
        }).listen(port);
    },
    onstart: (callback) => { //function to set the action to do when starting
        module.exports.onstartcallback = callback;
    },
    onstop: (callback) => { //same but to stop
        module.exports.onstopcallback = callback;
    },
    connected: false,
    onstartcallback: null, //a save of the action to start
    onstopcallback: null, //same but to stop
};