const mc = require('minecraft-protocol');
const net = require('net');
const webserver = require('./webserver.js'); // to serve the webserver
const open = require('open'); //to open a browser window
const config = require('./config.json'); // read the config

// Runtime server config (editable from web UI)
let serverConfig = {
	ip: config.connectivity.server.ip,
	port: config.connectivity.server.port
};

let secrets = {};
try { secrets = require('./secrets.json'); } catch (e) { /* optional for Microsoft auth */ }

// Recent packets for web UI (last 100)
let recentPackets = [];
const MAX_PACKETS = 100;

webserver.createServer(config.connectivity.ports.web); // create the webserver
webserver.password = config.password
webserver.onstart(() => { start(); });
webserver.onstop(() => { stop(); });
webserver.getPackets = () => recentPackets;
webserver.getConfig = () => ({
	minecraftHost: 'localhost',
	minecraftPort: config.connectivity.ports.minecraft,
	serverIp: serverConfig.ip,
	serverPort: serverConfig.port,
	targetServer: serverConfig.ip + ':' + serverConfig.port,
	knockbackTracking: knockbackTrackingEnabled
});
webserver.setKnockbackTracking = (enabled) => { knockbackTrackingEnabled = !!enabled; };
webserver.getKnockbackLog = () => knockbackLog;
webserver.clearKnockbackLog = () => { knockbackLog = []; };
webserver.setServerConfig = (ip, port) => {
	if (ip != null) serverConfig.ip = String(ip);
	if (port != null) serverConfig.port = parseInt(port, 10) || serverConfig.port;
};
webserver.sendPacket = (direction, name, data) => {
	if (config.forwardMode === 'raw') {
		throw new Error("Packet injection not available in raw forwarding mode");
	}
	if (direction === "client" && proxyClient) {
		filterPacketAndSend(data, { name }, proxyClient, false);
	} else if (direction === "server" && client) {
		filterPacketAndSend(data, { name }, client, true);
	} else {
		throw new Error(direction === "client" ? "Not connected to Minecraft" : "Not connected to server");
	}
};

if (config.openBrowserOnStart) {
    open('http://localhost:' + config.connectivity.ports.web); //open a browser window
}

let proxyClient; // a reference to the client that is the actual minecraft game
let client; // the client to connect to the server
let server; // the minecraft server to pass packets

let loginPacket = {};
let posPacket = {};
let chunkArray = new Array();
let preClientPacketQueue = [];
let hasReceivedLogin = false; // Only cache packets AFTER login (play state) - login-state packets corrupt the stream
let hasForwardedLogin = false; // Prevent forwarding duplicate login packets (some servers send twice)
const MAX_PRE_CLIENT_PACKETS = 500;

// Knockback tracking
let knockbackTrackingEnabled = false;
let knockbackLog = [];
let knockbackState = {
	ourEntityId: null,
	lastVelocity: { vx: 0, vy: 0, vz: 0 },
	entityPositions: {},
	entityRotations: {},
	lastCombatAttacker: null,
	sprint: false,
	lastPos: null,
	lastPosTime: 0
};

// Convert protocol rotation to degrees. 1.8 uses i8 (signed byte -128..127).
// Yaw: byte * 360/256 -> -180..180. Pitch: byte * 180/256 -> -90..90.
function toDegrees(v, isPitch = false) {
	if (typeof v !== "number" || !Number.isFinite(v)) return v;
	if (Number.isInteger(v) && v >= -128 && v <= 127) {
		return (v * (isPitch ? 180 : 360)) / 256;
	}
	if (Number.isInteger(v) && v >= 0 && v <= 255) {
		const byte = v > 127 ? v - 256 : v;
		return (byte * (isPitch ? 180 : 360)) / 256;
	}
	if (Math.abs(v) <= 6.3) return v * 57.2958;
	return v;
}

