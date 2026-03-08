import crypto from 'node:crypto';
import { resolve } from 'node:path';
import { Toast } from 'powertoast';
import cities from './cities.json';
import config_ from './config.yml';

type Language = 'english' | 'hebrew' | 'russian' | 'arabic';
const languagesShort = ['he', 'en', 'ru', 'ar'] as const;

export const config = config_ as {
    terminal_support_rtl?: boolean;
    silent?: boolean;
    areas?: string[];
    locations?: string[];
    websites: {
        unifiedCities: string;
        cities: Record<Language, string>;
        citiesWeb: Record<Language, string>;
        citiesNotes: Record<Language, string>;
        districts: Record<Language, string>;
        segments: Record<Language, string>;
    };
};

// ── Config ──────────────────────────────────────────────────────────────────

const WS_URL = 'wss://ws.tzevaadom.co.il/socket?platform=ANDROID';
const PING_INTERVAL = 60_000;
const PONG_TIMEOUT = 30 * 60_000; // Must be > server's pong timeout (300s) to avoid false positives
const RECONNECT_BASE = 1_000;
const MAX_RECONNECT = 60_000;
const MAX_ATTEMPTS = 10;
const DEBOUNCE_MS = 120_000; // 2 minutes

const NATIONWIDE_MARKER = 'רחבי הארץ';
const NATIONWIDE_CITY_ID = 10_000_000;

// ── RTL-safe logging ────────────────────────────────────────────────────────

function rtlC(s: string): string {
    return s.replace(
        /(\p{Script=Hebrew}[^a-zA-Z\d]*\p{Script=Hebrew})/gu,
        match => [...match].reverse().join(''),
    );
}

const log = config.terminal_support_rtl
    ? console.log.bind(console)
    : (...args: unknown[]) =>
          console.log(...args.map(a => (typeof a === 'string' ? rtlC(a) : a)));

async function alertToast(alert: string) {
    const title = `🚨 ALERT 🚨\n${alert}`;
    await new Toast({
        title,
        aumid: 'oref alert',
        audio: 'ms-winsoundevent:Notification.Looping.Alarm10',
        loopAudio: true,
        longTime: true,
        scenario: 'urgent',
        icon: resolve(import.meta.dir, './oref_logo.png'),
    }).show();
}

// ── Load cities.json & build lookup maps ────────────────────────────────────

// city ID → name (Hebrew)
const idToCity = new Map<number, (typeof cities)[number]>();
// Set of city IDs we care about (all Jerusalem sub-zones + nationwide)
const watchedIds = new Set<number>();
// Map exact Hebrew city names we care about to their chosen language
const watchedNames = new Map<string, string>();

function loadCities() {
    let matched = 0;

    for (const city of cities) {
        idToCity.set(city.id, city);

        // Check if this city matches any watched location or area prefix
        for (const lang of languagesShort) {
            if (
                config.locations?.some(l =>
                    city[lang].toLowerCase().startsWith(l.toLowerCase()),
                ) ||
                config.areas?.some(a =>
                    city[`area_${lang}`]
                        .toLowerCase()
                        .startsWith(a.toLowerCase()),
                )
            ) {
                watchedIds.add(city.id);
                watchedNames.set(city.he, city[lang]);
                matched++;
                break;
            }
        }
    }

    if (matched === 0) {
        log('⚠️  Warning: No cities matched your config prefixes!');
    }

    log(
        `📂 Loaded ${idToCity.size} cities, ${matched} match watched prefixes:`,
    );
    for (const id of watchedIds) {
        const city = idToCity.get(id);
        if (!city) {
            console.error(
                `❌ IMPOSSIBLE ERROR:Watched city ID ${id} not found in cities.json!`,
            );
            continue;
        }
        log(`   • ${watchedNames.get(city.he)} (ID ${id})`);
    }
}

// ── Threat types (from Tzofar alert.threat field) ───────────────────────────

