import config_ from 'app/config.yml';
//@ts-expect-error bun import files becomes path strings
import orefLogo from 'data/oref_logo.png';
import { Toast } from 'powertoast';

type Language = 'english' | 'hebrew' | 'russian' | 'arabic';

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

// ── Helpers ─────────────────────────────────────────────────────────────────
export function israelTime(): string {
    return new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });
}
export const log = config.terminal_support_rtl
    ? console.log.bind(console)
    : (...args: unknown[]) =>
          console.log(...args.map(a => (typeof a === 'string' ? rtlC(a) : a)));

// ── RTL-safe logging ────────────────────────────────────────────────────────

export function rtlC(s: string): string {
    return s.replace(
        /(\p{Script=Hebrew}[^a-zA-Z\d]*\p{Script=Hebrew})/gu,
        match => [...match].reverse().join(''),
    );
}
export async function alertToast(
    alert: string,
    silent = config.silent === true,
) {
    const title = `🚨 ALERT 🚨\n${alert}`;
    await new Toast({
        title,
        aumid: 'oref alert',
        audio: silent
            ? undefined
            : 'ms-winsoundevent:Notification.Looping.Alarm10',
        silent,
        loopAudio: true,
        longTime: true,
        scenario: 'urgent',
        icon: orefLogo,
    }).show();
}

// ── Threat types (from Tzofar alert.threat field) ───────────────────────────

const THREAT_NAMES: Record<number, string> = {
    0: 'Missile / Red Alert',
    2: 'Terrorists Infiltration',
    5: 'Hostile Aircraft / Drone Intrusion',
    7: 'Non-conventional Missile',
};

export function threatName(id: unknown): string {
    if (typeof id === 'number' && id in THREAT_NAMES)
        return THREAT_NAMES[id] ?? 'Unknown';
    return `Unknown (${id})`;
}