// Prevent spam - high-volume or binary-heavy packets (never log/store these)
const packetNameBlacklist = [
	"map_chunk", "map_chunk_bulk", "chunk_data", "multi_block_change", "block_change",
	"look", "position_look", "position", "flying",
	"unload_chunk", "unlock_recipes", "advancements",
	"custom_payload",
	"playerlist_header", "playerlist_footer", "transaction",
];

// function to disconnect from the server
function stop() {
	webserver.connected = false;
	hasReceivedLogin = false;
	hasForwardedLogin = false;
	preClientPacketQueue = [];
	pendingClient = null;
	connectingToTarget = false;
	connectionForClient = null;
	knockbackState = { ourEntityId: null, lastVelocity: { vx: 0, vy: 0, vz: 0 }, entityPositions: {}, entityRotations: {}, lastCombatAttacker: null, sprint: false, lastPos: null, lastPosTime: 0 };
	if (proxyClient) {
		try { proxyClient.end("Stopped the proxy"); } catch (e) {}
		proxyClient = null;
	}
	if (client) { try { client.end(); } catch (e) {} client = null; }
	if (server) { try { server.close(); } catch (e) {} server = null; }
}

let pendingClient = null; // client waiting for target server login
let connectingToTarget = false;
let connectionForClient = null; // connClient that triggered target connection (disconnect target when they leave)

