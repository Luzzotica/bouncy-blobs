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

/** Thrown by publish() when the player is anonymous and must sign in first.
 *  Callers should catch this and open a sign-in modal. */
export class LoginRequiredError extends Error {
  constructor() {
    super("login_required");
    this.name = "LoginRequiredError";
  }
}

export interface PlayerProfile {
  playerId: string;
  displayName: string | null;
  /** Linked provider ids, e.g. ['anon', 'email']. */
  providers: string[];
}

function readLS(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLS(key: string, val: string): void {
  try { localStorage.setItem(key, val); } catch { /* private mode / non-browser */ }
}

/** True when a JWT's `exp` is past or within `slackSeconds` of now. Treats
 *  unparseable tokens as expired so a bad cache entry heals via re-login. */
function jwtNearExpiry(token: string, slackSeconds = 300): boolean {
  try {
    const payload = token.split(".")[1];
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof json.exp !== "number") return false; // no expiry claim — trust it
    return json.exp * 1000 <= Date.now() + slackSeconds * 1000;
  } catch {
    return true;
  }
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

  /** A valid player JWT for BYO attestation (the `platform: "player"` token
   *  exchange): a session token is only minted when the backend can verify
   *  this token, so hand out a fresh one — silently anon-logging-in if the
   *  cached token is missing, expired, or within 5 minutes of expiry. A
   *  device whose anon identity was linked to a real account resumes as the
   *  same player. Returns null when the backend is unreachable (callers fall
   *  back to the API-key path while enforcement is off). */
  async getPlayerToken(): Promise<string | null> {
    if (this.playerToken && !jwtNearExpiry(this.playerToken)) return this.playerToken;
    this.playerToken = null;
    return this.ensurePlayer();
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
    if (!res.ok) {
      if ((data as { error?: string }).error === "login_required") throw new LoginRequiredError();
      throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    }
    return data as T;
  }

  // ── Sign-in ──────────────────────────────────────────────────────────────

  /** Current player profile (creates a silent anon player if none). */
  async profile(): Promise<PlayerProfile | null> {
    return this.withPlayer<{ player_id: string; display_name: string | null; identities: { provider: string }[] }>(
      (headers) => fetch(`${this.base()}/api/players/me`, { headers }),
    )
      .then((me) => ({
        playerId: me.player_id,
        displayName: me.display_name,
        providers: (me.identities ?? []).map((i) => i.provider),
      }))
      .catch(() => null);
  }

  /** True once the player has a real (non-anonymous) identity — the gate for
   *  publishing maps/replays to the cloud. */
  async isSignedIn(): Promise<boolean> {
    const p = await this.profile();
    return !!p && p.providers.some((prov) => prov !== "anon");
  }

  private async emailAuthConfig(): Promise<{ authUrl: string; anonKey: string }> {
    const res = await fetch(`${this.base()}/api/players/providers`, {
      headers: { "X-API-Key": this.config.apiKey },
    });
    const data = await res.json();
    const email = (data as { providers?: { email?: { auth_url?: string; anon_key?: string } } }).providers?.email;
    if (!email?.auth_url || !email?.anon_key) throw new Error("Email sign-in is not available");
    return { authUrl: email.auth_url.replace(/\/$/, ""), anonKey: email.anon_key };
  }

  /** Create a hosted email account and sign in. */
  async signUpWithEmail(email: string, password: string): Promise<PlayerProfile> {
    const { authUrl, anonKey } = await this.emailAuthConfig();
    const res = await fetch(`${authUrl}/signup`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data as { msg?: string; error_description?: string }).msg ?? (data as { error_description?: string }).error_description ?? "Sign-up failed");
    // Supabase may require email confirmation → no session yet. If we got a
    // token, link/login immediately; otherwise the caller must confirm first.
    const token = (data as { access_token?: string }).access_token;
    if (!token) throw new Error("Check your email to confirm your account, then sign in.");
    return this.attachEmail(token);
  }

  /** Sign in to an existing hosted email account (password grant). */
  async signInWithEmail(email: string, password: string): Promise<PlayerProfile> {
    const { authUrl, anonKey } = await this.emailAuthConfig();
    const res = await fetch(`${authUrl}/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok || !(data as { access_token?: string }).access_token) {
      throw new Error((data as { error_description?: string }).error_description ?? "Sign-in failed");
    }
    return this.attachEmail((data as { access_token: string }).access_token);
  }

  /** Sign in with a Steam auth session ticket (Tauri/Steam builds). */
  async signInWithSteam(ticket: string, steamId?: string): Promise<PlayerProfile> {
    return this.attachProvider("steam", { ticket, steam_id: steamId });
  }

  /** Sign in with a token handed down from the host Arcade (iframe/mobile SSO).
   *  Arcade accounts share the Lobbii auth pool, so this resolves to the SAME
   *  player as an in-game email sign-in with that account. */
  async signInWithArcadeToken(accessToken: string): Promise<PlayerProfile> {
    return this.attachProvider("email", { access_token: accessToken });
  }

  /** Link-if-anon-else-login: attach the provider to the current device player
   *  (preserving local content); if that identity already belongs to another
   *  player, switch to logging into it. */
  private async attachEmail(accessToken: string): Promise<PlayerProfile> {
    return this.attachProvider("email", { access_token: accessToken });
  }

  private async attachProvider(provider: string, proof: Record<string, unknown>): Promise<PlayerProfile> {
    const token = await this.ensurePlayer();
    if (token) {
      // Try to LINK onto the existing (anon) player first.
      const linkRes = await fetch(`${this.base()}/api/players/link`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ provider, ...proof }),
      });
      if (linkRes.ok) {
        const p = await this.profile();
        if (p) return p;
      } else {
        const err = await linkRes.json().catch(() => ({}));
        // 409 → this identity already owns a different player: log into it.
        if ((err as { error?: string }).error !== "identity_already_linked" && linkRes.status !== 409) {
          throw new Error((err as { error?: string }).error ?? "Sign-in failed");
        }
      }
    }
    // Login (creates or returns the provider's player); replace our token.
    const res = await fetch(`${this.base()}/api/players/login`, {
      method: "POST",
      headers: { "X-API-Key": this.config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ provider, ...proof }),
    });
    const data = await res.json();
    if (!res.ok || !(data as { player_token?: string }).player_token) {
      throw new Error((data as { error?: string }).error ?? "Sign-in failed");
    }
    this.playerToken = (data as { player_token: string }).player_token;
    writeLS(TOKEN_KEY(this.config.gameId), this.playerToken);
    return (await this.profile()) ?? { playerId: (data as { player_id: string }).player_id, displayName: null, providers: [provider] };
  }

  /** Sign out — the next call re-creates a silent anonymous player. */
  signOut(): void {
    this.playerToken = null;
    try { localStorage.removeItem(TOKEN_KEY(this.config.gameId)); } catch { /* ignore */ }
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
