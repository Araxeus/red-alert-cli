import crypto from 'node:crypto';
import { ensureCitiesLoaded, handleRawMessage } from './alert_handler';
import { israelTime, log } from './utils';

let ws: WebSocket | null = null;
let pingTimer: Timer | null = null;
let pongTimer: Timer | null = null;
let reconnectTimer: Timer | null = null;
let reconnectAttempts = 0;

const WS_URL = 'wss://ws.tzevaadom.co.il/socket?platform=ANDROID';
const PING_INTERVAL = 60_000;
const PONG_TIMEOUT = 30 * 60_000; // Must be > server's pong timeout (300s) to avoid false positives
const RECONNECT_BASE = 1_000;
const MAX_RECONNECT = 60_000;
const MAX_ATTEMPTS = 10;

export function connect() {
    ensureCitiesLoaded();
    console.log(`🔌 Connecting to Tzofar WebSocket...`);

    ws = new WebSocket(WS_URL, {
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36',
            Referer: 'https://www.tzevaadom.co.il',
            Origin: 'https://www.tzevaadom.co.il',
            tzofar: crypto.randomBytes(16).toString('hex'),
        },
    });

    ws.addEventListener('open', () => {
        console.log(`✅ Connected [${israelTime()}]`);
        reconnectAttempts = 0;
        startPingPong();
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    });

    ws.addEventListener('message', event => {
        const raw =
            typeof event.data === 'string' ? event.data : event.data.toString();
        if (!raw.length) return;
        resetPongTimeout();
        handleRawMessage(raw);
    });

    ws.addEventListener('error', event => {
        console.error('❌ WebSocket error:', event);
    });

    ws.addEventListener('close', event => {
        console.warn(`⚠️ Connection closed (code ${event.code})`);
        stopPingPong();
        scheduleReconnect();
    });
}

// ── Ping / pong ─────────────────────────────────────────────────────────────

function startPingPong() {
    pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    }, PING_INTERVAL);
    resetPongTimeout();
}

function resetPongTimeout() {
    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = setTimeout(() => {
        console.warn('⚠️ Pong timeout, reconnecting...');
        ws?.close();
    }, PONG_TIMEOUT);
}

function stopPingPong() {
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
    }
    if (pongTimer) {
        clearTimeout(pongTimer);
        pongTimer = null;
    }
}

// ── Reconnect with exponential back-off ─────────────────────────────────────

function scheduleReconnect() {
    if (reconnectTimer) return;
    if (reconnectAttempts >= MAX_ATTEMPTS) {
        console.error('❌ Max reconnect attempts reached. Giving up.');
        return;
    }

    const delay = Math.min(
        RECONNECT_BASE * 1.5 ** reconnectAttempts,
        MAX_RECONNECT,
    );
    console.log(
        `🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts + 1}/${MAX_ATTEMPTS})`,
    );

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectAttempts++;
        connect();
    }, delay);
}

// ── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown() {
    log('\n👋 Shutting down...');
    stopPingPong();
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'Client shutting down');
    }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