function connectToTargetServer() {
	if (client) return; // already connected
	if (connectingToTarget) return; // connection in progress
	connectingToTarget = true;
	console.log("Client connecting - joining target server at " + serverConfig.ip + ":" + serverConfig.port + "...");
	const clientOptions = {
		host: serverConfig.ip,
		port: serverConfig.port,
		version: config.MCversion,
		auth: config.auth || 'microsoft',
		username: secrets.username || config.username || 'Proxy'
	};
	if (clientOptions.auth === 'mojang' && secrets.username && secrets.password) {
		clientOptions.password = secrets.password;
	}
	const serverSocket = net.connect(serverConfig.port, serverConfig.ip);
	serverSocket.setNoDelay(true);
	const CONNECT_TIMEOUT = 15000;
	serverSocket.setTimeout(CONNECT_TIMEOUT);
	serverSocket.once('connect', () => serverSocket.setTimeout(0));
	serverSocket.once('timeout', () => {
		if (!serverSocket.destroyed) {
			serverSocket.destroy(new Error('Connection to target server timed out'));
		}
	});
	clientOptions.stream = serverSocket;
	client = mc.createClient(clientOptions);

	const loginTimeout = setTimeout(() => {
		if (client && !hasReceivedLogin) {
			console.error("Target server did not send login within 60s - disconnecting.");
			try { client.end("Connection timed out"); } catch (e) {}
			client = null;
			connectingToTarget = false;
		}
	}, 60000);
	client.on("packet", (data, meta) => {
		let sentViaInitial = false;
		if (meta.name === "login") clearTimeout(loginTimeout);
		if (!proxyClient && !packetNameBlacklist.includes(meta.name)) {
			console.log("(Server) " + meta.name + ": " + JSON.stringify(data) + "\n");
		}

		if (meta.name == "login") {
			connectingToTarget = false;
			console.log("Connected to server! Client can now play.");
			loginPacket = data;
			hasReceivedLogin = true;
			knockbackState.ourEntityId = data.entityId ?? data.entity_id ?? null;
			if (pendingClient) {
				sendInitialPacketsToClient(pendingClient);
				proxyClient = pendingClient;
				setupClientPacketHandler(pendingClient);
				pendingClient = null;
				sentViaInitial = true;
				hasForwardedLogin = true;
			}
		} else if (meta.name == "position") {
			posPacket = data;
			if (pendingClient && hasReceivedLogin) {
				sendInitialPacketsToClient(pendingClient);
				proxyClient = pendingClient;
				setupClientPacketHandler(pendingClient);
				pendingClient = null;
				sentViaInitial = true;
			}
		} else if (meta.name == "entity_velocity" && knockbackTrackingEnabled && proxyClient) {
			const eid = data.entityId ?? data.entity_id;
			const ourEid = knockbackState.ourEntityId ?? loginPacket.entityId ?? loginPacket.entity_id;
			if (eid === ourEid) {
				const vx = data.velocityX ?? data.velocity_x ?? 0;
				const vy = data.velocityY ?? data.velocity_y ?? 0;
				const vz = data.velocityZ ?? data.velocity_z ?? 0;
				const ourPos = posPacket && posPacket.x != null ? posPacket : { x: 0, y: 64, z: 0 };
				let dp = { dx: 0, dy: 0, dz: 0 };
				let attackerPos = null;
				let attackerEid = null;
				if (knockbackState.lastCombatAttacker != null && knockbackState.entityPositions[knockbackState.lastCombatAttacker]) {
					attackerPos = knockbackState.entityPositions[knockbackState.lastCombatAttacker];
					attackerEid = knockbackState.lastCombatAttacker;
				}
				if (!attackerPos) {
					let bestDist = Infinity;
					for (const [eid, pos] of Object.entries(knockbackState.entityPositions)) {
						if (Number(eid) === ourEid) continue;
						const d = Math.sqrt(Math.pow(pos.x - ourPos.x, 2) + Math.pow(pos.y - ourPos.y, 2) + Math.pow(pos.z - ourPos.z, 2));
						if (d < bestDist && d <= 20 && Number.isFinite(d)) {
							bestDist = d;
							attackerPos = pos;
							attackerEid = Number(eid);
						}
					}
				}
				if (attackerPos) {
					const rawDx = attackerPos.x - ourPos.x, rawDy = attackerPos.y - ourPos.y, rawDz = attackerPos.z - ourPos.z;
					const dist = Math.sqrt(rawDx * rawDx + rawDy * rawDy + rawDz * rawDz);
					if (dist <= 20 && Number.isFinite(dist)) {
						dp = { dx: Math.round(rawDx * 100) / 100, dy: Math.round(rawDy * 100) / 100, dz: Math.round(rawDz * 100) / 100 };
					}
				}
				const rot = attackerEid != null ? knockbackState.entityRotations[attackerEid] : null;
				const iv = knockbackState.lastVelocity;
				knockbackLog.push({
					dp,
					attackerYaw: rot != null && rot.yaw != null ? Math.round(rot.yaw * 100) / 100 : null,
					attackerPitch: rot != null && rot.pitch != null ? Math.round(rot.pitch * 100) / 100 : null,
					sprint: knockbackState.sprint,
					initial: {
						vx: { raw: iv.vx, scaled: iv.vx / 8000 },
						vy: { raw: iv.vy, scaled: iv.vy / 8000 },
						vz: { raw: iv.vz, scaled: iv.vz / 8000 }
					},
					final: {
						vx: { raw: vx, scaled: vx / 8000 },
						vy: { raw: vy, scaled: vy / 8000 },
						vz: { raw: vz, scaled: vz / 8000 }
					}
				});
				knockbackState.lastVelocity = { vx, vy, vz };
			}
		} else if (meta.name == "entity_teleport" && knockbackTrackingEnabled) {
			const eid = data.entityId ?? data.entity_id;
			if (eid != null) {
				let x = data.x ?? 0, y = data.y ?? 0, z = data.z ?? 0;
				if (Math.abs(x) > 1e6 || Math.abs(z) > 1e6) { x /= 32; y /= 32; z /= 32; }
				knockbackState.entityPositions[eid] = { x, y, z };
				const yaw = data.yaw ?? data.yaw_rad ?? data.yaw_deg;
				const pitch = data.pitch ?? data.pitch_rad ?? data.pitch_deg;
				if (yaw != null || pitch != null) {
					knockbackState.entityRotations[eid] = {
						...knockbackState.entityRotations[eid],
						...(yaw != null && { yaw: toDegrees(yaw) }),
						...(pitch != null && { pitch: toDegrees(pitch, true) })
					};
				}
			}
		} else if (meta.name == "entity_look" && knockbackTrackingEnabled) {
			const eid = data.entityId ?? data.entity_id;
			if (eid != null) {
				const yaw = data.yaw ?? data.yaw_rad ?? data.yaw_deg;
				const pitch = data.pitch ?? data.pitch_rad ?? data.pitch_deg;
				if (yaw != null || pitch != null) {
					knockbackState.entityRotations[eid] = {
						...knockbackState.entityRotations[eid],
						...(yaw != null && { yaw: toDegrees(yaw) }),
						...(pitch != null && { pitch: toDegrees(pitch, true) })
					};
				}
			}
		} else if (meta.name == "entity_head_rotation" && knockbackTrackingEnabled) {
			const eid = data.entityId ?? data.entity_id;
			if (eid != null) {
				const yaw = data.headYaw ?? data.head_yaw ?? data.yaw ?? data.rotation;
				if (yaw != null) {
					knockbackState.entityRotations[eid] = { ...knockbackState.entityRotations[eid], yaw: toDegrees(yaw) };
				}
			}
		} else if ((meta.name == "rel_entity_move" || meta.name == "rel_entity_move_look") && knockbackTrackingEnabled) {
			const eid = data.entityId ?? data.entity_id;
			if (eid != null) {
				const cur = knockbackState.entityPositions[eid] || { x: 0, y: 64, z: 0 };
				const scale = 1 / 32;
				knockbackState.entityPositions[eid] = {
					x: cur.x + (data.dX ?? data.dx ?? 0) * scale,
					y: cur.y + (data.dY ?? data.dy ?? 0) * scale,
					z: cur.z + (data.dZ ?? data.dz ?? 0) * scale
				};
				if (meta.name == "rel_entity_move_look") {
					const yaw = data.yaw ?? data.yaw_rad ?? data.yaw_deg;
					const pitch = data.pitch ?? data.pitch_rad ?? data.pitch_deg;
					if (yaw != null || pitch != null) {
						knockbackState.entityRotations[eid] = {
							...knockbackState.entityRotations[eid],
							...(yaw != null && { yaw: toDegrees(yaw) }),
							...(pitch != null && { pitch: toDegrees(pitch, true) })
						};
					}
				}
			}
		} else if (meta.name == "combat_event" && knockbackTrackingEnabled && data.entityId != null && (data.event ?? data.mode) === 2) {
			knockbackState.lastCombatAttacker = data.entityId ?? data.entity_id;
		} else if (meta.name == "named_entity_spawn" && knockbackTrackingEnabled) {
			const eid = data.entityId ?? data.entity_id;
			if (eid != null) {
				let x = data.x ?? 0, y = data.y ?? 0, z = data.z ?? 0;
				if (Math.abs(x) > 1e6 || Math.abs(z) > 1e6) { x /= 32; y /= 32; z /= 32; }
				knockbackState.entityPositions[eid] = { x, y, z };
				const yaw = data.yaw ?? data.yaw_rad ?? data.yaw_deg;
				const pitch = data.pitch ?? data.pitch_rad ?? data.pitch_deg;
				if (yaw != null || pitch != null) {
					knockbackState.entityRotations[eid] = {
						...knockbackState.entityRotations[eid],
						...(yaw != null && { yaw: toDegrees(yaw) }),
						...(pitch != null && { pitch: toDegrees(pitch, true) })
					};
				}
			}
		} else if (meta.name == "entity_metadata" && knockbackTrackingEnabled) {
			const eid = data.entityId ?? data.entity_id;
			const ourEid = knockbackState.ourEntityId ?? loginPacket.entityId ?? loginPacket.entity_id;
			if (eid === ourEid && data.metadata) {
				const flags = data.metadata.find(m => (m.key ?? m.index) === 0);
				if (flags && flags.value != null) knockbackState.sprint = !!(flags.value & 0x08);
			}
		} else if (meta.name == "map_chunk" || meta.name == "map_chunk_bulk") {
			chunkArray.push({ data, name: meta.name });
			if (pendingClient && hasReceivedLogin) {
				sendInitialPacketsToClient(pendingClient);
				proxyClient = pendingClient;
				setupClientPacketHandler(pendingClient);
				pendingClient = null;
				sentViaInitial = true;
			}
		} else if (!proxyClient && hasReceivedLogin) {
			const noCache = ["custom_payload", "tile_entity_data", "map_chunk", "map_chunk_bulk", "encryption_begin", "success", "compress"];
			if (preClientPacketQueue.length < MAX_PRE_CLIENT_PACKETS && !noCache.includes(meta.name)) {
				preClientPacketQueue.push({ data, meta: { name: meta.name } });
			}
		}

		// Only forward play-state packets - player is already in play state from proxy login.
		// Don't forward login twice (some servers send it twice; we send via sendInitialPacketsToClient when pendingClient).
		if (proxyClient && hasReceivedLogin && !sentViaInitial && !(meta.name === "login" && hasForwardedLogin)) {
			if (meta.name === "login") hasForwardedLogin = true;
			filterPacketAndSend(data, meta, proxyClient, false);
		}
	});

	const targetClient = client;
	client.on('end', (reason) => {
		if (client !== targetClient) return; // Stale handler from replaced connection
		clearTimeout(loginTimeout);
		connectingToTarget = false;
		hasForwardedLogin = false;
		if (reason) console.error("Server disconnected:", reason);
		client = null;
		pendingClient = null;
		if (proxyClient) {
			try { proxyClient.end("Connection reset by server."); } catch (e) {}
			proxyClient = null;
		}
	});

	client.on('error', (err) => {
		if (client !== targetClient) return;
		clearTimeout(loginTimeout);
		connectingToTarget = false;
		hasForwardedLogin = false;
		client = null;
		const msg = err?.message || "";
		const isWriteAfterEnd = msg.includes("write after end") || msg.includes("ERR_STREAM_WRITE_AFTER_END");
		if (pendingClient) {
			try { pendingClient.end("Failed to connect to server: " + (isWriteAfterEnd ? "Connection closed" : msg)); } catch (e) {}
			pendingClient = null;
		}
		if (proxyClient) {
			try { proxyClient.end(isWriteAfterEnd ? "Connection reset by server." : `Connection error: ${msg}`); } catch (e) {}
			proxyClient = null;
		}
		if (!isWriteAfterEnd) console.error("Connection failed:", msg);
		if (msg.includes("Invalid session")) {
			console.error("  -> Try auth: 'microsoft' in config.json (Mojang login no longer works for most accounts)");
		}
	});
}

