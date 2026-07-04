// GENERATED from packages/party-kit — edit there, then run scripts/sync-party-kit.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Cloud content client — save & share player content (levels, replays, saves)
// through the Lobbii backend. Engine-agnostic; see PROTOCOL.md §7–§8.
//
// Zero-friction by design: a persistent ANONYMOUS player is created silently on
// first use (a device id kept in localStorage), so sharing works with no login
// UI. Games that add real sign-in can pass their own player token instead.
// ─────────────────────────────────────────────────────────────────────────────

export interface CloudContentConfig {
  baseUrl: string;
  apiKey: string;
  /** Persist-key namespace so multiple games on one origin don't collide. */
  gameId: string;
}

export interface CloudItem {
  id: string;
  owner_player_id: string;
  game_id: string | null;
  content_type: string;
  name: string;
  description: string | null;
  visibility: "private" | "unlisted" | "public";
  share_code: string;
  size_bytes: number;
  content_mime: string;
  created_at: string;
  updated_at: string;
}

const DEVICE_KEY = "lobbii_device_id";
const TOKEN_KEY = (game: string) => `lobbii_player_token_${game}`;

function readLS(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLS(key: string, val: string): void {
  try { localStorage.setItem(key, val); } catch { /* private mode / non-browser */ }
}

/** A tiny cloud-content client bound to one game project. */
export class CloudContent {
  private playerToken: string | null = null;
  private loginInFlight: Promise<string | null> | null = null;

  constructor(private readonly config: CloudContentConfig) {
    this.playerToken = readLS(TOKEN_KEY(config.gameId));
  }

  private base(): string {
    return this.config.baseUrl.replace(/\/$/, "");
  }

  /** Stable anonymous device id (persisted). */
  private deviceId(): string {
    let id = readLS(DEVICE_KEY);
    if (!id) {
      id = (globalThis.crypto?.randomUUID?.() ?? `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      writeLS(DEVICE_KEY, id);
    }
    return id;
  }

  /** Ensure we hold a player token — silent anonymous login, cached, single-flight. */
  private async ensurePlayer(): Promise<string | null> {
    if (this.playerToken) return this.playerToken;
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      try {
        const res = await fetch(`${this.base()}/api/players/login`, {
          method: "POST",
          headers: { "X-API-Key": this.config.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "anon", device_id: this.deviceId() }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { player_token?: string };
        this.playerToken = data.player_token ?? null;
        if (this.playerToken) writeLS(TOKEN_KEY(this.config.gameId), this.playerToken);
        return this.playerToken;
      } catch {
        return null;
      } finally {
        this.loginInFlight = null;
      }
    })();
    return this.loginInFlight;
  }

  private async playerHeaders(): Promise<Record<string, string> | null> {
    const token = await this.ensurePlayer();
    if (!token) return null;
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  /** One retry on 401 (token expired) — re-login and repeat. */
  private async withPlayer<T>(fn: (headers: Record<string, string>) => Promise<Response>): Promise<T> {
    let headers = await this.playerHeaders();
    if (!headers) throw new Error("Cloud sign-in unavailable");
    let res = await fn(headers);
    if (res.status === 401) {
      this.playerToken = null;
      headers = await this.playerHeaders();
      if (!headers) throw new Error("Cloud sign-in unavailable");
      res = await fn(headers);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return data as T;
  }

  /** Publish a JSON payload (a level, a save). Returns its id + share code. */
  async publish(opts: {
    contentType: string;
    name: string;
    data: unknown;
    description?: string;
    visibility?: "private" | "unlisted" | "public";
  }): Promise<{ id: string; share_code: string; size_bytes: number }> {
    return this.withPlayer((headers) =>
      fetch(`${this.base()}/api/player-content`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          content_type: opts.contentType,
          name: opts.name,
          description: opts.description,
          game_id: this.config.gameId,
          visibility: opts.visibility ?? "public",
          data: opts.data,
        }),
      }),
    );
  }

  /** Fetch one item's JSON payload by id or share code. */
  async fetchData<T = unknown>(idOrCode: string): Promise<{ item: CloudItem; data: T }> {
    const code = idOrCode.trim();
    let id = code;
    if (!/^[0-9a-f-]{36}$/i.test(code)) {
      // A share code — resolve to an id first.
      const list = await this.listPublic({ shareCode: code.toUpperCase() });
      if (!list.length) throw new Error("No content found for that code");
      id = list[0].id;
    }
    const res = await fetch(`${this.base()}/api/player-content/${id}?inline=true`, {
      headers: { "X-API-Key": this.config.apiKey },
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    const { data: payload, ...item } = data as CloudItem & { data: T };
    return { item: item as CloudItem, data: payload };
  }

  /** Browse public content for this game (newest first). */
  async listPublic(opts: { contentType?: string; shareCode?: string; limit?: number } = {}): Promise<CloudItem[]> {
    const q = new URLSearchParams({ visibility: "public", game_id: this.config.gameId });
    if (opts.contentType) q.set("content_type", opts.contentType);
    if (opts.shareCode) q.set("share_code", opts.shareCode);
    if (opts.limit) q.set("limit", String(opts.limit));
    const res = await fetch(`${this.base()}/api/player-content?${q}`, {
      headers: { "X-API-Key": this.config.apiKey },
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return ((data as { content?: CloudItem[] }).content) ?? [];
  }

  /** List the current (anonymous) player's own content. */
  async listMine(opts: { contentType?: string; limit?: number } = {}): Promise<CloudItem[]> {
    return this.withPlayer<{ content: CloudItem[] }>((headers) => {
      const q = new URLSearchParams({ mine: "true" });
      if (opts.contentType) q.set("content_type", opts.contentType);
      if (opts.limit) q.set("limit", String(opts.limit));
      return fetch(`${this.base()}/api/player-content?${q}`, { headers });
    }).then((r) => r.content ?? []);
  }

  /** Delete one of the player's own items. */
  async remove(id: string): Promise<void> {
    await this.withPlayer((headers) =>
      fetch(`${this.base()}/api/player-content/${id}`, { method: "DELETE", headers }),
    );
  }
}