const THREAT_NAMES: Record<number, string> = {
    0: 'Missile / Red Alert',
    2: 'Terrorists Infiltration',
    5: 'Hostile Aircraft / Drone Intrusion',
    7: 'Non-conventional Missile',
};

function threatName(id: unknown): string {
    if (typeof id === 'number' && id in THREAT_NAMES)
        return THREAT_NAMES[id] ?? 'Unknown';
    return `Unknown (${id})`;
}

// ── Early-warning / exit-notification keyword detection ─────────────────────

const EARLY_WARNING_TITLE = 'מבזק פיקוד העורף';
const EARLY_WARNING_KEYWORDS = [
    'בדקות הקרובות',
    'צפויות להתקבל התרעות',
    'ייתכן ויופעלו התרעות',
    'זיהוי שיגורים',
    'שיגורים לעבר ישראל',
    'בעקבות זיהוי שיגורים',
];

const EXIT_NOTIFICATION_TITLES = ['עדכון פיקוד העורף', EARLY_WARNING_TITLE];
const EXIT_NOTIFICATION_KEYWORDS = ['הסתיים', 'סיום אירוע'];

type SystemMessageKind = 'early-warning' | 'exit-notification' | null;

type SystemMessage = {
    titleHe?: string;
    bodyHe?: string;
    citiesIds?: number[];
};

type Alert = {
    isDrill?: boolean;
    threat?: unknown;
    cities?: string[];
    //[key: string]: unknown;
};

function classifySystemMessage(msg: {
    titleHe?: string;
    bodyHe?: string;
}): SystemMessageKind {
    const title = msg.titleHe ?? '';
    const body = msg.bodyHe ?? '';

    if (
        title.includes(EARLY_WARNING_TITLE) &&
        EARLY_WARNING_KEYWORDS.some(kw => body.includes(kw))
    ) {
        return 'early-warning';
    }

    if (
        EXIT_NOTIFICATION_TITLES.some(t => title.includes(t)) &&
        EXIT_NOTIFICATION_KEYWORDS.some(kw => body.includes(kw))
    ) {
        return 'exit-notification';
    }

    return null;
}

// ── Debounce ────────────────────────────────────────────────────────────────

const debounceMap = new Map<string, number>();

function isDuplicate(kind: string, city: string): boolean {
    const key = `${kind}_${city}`;
    const last = debounceMap.get(key) ?? 0;
    const now = Date.now();
    if (now - last > DEBOUNCE_MS) {
        debounceMap.set(key, now);
        return false;
    }
    return true;
}

// Periodically clean stale debounce entries
setInterval(() => {
    const cutoff = Date.now() - DEBOUNCE_MS;
    for (const [key, ts] of debounceMap) {
        if (ts < cutoff) debounceMap.delete(key);
    }
}, DEBOUNCE_MS);

// ── Helpers ─────────────────────────────────────────────────────────────────

function israelTime(): string {
    return new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });
}

/** Resolve a list of Tzofar city IDs to matched watched-city names + nationwide flag */
function resolveIds(citiesIds: number[]): {
    isNationwide: boolean;
    matched: string[];
} {
    const isNationwide = citiesIds.includes(NATIONWIDE_CITY_ID);
    const matched: string[] = [];

    for (const id of citiesIds) {
        if (watchedIds.has(id)) {
            const city = idToCity.get(id);
            if (city) matched.push(watchedNames.get(city.he) ?? city.he);
        }
    }

    return { isNationwide, matched };
}

/** Check if a Hebrew city name is one we're watching (by prefix match) */
function isWatchedCity(cityName: string): boolean {
    return watchedNames.has(cityName);
}

// ── Message handlers ────────────────────────────────────────────────────────

