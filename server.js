//
//  server.js
//  ClashTime - Motor de Notificaciones Push en Vivo (APNs) en la Nube
//

const http = require("http");
const http2 = require("http2");
const fs = require("fs");
const crypto = require("crypto");

// 1. Configuraci√≥n de Credenciales de Apple
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
    console.error("‚ö†Ô∏è ADVERTENCIA: No se encontr√≥ la llave APNs en variable de entorno APNS_AUTH_KEY ni en disco local.");
}

// 2. Generador y Cach√© de Tokens JWT para APNs
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

// 3. Almac√©n de Dispositivos Registrados
const registeredDevices = new Map();

// 4. Funci√≥n de Env√≠o APNs HTTP/2
function sendLiveActivityPush(deviceToken, contentState, alertMessage = null, isFinal = false) {
    return new Promise((resolve, reject) => {
        const jwt = getAPNsJWT();
        if (!jwt) {
            console.error("‚ùå No se puede enviar push: Falta JWT");
            return resolve({ success: false, error: "Missing JWT" });
        }

        const client = http2.connect(APNS_HOST);

        client.on("error", (err) => {
            console.error("‚ö†Ô∏è [APNs HTTP2] Error de conexi√≥n:", err.message);
            reject(err);
        });

        const apsPayload = {
            timestamp: Math.floor(Date.now() / 1000),
            event: isFinal ? "end" : "update",
            "content-state": contentState
        };

        if (alertMessage) {
            apsPayload.alert = {
                title: alertMessage.title || "üèà ClashTime NFL",
                body: alertMessage.body || "Actualizaci√≥n del partido",
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
                console.log(`üöÄ [APNs 200 OK] ¬°Push entregado con √©xito a Apple! (${contentState.statusBadgeText})`);
                resolve({ success: true, statusCode });
            } else {
                console.error(`‚ö†Ô∏è [APNs ${statusCode}] Error de Apple:`, responseBody);
                resolve({ success: false, statusCode, responseBody });
            }
        });

        req.on("error", (err) => {
            client.close();
            console.error("‚ùå [APNs Req Error]:", err.message);
            reject(err);
        });

        req.write(body);
        req.end();
    });
}

function abbreviatePlayerName(name) {
    if (!name) return "";
    const parts = name.trim().split(/\s+/);
    if (parts.length <= 1) return name;
    return `${parts[0].charAt(0)}. ${parts.slice(1).join(" ")}`;
}

// 5. Poller Continuo de ESPN (NFL & Soccer)
const SOCCER_LEAGUES = [
    "mex.1", "esp.1", "eng.1", "uefa.champions", "usa.1", 
    "fifa.friendly", "ita.1", "ger.1", "fra.1", "concacaf.champions", "conmebol.libertadores"
];