function sendInitialPacketsToClient(newProxyClient) {
	filterPacketAndSend(loginPacket, {"name": "login"}, newProxyClient, false);
	const pos = (posPacket && posPacket.x != null && posPacket.y != null && posPacket.z != null)
		? posPacket
		: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: false };
	filterPacketAndSend(pos, {"name": "position"}, newProxyClient, false);
	chunkArray.forEach(function (v) { filterPacketAndSend(v.data, { name: v.name }, newProxyClient, false); });
	const playerInfoFirst = preClientPacketQueue.filter(p => p.meta.name === "player_info");
	const rest = preClientPacketQueue.filter(p => p.meta.name !== "player_info");
	preClientPacketQueue = [];
	[...playerInfoFirst, ...rest].forEach(p => filterPacketAndSend(p.data, p.meta, newProxyClient, false));
}

function setupClientPacketHandler(newProxyClient) {
	// Use prependListener so we receive packets before any proxy-internal handlers
	const handler = (data, meta) => {
		if (meta.name == "position" || meta.name == "position_look") {
			posPacket = data;
			if (knockbackTrackingEnabled && data.x != null && data.y != null && data.z != null) {
				const now = Date.now();
				const cur = { x: data.x, y: data.y, z: data.z };
				if (knockbackState.lastPos != null && knockbackState.lastPosTime > 0) {
					const dt = (now - knockbackState.lastPosTime) / 1000;
					if (dt > 0.001 && dt < 2) {
						const blocksPerSecX = (cur.x - knockbackState.lastPos.x) / dt;
						const blocksPerSecY = (cur.y - knockbackState.lastPos.y) / dt;
						const blocksPerSecZ = (cur.z - knockbackState.lastPos.z) / dt;
						const blocksPerTick = 1 / 20;
						knockbackState.lastVelocity = {
							vx: Math.round(blocksPerSecX * blocksPerTick * 8000),
							vy: Math.round(blocksPerSecY * blocksPerTick * 8000),
							vz: Math.round(blocksPerSecZ * blocksPerTick * 8000)
						};
					}
				}
				knockbackState.lastPos = cur;
				knockbackState.lastPosTime = now;
			}
		}
		// Support both "chat" (1.8) and "chat_message" (newer) packet names
		const isChat = (meta.name === "chat" || meta.name === "chat_message");
		if (isChat) {
			const chatMessage = data.message ?? data.text ?? data.content ?? "";
			if (typeof chatMessage === "string" && chatMessage.startsWith("/receivepacket")) {
				let args = chatMessage.split(" ");
				if (args.length < 3) {
					filterPacketAndSend({"message": "{\"text\":\"Usage: /receivepacket <packet name> <json>\"}", "position": 1}, {"name": "chat"}, newProxyClient, false);
				} else {
					try {
						let jsonStr = args.slice(2).join(" ");
						filterPacketAndSend(JSON.parse(jsonStr), {"name": args[1]}, newProxyClient, false);
					} catch (e) {
						filterPacketAndSend({"message": "{\"text\":\"Invalid JSON: " + (e.message || "parse error") + "\"}", "position": 1}, {"name": "chat"}, newProxyClient, false);
					}
				}
			} else if (typeof chatMessage === "string" && chatMessage.startsWith("/sendpacket")) {
				let args = chatMessage.split(" ");
				if (args.length < 3) {
					filterPacketAndSend({"message": "{\"text\":\"Usage: /sendpacket <packet name> <json>\"}", "position": 1}, {"name": "chat"}, newProxyClient, false);
				} else {
					try {
						let jsonStr = args.slice(2).join(" ");
						if (client) filterPacketAndSend(JSON.parse(jsonStr), {"name": args[1]}, client, true);
					} catch (e) {
						filterPacketAndSend({"message": "{\"text\":\"Invalid JSON: " + (e.message || "parse error") + "\"}", "position": 1}, {"name": "chat"}, newProxyClient, false);
					}
				}
			} else {
				if (client) filterPacketAndSend(data, meta, client, true);
			}
		} else {
			if (client) filterPacketAndSend(data, meta, client, true);
		}
	};
	if (newProxyClient.prependListener) {
		newProxyClient.prependListener('packet', handler);
	} else {
		newProxyClient.on('packet', handler);
	}
	newProxyClient.on('end', () => {
		if (proxyClient === newProxyClient) {
			proxyClient = null;
			if (client) {
				try { client.end(); } catch (e) {}
				client = null;
			}
		}
	});
}

