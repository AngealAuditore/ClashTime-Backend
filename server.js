//
//  server.js
//  ClashTime - Motor de Notificaciones Push en Vivo (APNs) en la Nube
//

const http = require("http");
const http2 = require("http2");
const fs = require("fs");
const crypto = require("crypto");

// 1. Configuración de Credenciales de Apple
const KEY_ID = process.env.KEY_ID || "5933264424";
const TEAM_ID = process.env.TEAM_ID || "S28DC7S995";
const BUNDLE_ID = process.env.BUNDLE_ID || "com.auditore.ClashTime";
const APNS_TOPIC = `${BUNDLE_ID}.push-type.liveactivity`;
const APNS_HOST = process.env.APNS_HOST || "https://api.sandbox.push.apple.com:443";
const PORT = process.env.PORT || 3000;

// Obtener la llave desde variable de entorno o desde archivo local
let AUTH_KEY = process.env.APNS_AUTH_KEY;
if (!AUTH_KEY) {
    const localPath = "/Users/iMacpro/Downloads/AuthKey_5933264424.p8";
    if (fs.existsSync(localPath)) {
        AUTH_KEY = fs.readFileSync(localPath, "utf8");
    }
}

if (!AUTH_KEY) {
    console.error("⚠️ ADVERTENCIA: No se encontró la llave APNs en variable de entorno APNS_AUTH_KEY ni en disco local.");
}

// 2. Generador y Caché de Tokens JWT para APNs
let cachedJWT = null;
let jwtGeneratedAt = 0;

function getAPNsJWT() {
    if (!AUTH_KEY) return null;
    const now = Math.floor(Date.now() / 1000);
    if (cachedJWT && (now - jwtGeneratedAt) < 3000) {
        return cachedJWT;
    }

    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: KEY_ID })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: TEAM_ID, iat: now })).toString("base64url");
    
    const sign = crypto.createSign("sha256");
    sign.update(`${header}.${payload}`);
    const signature = sign.sign({ key: AUTH_KEY, dsaEncoding: "ieee-p1363" }, "base64url");
    
    cachedJWT = `${header}.${payload}.${signature}`;
    jwtGeneratedAt = now;
    return cachedJWT;
}

// 3. Almacén de Dispositivos Registrados
const registeredDevices = new Map();

// 4. Función de Envío APNs HTTP/2
function sendLiveActivityPush(deviceToken, contentState, alertMessage = null, isFinal = false) {
    return new Promise((resolve, reject) => {
        const jwt = getAPNsJWT();
        if (!jwt) {
            console.error("❌ No se puede enviar push: Falta JWT");
            return resolve({ success: false, error: "Missing JWT" });
        }

        const client = http2.connect(APNS_HOST);

        client.on("error", (err) => {
            console.error("⚠️ [APNs HTTP2] Error de conexión:", err.message);
            reject(err);
        });

        const apsPayload = {
            timestamp: Math.floor(Date.now() / 1000),
            event: isFinal ? "end" : "update",
            "content-state": contentState
        };

        if (alertMessage) {
            apsPayload.alert = {
                title: alertMessage.title || "🏈 ClashTime NFL",
                body: alertMessage.body || "Actualización del partido",
                sound: "default"
            };
        }

        const body = JSON.stringify({ aps: apsPayload });

        const req = client.request({
            [http2.constants.HTTP2_HEADER_SCHEME]: "https",
            [http2.constants.HTTP2_HEADER_METHOD]: http2.constants.HTTP2_METHOD_POST,
            [http2.constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
            "authorization": `bearer ${jwt}`,
            "apns-topic": APNS_TOPIC,
            "apns-push-type": "liveactivity",
            "apns-priority": "10",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body)
        });

        let responseBody = "";
        let statusCode = 0;

        req.on("response", (headers) => {
            statusCode = headers[":status"];
        });

        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            responseBody += chunk;
        });

        req.on("end", () => {
            client.close();
            if (statusCode === 200) {
                console.log(`🚀 [APNs 200 OK] ¡Push entregado con éxito a Apple! (${contentState.statusBadgeText})`);
                resolve({ success: true, statusCode });
            } else {
                console.error(`⚠️ [APNs ${statusCode}] Error de Apple:`, responseBody);
                resolve({ success: false, statusCode, responseBody });
            }
        });

        req.on("error", (err) => {
            client.close();
            console.error("❌ [APNs Req Error]:", err.message);
            reject(err);
        });

        req.write(body);
        req.end();
    });
}

