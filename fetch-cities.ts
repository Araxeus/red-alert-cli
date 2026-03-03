import { writeFile } from 'node:fs/promises';
import config_ from './config.yml';

type Language = 'english' | 'hebrew' | 'russian' | 'arabic';
const config = config_ as {
    terminal_support_rtl?: boolean;
    regions?: string[];
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

const unified = (await fetch(config.websites?.unifiedCities).then(res =>
    res.json(),
)) as {
    cities: Record<
        string,
        {
            id: number;
            he: string;
            en: string;
            ru: string;
            ar: string;
            es?: string;
            area: number;
            countdown: number;
            lat?: number;
            lng?: number;
            area_he?: string;
            area_en?: string;
            area_ru?: string;
            area_ar?: string;
        }
    >;
    areas: Record<
        string,
        { he: string; en: string; ru: string; ar: string; es: string }
    >;
};

const cities = Object.values(unified.cities);
for (const city of cities) {
    const area = unified.areas[city.area];
    if (!area) {
        console.log(
            `Missing area for city ${city.he} / ${city.en} (area id: ${city.area})`,
        );
        continue;
    }
    city.area_he = unified.areas[city.area]?.he;
    city.area_en = unified.areas[city.area]?.en;
    city.area_ru = unified.areas[city.area]?.ru;
    city.area_ar = unified.areas[city.area]?.ar;

    // we don't need these fields, and they take up a lot of space, so let's remove them
    delete city.es;
    delete city.lat;
    delete city.lng;
}

await writeFile('cities.json', JSON.stringify(cities));

console.log(`${cities.length} cities loaded and saved to cities.json`);