// Raw TCP forwarding: bytes pass through unchanged. Client speaks directly to target.
// You appear as yourself, chat/commands work, other players see you.
function startRawServer() {
	stop();
	webserver.connected = true;
	server = net.createServer((clientSocket) => {
		clientSocket.setNoDelay(true);
		console.log("Client connected - forwarding to " + serverConfig.ip + ":" + serverConfig.port + "...");
		const targetSocket = net.connect(serverConfig.port, serverConfig.ip, () => {
			targetSocket.setNoDelay(true);
			console.log("Connected to target. Player will appear as themselves.");
		});
		targetSocket.setTimeout(15000);
		targetSocket.once('connect', () => targetSocket.setTimeout(0));
		targetSocket.once('timeout', () => {
			if (!targetSocket.destroyed) targetSocket.destroy(new Error('Target connection timeout'));
		});
		clientSocket.pipe(targetSocket, { end: true });
		targetSocket.pipe(clientSocket, { end: true });
		targetSocket.on('error', (err) => {
			if (!clientSocket.destroyed) clientSocket.destroy(new Error('Connection to server lost'));
		});
		clientSocket.on('error', () => {
			if (!targetSocket.destroyed) targetSocket.destroy();
		});
		clientSocket.on('end', () => {
			if (!targetSocket.destroyed) targetSocket.end();
		});
		targetSocket.on('end', () => {
			if (!clientSocket.destroyed) clientSocket.end();
		});
	});
	server.listen(config.connectivity.ports.minecraft, '0.0.0.0', () => {
		console.log("Raw proxy listening on " + config.connectivity.ports.minecraft + ". Connect Minecraft to join target server.");
	});
}

