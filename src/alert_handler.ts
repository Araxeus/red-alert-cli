import cities from 'data/cities.json';
import { alertToast, config, israelTime, log, threatName } from './utils';

const languagesShort = ['he', 'en', 'ru', 'ar'] as const;

const DEBOUNCE_MS = 120_000; // 2 minutes

const NATIONWIDE_MARKER = 'רחבי הארץ';
const NATIONWIDE_CITY_ID = 10_000_000;

// ── Load cities.json & build lookup maps ────────────────────────────────────

// city ID → city data
const idToCity = new Map<number, (typeof cities)[number]>();
// Set of city IDs we care about
const watchedIds = new Set<number>();
// Map city names in Hebrew to the chosen language in config
const watchedNames = new Map<string, string>();

let citiesLoaded = false;
export function ensureCitiesLoaded() {
    if (citiesLoaded) return;
    citiesLoaded = true;

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

export function handleRawMessage(raw: string) {
    ensureCitiesLoaded();

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