// 5. Poller Continuo de ESPN NFL
async function pollESPNAndNotify() {
    if (registeredDevices.size === 0) return;

    try {
        const response = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", {
            headers: { "User-Agent": "Mozilla/5.0 ClashTimeServer/1.0" }
        });
        if (!response.ok) return;
        const data = await response.json();
        const events = data.events || [];

        for (const [deviceToken, info] of registeredDevices.entries()) {
            const event = events.find(e => e.id === info.eventId);
            if (!event) continue;

            const comp = event.competitions?.[0];
            const competitors = comp?.competitors || [];
            if (competitors.length < 2) continue;

            const home = competitors.find(c => c.homeAway === "home") || competitors[0];
            const away = competitors.find(c => c.homeAway === "away") || competitors[1];

            const homeTeam = home.team?.displayName || "Home";
            const awayTeam = away.team?.displayName || "Away";
            const homeScore = home.score || "0";
            const awayScore = away.score || "0";
            const currentScore = `${awayScore} - ${homeScore}`;

            const status = event.status || {};
            const statusType = status.type || {};
            const state = statusType.state || "pre";
            const detail = statusType.detail || statusType.shortDetail || "";
            const isCompleted = statusType.completed || false;
            const displayClock = status.displayClock || "0:00";
            const period = status.period || 0;

            const situation = comp.situation || {};
            const downDistance = situation.downDistanceText;

            const isHalftime = detail.toLowerCase().includes("half") || detail === "HT";
            const isLive = (state === "in" || isHalftime);
            const isFinal = (state === "post" || isCompleted || detail.toLowerCase().includes("final"));

            let statusDisplay = "";
            let secondaryText = "";

            if (isHalftime) {
                statusDisplay = "MEDIO TIEMPO";
                secondaryText = "Medio Tiempo";
            } else if (isLive) {
                const qStr = period <= 4 ? `Q${period}` : "OT";
                if (downDistance) {
                    statusDisplay = `${qStr} ${displayClock} • ${downDistance}`;
                    secondaryText = downDistance;
                } else {
                    statusDisplay = `${qStr} ${displayClock}`;
                    secondaryText = `${qStr} ${displayClock}`;
                }
            } else if (isFinal) {
                statusDisplay = "FINAL";
                secondaryText = "Final NFL";
            } else {
                statusDisplay = detail;
                secondaryText = "NFL • Fútbol Americano";
            }

            let progress = 0.5;
            if (statusDisplay.includes("Q1")) progress = 0.25;
            else if (statusDisplay.includes("Q2")) progress = 0.50;
            else if (statusDisplay.includes("Q3")) progress = 0.75;
            else if (statusDisplay.includes("Q4")) progress = 0.95;
            else if (isFinal) progress = 1.0;

            const scoreChanged = (info.lastScore !== currentScore);
            const statusChanged = (info.lastStatus !== statusDisplay);

            if (scoreChanged || statusChanged || !info.hasPushedInitial) {
                info.lastScore = currentScore;
                info.lastStatus = statusDisplay;
                info.hasPushedInitial = true;

                const contentState = {
                    isLive: isLive,
                    statusBadgeText: statusDisplay,
                    mainHeadline: `${awayTeam} vs. ${homeTeam}`,
                    secondaryDetail: secondaryText,
                    timeOrCountdown: statusDisplay,
                    scoreOrRound: currentScore,
                    alertText: null,
                    progressFraction: progress,
                    liveClockStartDate: null,
                    liveClockEndDate: null,
                    scheduledKickoffDate: null,
                    goalScorersText: null,
                    cardsText: null
                };

                let alertMessage = null;
                if (scoreChanged && isLive) {
                    alertMessage = {
                        title: "🏈 ¡TOUCHDOWN / PUNTOS NFL!",
                        body: `${awayTeam} ${awayScore} - ${homeScore} ${homeTeam} (${statusDisplay})`
                    };
                }

                console.log(`📡 [Cambio Detectado] ${awayTeam} ${currentScore} ${homeTeam} | ${statusDisplay}`);
                await sendLiveActivityPush(deviceToken, contentState, alertMessage, isFinal);
            }
        }
    } catch (err) {
        console.error("⚠️ Error consultando ESPN:", err.message);
    }
}

// Ejecutar sondeo cada 10 segundos
setInterval(pollESPNAndNotify, 10000);

// 6. Servidor HTTP para recibir tokens desde el iPhone
const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method === "POST" && req.url === "/register-token") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", async () => {
            try {
                const data = JSON.parse(body);
                const { token, eventId, sport } = data;

                if (!token || !eventId) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Falta token o eventId" }));
                    return;
                }

                console.log(`📱 [Dispositivo Conectado] Token: ${token.substring(0, 16)}... para evento: ${eventId}`);
                
                registeredDevices.set(token, {
                    eventId,
                    sport: sport || "nfl",
                    lastScore: null,
                    lastStatus: null,
                    hasPushedInitial: false,
                    registeredAt: new Date()
                });

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, message: "Token registrado en la nube con éxito" }));

                setTimeout(pollESPNAndNotify, 500);
            } catch (err) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/status")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            status: "online",
            service: "ClashTime APNs Live Engine",
            connectedDevices: registeredDevices.size,
            uptimeSeconds: Math.floor(process.uptime())
        }));
        return;
    }

    res.writeHead(404);
    res.end();
});

server.listen(PORT, "0.0.0.0", () => {
    console.log("====================================================");
    console.log(`⚡ ClashTime APNs Cloud Engine corriendo en el puerto ${PORT}`);
    console.log(`🔑 Key ID: ${KEY_ID} | Team: ${TEAM_ID}`);
    console.log("====================================================");
});