// Parsed mode: proxy acts as server+client, parses packets. You appear as proxy bot. Enables packet injection.
function startParsedServer() {
	stop();
	webserver.connected = true;
	server = mc.createServer({
		'online-mode': config.onlineMode !== false,

		encryption: true,
		host: '0.0.0.0',

	// When a client connects to localhost, THEN connect to target server
		port: config.connectivity.ports.minecraft,
		version: config.MCversion,
		'max-players': 1
	});
	try {
		server.socketServer?.prependListener?.('connection', (socket) => socket.setNoDelay?.(true));
	} catch (e) {}
	server.on('connection', (connClient) => {
		connClient.once('set_protocol', (packet) => {
			const next = packet.nextState ?? packet.next_state ?? 0;
			if (next === 2 || next === '2') {
				connectionForClient = connClient;
				connectToTargetServer();
			}
		});

		connClient.once('end', () => {
			const isOurClient = (proxyClient === connClient || pendingClient === connClient || connectionForClient === connClient);
			if (proxyClient === connClient) proxyClient = null;
			if (pendingClient === connClient) pendingClient = null;
			if (connectionForClient === connClient) connectionForClient = null;
			if (isOurClient && client) {
				try { client.end(); } catch (e) {}
				client = null;
			}
		});
	});
	server.on('login', (newProxyClient) => {
		connectionForClient = null;
		console.log("-------- Client joined (connected to target) --------");
		if (hasReceivedLogin && client) {
			sendInitialPacketsToClient(newProxyClient);
			proxyClient = newProxyClient;
			setupClientPacketHandler(newProxyClient);
		} else {
			pendingClient = newProxyClient;
		}
	});
	console.log("Proxy listening on localhost:" + config.connectivity.ports.minecraft + ". Connect Minecraft to join target server.");
}

