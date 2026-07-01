import type { Env } from "./types";

export class RezdyClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(env: Env) {
    this.baseUrl = env.REZDY_BASE_URL;
    this.apiKey = env.REZDY_API_KEY;
  }

  private buildUrl(path: string, params: Record<string, string> = {}): string {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("apiKey", this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async get<T>(
    path: string,
    params: Record<string, string> = {}
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    const res = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new RezdyError(res.status, body);
    }

    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = this.buildUrl(path);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new RezdyError(res.status, errBody);
    }

    return res.json() as Promise<T>;
  }
}

export class RezdyError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`Rezdy API error ${status}: ${body}`);
    this.name = "RezdyError";
  }
}