function handleAlert(alert: Alert) {
    if (!alert || alert.isDrill) return;

    const cities: string[] = alert.cities ?? [];
    if (!cities.length) return;

    const isNationwide = cities.includes(NATIONWIDE_MARKER);
    const matchedCities = cities.filter(isWatchedCity);

    if (!isNationwide && matchedCities.length === 0) return;

    // Debounce per city
    const relevantCities = isNationwide
        ? [...watchedNames.values(), 'Nationwide']
        : matchedCities;
    const fresh = relevantCities.filter(c => !isDuplicate('alert', c));
    if (fresh.length === 0) return;

    const threat = threatName(alert.threat);

    log(`\n🚨 ========== ALERT ========== 🚨`);
    log(`⏰ ${israelTime()}`);
    log(`⚠️  Threat type: ${threat}`);
    if (isNationwide) log(`🌍 NATIONWIDE ALERT`);
    if (matchedCities.length)
        log(`📍 Matched cities: ${matchedCities.join(', ')}`);
    //log(`📋 All cities in alert: ${cities.join(', ')}`);
    log(`=============================\n`);

    alertToast(threat);
}

function handleSystemMessage(msg: SystemMessage) {
    if (!msg) return;

    const kind = classifySystemMessage(msg);
    const title: string = msg.titleHe ?? '';
    const body: string = msg.bodyHe ?? '';
    const citiesIds: number[] = msg.citiesIds ?? [];

    if (kind === 'early-warning') {
        const { isNationwide, matched } = resolveIds(citiesIds);

        if (!isNationwide && matched.length === 0) return;

        const relevant = isNationwide
            ? [...watchedNames.values(), 'Nationwide']
            : matched;
        const fresh = relevant.filter(c => !isDuplicate('early-warning', c));
        if (fresh.length === 0) return;

        console.log(`\n🟡🟠 ====== EARLY WARNING ====== 🟠🟡`);
        console.log(`⏰ ${israelTime()}`);
        if (isNationwide) console.log(`🌍 NATIONWIDE`);
        log(`📍 Areas: ${fresh.join(', ')}`);
        log(`   Title: ${title}`);
        log(`   Body:  ${body}`);
        console.log(`==============================\n`);

        alertToast(`EARLY WARNING: ${title}`);
        return;
    }

    if (kind === 'exit-notification') {
        const { isNationwide, matched } = resolveIds(citiesIds);

        if (!isNationwide && matched.length === 0) return;

        const relevant = isNationwide
            ? [...watchedNames.values(), 'Nationwide']
            : matched;
        const fresh = relevant.filter(
            c => !isDuplicate('exit-notification', c),
        );
        if (fresh.length === 0) return;

        console.log(`\n🟢 ==== THREAT ENDED ==== 🟢`);
        console.log(`⏰ ${israelTime()}`);
        if (isNationwide) console.log(`🌍 NATIONWIDE`);
        log(`📍 Areas: ${fresh.join(', ')}`);
        log(`   Title: ${title}`);
        log(`   Body:  ${body}`);
        console.log(`==============================\n`);
        return;
    }

    // Unclassified system message – log for visibility
    log(
        `\n📋 System message (unclassified) @ ${israelTime()}:\n\tTitle: ${title}\n\tBody:  ${body}`,
    );
}

// ── WebSocket plumbing ──────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let pingTimer: Timer | null = null;
let pongTimer: Timer | null = null;
let reconnectTimer: Timer | null = null;
let reconnectAttempts = 0;

function handleRaw(raw: string) {
    let data: { type: string; data: Alert | SystemMessage };
    try {
        data = JSON.parse(raw);
    } catch {
        console.warn(`❌ Invalid JSON: ${raw.substring(0, 120)}`);
        return;
    }

    if (data.type === 'ALERT') {
        handleAlert(data.data as Alert);
    } else if (data.type === 'SYSTEM_MESSAGE') {
        handleSystemMessage(data.data as SystemMessage);
    } else {
        console.log(JSON.stringify(data, null, 2));
        console.warn(`❓ Unknown message type: ${data.type}`);
    }
}

function connect() {
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
        handleRaw(raw);
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

// ── Start ───────────────────────────────────────────────────────────────────

log('🛡️  Red Alert Monitor — watching for alerts');
loadCities();
connect();