function start() {
	startParsedServer();
}


function ensureBuffer(val) {
	if (!val) return null;
	if (Buffer.isBuffer(val)) return val;
	if (typeof val === "object" && val.type === "Buffer" && Array.isArray(val.data)) return Buffer.from(val.data);
	if (val instanceof Uint8Array) return Buffer.from(val);
	if (Array.isArray(val)) return Buffer.from(val);
	return null;
}

function isValidNum(n) {
	return typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 3e7;
}

function sanitizeMovementPacket(data, meta) {
	if (!data || typeof data !== "object") return data;
	const movePackets = ["position", "position_look", "look", "flying"];
	if (!movePackets.includes(meta.name)) return data;
	const fallback = posPacket && typeof posPacket === "object" ? posPacket : { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: false };
	const out = { ...data };
	if ("x" in out && !isValidNum(out.x)) out.x = fallback.x ?? 0;
	if ("y" in out && !isValidNum(out.y)) out.y = fallback.y ?? 64;
	if ("z" in out && !isValidNum(out.z)) out.z = fallback.z ?? 0;
	if ("yaw" in out && !isValidNum(out.yaw)) out.yaw = fallback.yaw ?? 0;
	if ("pitch" in out && !isValidNum(out.pitch)) out.pitch = fallback.pitch ?? 0;
	if ("onGround" in out && typeof out.onGround !== "boolean") out.onGround = !!out.onGround;
	return out;
}

