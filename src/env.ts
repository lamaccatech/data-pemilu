export interface Env {
    DB_2024: D1Database;
    DB_2019: D1Database;
    /** Boundary files, one object per election and area level: <pemilu>/<wilayah>.geojson. */
    GEO: R2Bucket;
    /** JSON object mapping API key to a client label, for example {"abc...":"pan"}. */
    API_KEYS: string;
    /** Finished answers, keyed by URL and response version. Optional: without it only the Cache API is used. */
    CACHE_KV?: KVNamespace;
}

declare global {
    namespace Cloudflare {
        interface GlobalProps {
            mainModule: typeof import('./index');
        }
        interface Env {
            DB_2024: D1Database;
            DB_2019: D1Database;
            GEO: R2Bucket;
            API_KEYS: string;
            CACHE_KV?: KVNamespace;
        }
    }
}
