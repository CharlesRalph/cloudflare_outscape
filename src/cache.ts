// src/cache.ts
import type {Context} from "hono";

type CacheOptions = {
    ttlSeconds: number;
    cacheKey: string;
};

export async function cachedJson<T>(
    c: Context,
    options: CacheOptions,
    getData: () => Promise<T>
): Promise<Response> {
    const url = new URL(c.req.url);
    url.search = "";
    url.pathname = options.cacheKey;

    const cacheKey = new Request(url.toString(), {
        method: "GET",
    });

    const cache = caches.default;
    const cached = await cache.match(cacheKey);

    if (cached) {
        const response = new Response(cached.body, cached);
        response.headers.set("X-Cache", "HIT");
        return response;
    }

    const data = await getData();

    const response = c.json(data);
    response.headers.set(
        "Cache-Control",
        `public, max-age=${options.ttlSeconds}, s-maxage=${options.ttlSeconds}`
    );
    response.headers.set("X-Cache", "MISS");

    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
}