async function pollESPNAndNotify() {
    if (registeredDevices.size === 0) return;

    // A. Sondeo NFL
    try {
        const response = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", {
            headers: { "User-Agent": "Mozilla/5.0 ClashTimeServer/1.0" }
        });
        if (response.ok) {
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
                            statusDisplay = `${qStr} ${displayClock} ‚Ä¢ ${downDistance}`;
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
                        secondaryText = "NFL ‚Ä¢ F√∫tbol Americano";
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
                                title: "üèà ¬°TOUCHDOWN / PUNTOS NFL!",
                                body: `${awayTeam} ${awayScore} - ${homeScore} ${homeTeam} (${statusDisplay})`
                            };
                        }

                        console.log(`üì° [Cambio Detectado NFL] ${awayTeam} ${currentScore} ${homeTeam} | ${statusDisplay}`);
                        await sendLiveActivityPush(deviceToken, contentState, alertMessage, isFinal);
                    }
                }
            }
        } catch (err) {
            console.error("‚ö†Ô∏è Error consultando ESPN NFL:", err.message);
        }

    // B. Sondeo F√∫tbol (Soccer)
    for (const league of SOCCER_LEAGUES) {
        try {
            const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard`, {
                headers: { "User-Agent": "Mozilla/5.0 ClashTimeServer/1.0" }
            });
            if (!response.ok) continue;
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

                    const homeTeam = home.team?.displayName || "Local";
                    const awayTeam = away.team?.displayName || "Visitante";
                    const homeScore = home.score || "0";
                    const awayScore = away.score || "0";
                    const currentScore = `${awayScore} - ${homeScore}`;

                    const status = event.status || {};
                    const statusType = status.type || {};
                    const state = statusType.state || "pre";
                    const detail = statusType.detail || statusType.shortDetail || "";
                    const detailLower = detail.toLowerCase();
                    const isCompleted = statusType.completed || false;
                    const displayClock = status.displayClock || "";

                    const isHalftime = detailLower.includes("half") || detailLower.includes("medio") || detail === "HT";
                    const isLive = (state === "in" || isHalftime);
                    const isFinal = (state === "post" || isCompleted || detailLower.includes("final") || detail === "FT");

                    // Parsear Goles y Tarjetas desde comp.details
                    const details = comp.details || [];
                    let scorersList = [];
                    let cardsList = [];

                    for (const item of details) {
                        const typeObj = item.type || {};
                        const typeText = (typeObj.text || "").toLowerCase();
                        const isScoringPlay = item.scoringPlay || false;
                        const isYellow = item.yellowCard || typeText.includes("yellow");
                        const isRed = item.redCard || typeText.includes("red");

                        const clockObj = item.clock || {};
                        const minuteStr = clockObj.displayValue || "";
                        const cleanMinute = minuteStr ? (minuteStr.includes("'") ? minuteStr : `${minuteStr}'`) : "";

                        const athletes = item.athletesInvolved || [];
                        const first = athletes[0];
                        if (!first) continue;
                        const athleteName = first.shortName || first.displayName || "";
                        if (!athleteName) continue;
                        const abbrev = abbreviatePlayerName(athleteName);

                        if (isScoringPlay || typeText.includes("goal")) {
                            scorersList.push(`${abbrev} ${cleanMinute}`);
                        } else if (isRed) {
                            cardsList.push(`üü• ${abbrev} ${cleanMinute}`);
                        } else if (isYellow) {
                            cardsList.push(`üü® ${abbrev} ${cleanMinute}`);
                        }
                    }

                    const goalScorersText = scorersList.length > 0 ? scorersList.join(" ‚Ä¢ ") : null;
                    const cardsText = cardsList.length > 0 ? cardsList.join(" ‚Ä¢ ") : null;

                    let statusDisplay = "";
                    let secondaryText = "";

                    if (isHalftime) {
                        statusDisplay = "MEDIO TIEMPO";
                        secondaryText = "Medio Tiempo";
                    } else if (isLive) {
                        const halfName = status.period === 2 ? "2do Tiempo" : "1er Tiempo";
                        const clockClean = (displayClock || "").replace(/'/g, "").trim();
                        const clockStr = clockClean ? `${clockClean}'` : "";
                        statusDisplay = "EN VIVO";
                        secondaryText = clockStr ? `${clockStr} ‚Ä¢ ${halfName}` : halfName;
                    } else if (isFinal) {
                        statusDisplay = "FINAL";
                        secondaryText = "Partido Finalizado";
                    } else {
                        statusDisplay = detail;
                        secondaryText = "F√∫tbol";
                    }

                    const scoreChanged = (info.lastScore !== currentScore);
                    const statusChanged = (info.lastStatus !== secondaryText);
                    const cardsChanged = (info.lastCards !== cardsText);

                    if (scoreChanged || statusChanged || cardsChanged || !info.hasPushedInitial) {
                        info.lastScore = currentScore;
                        info.lastStatus = secondaryText;
                        info.lastCards = cardsText;
                        info.hasPushedInitial = true;

                        const contentState = {
                            isLive: isLive,
                            statusBadgeText: isHalftime ? "MEDIO TIEMPO" : (isFinal ? "FINAL" : "EN VIVO"),
                            mainHeadline: `${awayTeam} vs. ${homeTeam}`,
                            secondaryDetail: secondaryText,
                            timeOrCountdown: secondaryText,
                            scoreOrRound: currentScore,
                            alertText: null,
                            progressFraction: isFinal ? 1.0 : (isHalftime ? 0.5 : 0.7),
                            liveClockStartDate: null,
                            liveClockEndDate: null,
                            scheduledKickoffDate: null,
                            goalScorersText: goalScorersText,
                            cardsText: cardsText
                        };

                        let alertMessage = null;
                        if (scoreChanged && isLive) {
                            alertMessage = {
                                title: "‚öΩ ¬°GOOOL!",
                                body: `${awayTeam} ${awayScore} - ${homeScore} ${homeTeam} (${secondaryText})`
                            };
                        } else if (cardsChanged && isLive && cardsText) {
                            const isRed = cardsText.includes("üü•");
                            alertMessage = {
                                title: isRed ? "üü• ¬°TARJETA ROJA!" : "üü® ¬°TARJETA AMARILLA!",
                                body: `${awayTeam} vs. ${homeTeam} ‚Ä¢ ${cardsText}`
                            };
                        }

                        console.log(`üì° [Cambio Detectado Soccer] ${awayTeam} ${currentScore} ${homeTeam} | ${secondaryText} | Tarjetas: ${cardsText || "Ninguna"}`);
                        await sendLiveActivityPush(deviceToken, contentState, alertMessage, isFinal);
                    }
                }
            } catch (err) {
                // Silencioso por liga
            }
        }
}

// Ejecutar sondeo cada 10 segundos
setInterval(pollESPNAndNotify, 10000);

// Keep-alive interno para evitar que Render se duerma en Free Tier mientras haya dispositivos conectados
setInterval(() => {
    if (registeredDevices.size > 0) {
        const pingUrl = process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/status` : `http://localhost:${PORT}/status`;
        fetch(pingUrl).catch(() => {});
    }
}, 3 * 60 * 1000);

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

                console.log(`üì± [Dispositivo Conectado] Token: ${token.substring(0, 16)}... para evento: ${eventId}`);
                
                registeredDevices.set(token, {
                    eventId,
                    sport: sport || "nfl",
                    lastScore: null,
                    lastStatus: null,
                    hasPushedInitial: false,
                    registeredAt: new Date()
                });

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, message: "Token registrado en la nube con √©xito" }));

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
    console.log(`‚ö° ClashTime APNs Cloud Engine corriendo en el puerto ${PORT}`);
    console.log(`üîë Key ID: ${KEY_ID} | Team: ${TEAM_ID}`);
    console.log("====================================================");
});
