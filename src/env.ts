export interface Env {
    DB_2024: D1Database;
    DB_2019: D1Database;
    /** JSON object mapping API key to a client label, for example {"abc...":"pan"}. */
    API_KEYS: string;
}

declare global {
    namespace Cloudflare {
        interface GlobalProps {
            mainModule: typeof import('./index');
        }
        interface Env {
            DB_2024: D1Database;
            DB_2019: D1Database;
            API_KEYS: string;
        }
    }
}