function canWrite(dest) {
	if (!dest) return false;
	if (dest.ended) return false;
	const s = dest.socket ?? dest._socket;
	if (s && (s.destroyed || s.writable === false)) return false;
	return true;
}

function filterPacketAndSend(data, meta, dest, sentByClient) {
	if (!canWrite(dest)) return;
	const skipForward = (meta.name === "update_time" && sentByClient);
	if (!skipForward) {
		try {
			let writeData = data;
			if (meta.name === "custom_payload" && data) {
				const buf = ensureBuffer(data.data);
				if (buf === null) return; // Skip if we can't convert
				writeData = { ...data, data: buf };
			}
			const skipSanitize = config.noMovementSanitization || /minemen/i.test(serverConfig.ip);
			if (sentByClient && !skipSanitize) writeData = sanitizeMovementPacket(writeData, meta);
			dest.write(meta.name, writeData);
		} catch (err) {
			const msg = err?.message || "";
			if (msg.includes("write after end") || msg.includes("ERR_STREAM_WRITE_AFTER_END")) return;
			console.error("Packet write error (" + meta.name + "):", msg);
		}
	}
	// Log only when waiting for client; defer recentPackets to avoid blocking packet flow
	if (!packetNameBlacklist.includes(meta.name)) {
		const name = meta.name;
		const dir = sentByClient ? "client" : "server";
		const safeData = sanitizeForLog(data);
		if (safeData !== null) {
			if (!proxyClient) console.log("(" + (sentByClient ? "Client" : "Server") + ") " + name + ": " + JSON.stringify(safeData) + "\n");
			setImmediate(() => {
				recentPackets.unshift({ dir, name, data: safeData, time: new Date().toISOString() });
				if (recentPackets.length > MAX_PACKETS) recentPackets.pop();
			});
		}
	}
}

function hasHugeBinary(obj, depth) {
	if (depth > 5) return true;
	if (Buffer.isBuffer(obj)) return obj.length > 5000;
	if (Array.isArray(obj)) {
		if (obj.length > 200) return true;
		return obj.some(v => hasHugeBinary(v, depth + 1));
	}
	if (obj && typeof obj === "object") {
		return Object.values(obj).some(v => hasHugeBinary(v, depth + 1));
	}
	return false;
}

function sanitizeForLog(obj) {
	if (hasHugeBinary(obj, 0)) return null; // Skip packets with huge binary
	if (obj === null || obj === undefined) return obj;
	if (Buffer.isBuffer(obj)) return "[Buffer " + obj.length + " bytes]";
	if (Array.isArray(obj)) {
		if (obj.length > 30) return "[Array " + obj.length + " items]";
		return obj.map(sanitizeForLog);
	}
	if (typeof obj === "object") {
		const out = {};
		for (const k of Object.keys(obj)) {
			const v = obj[k];
			if (Buffer.isBuffer(v)) out[k] = "[Buffer " + v.length + " bytes]";
			else if (Array.isArray(v) && v.length > 30) out[k] = "[Array " + v.length + " items]";
			else out[k] = sanitizeForLog(v);
		}
		const str = JSON.stringify(out);
		if (str.length > 1500) return null;
		return out;
	}
	return obj;
}
