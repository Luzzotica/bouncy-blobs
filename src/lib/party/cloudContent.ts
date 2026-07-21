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

export interface FeedbackInput {
  /** 1–5 stars. */
  rating?: number;
  /** Freeform feedback — bug reports, ideas. Lands in the developer's inbox. */
  text?: string;
  /** Where in the game: route/level/area tag. */
  context?: string;
  matchId?: string;
}

export interface PlayerProfile {
  playerId: string;
  displayName: string | null;
  /** Linked provider ids, e.g. ['anon', 'email']. */
  providers: string[];
  /** Per-project role — 'admin' unlocks dev functionality (debug reporter). */
  role: "player" | "admin";
}

export interface TaskReportInput {
  title: string;
  description?: string;
  /** Where in the game: route/level/area tag. */
  context?: string;
  /** A png/jpeg data URL (e.g. from a page screenshot) attached to the task. */
  screenshotDataUrl?: string;
}

export type PresenceStatus = "online" | "playing";

export interface PresenceCounts {
  online: number;
  playing: number;
  by_game: Record<string, { online: number; playing: number }>;
  stale_after_sec: number;
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

// Auth-change bus — module-level so EVERY CloudContent instance in the tab
// shares it. Games routinely construct one client per module; signing in
// through one must let the others react (refresh profile UIs, drop caches).
type AuthListener = () => void;
const authListeners = new Set<AuthListener>();

/** Subscribe to sign-in/sign-out through any CloudContent instance in this
 *  tab (returns an unsubscribe). Fires AFTER the new token is persisted. */
export function onCloudAuthChanged(l: AuthListener): () => void {
  authListeners.add(l);
  return () => authListeners.delete(l);
}

function notifyAuthChanged(): void {
  authListeners.forEach((l) => l());
}

/** A tiny cloud-content client bound to one game project. */
export class CloudContent {
  private playerToken: string | null = null;
  private loginInFlight: Promise<string | null> | null = null;

  constructor(private readonly config: CloudContentConfig) {
    this.playerToken = readLS(TOKEN_KEY(config.gameId));
  }

  /** Adopt whatever token localStorage holds. Another instance (or another
   *  tab) may have signed in/out since this one cached its copy — a stale
   *  ANON token stays valid forever, so a 401-retry never heals it. Called
   *  before every authenticated request. */
  private syncTokenFromStorage(): void {
    const ls = readLS(TOKEN_KEY(this.config.gameId));
    if (ls !== this.playerToken) this.playerToken = ls;
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
    this.syncTokenFromStorage();
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
    this.syncTokenFromStorage();
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
    return this.withPlayer<{ player_id: string; display_name: string | null; role?: string; identities: { provider: string }[] }>(
      (headers) => fetch(`${this.base()}/api/players/me`, { headers }),
    )
      .then((me) => ({
        playerId: me.player_id,
        displayName: me.display_name,
        providers: (me.identities ?? []).map((i) => i.provider),
        role: (me.role === "admin" ? "admin" : "player") as PlayerProfile["role"],
      }))
      .catch(() => null);
  }

  /**
   * Update profile fields. Partii: `PATCH /api/players/me` body `{ display_name }`.
   * Requires a signed-in (non-anon) player for the name to stick across devices.
   */
  async updateProfile(opts: { displayName: string }): Promise<PlayerProfile> {
    const name = opts.displayName.trim();
    if (!name) throw new Error("Display name is required");
    await this.withPlayer((headers) =>
      fetch(`${this.base()}/api/players/me`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ display_name: name }),
      }),
    );
    notifyAuthChanged();
    const p = await this.profile();
    if (!p) throw new Error("Profile update failed");
    return { ...p, displayName: name };
  }

  /** True once the player has a real (non-anonymous) identity — the gate for
   *  publishing maps/replays to the cloud. */
  async isSignedIn(): Promise<boolean> {
    const p = await this.profile();
    return !!p && p.providers.some((prov) => prov !== "anon");
  }

  /** True when this player has the per-project 'admin' role (granted from the
   *  developer dashboard) — the gate for in-game dev functionality. */
  async isAdmin(): Promise<boolean> {
    const p = await this.profile();
    return p?.role === "admin";
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

  /** Sign in with an Apple Game Center identity-verification signature
   *  (iOS Tauri builds — the GameKit plugin's `authenticate` command returns
   *  this proof). `playerId` must be the TEAM player id (`teamPlayerID`, the
   *  value Apple signs). Link-if-anon-else-login, like Steam. */
  async signInWithGameCenter(proof: {
    publicKeyUrl: string;
    signature: string; // base64
    salt: string; // base64
    timestamp: number | string;
    playerId: string; // teamPlayerID
    displayName?: string;
  }): Promise<PlayerProfile> {
    return this.attachProvider("gamecenter", {
      public_key_url: proof.publicKeyUrl,
      signature: proof.signature,
      salt: proof.salt,
      timestamp: Number(proof.timestamp),
      player_id: proof.playerId,
      ...(proof.displayName ? { display_name: proof.displayName } : {}),
    });
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
        // Same player, new identity — token unchanged but auth state changed.
        notifyAuthChanged();
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
    notifyAuthChanged();
    return (await this.profile()) ?? { playerId: (data as { player_id: string }).player_id, displayName: null, providers: [provider], role: "player" };
  }

  /** Sign out — the next call re-creates a silent anonymous player. */
  signOut(): void {
    this.playerToken = null;
    try { localStorage.removeItem(TOKEN_KEY(this.config.gameId)); } catch { /* ignore */ }
    notifyAuthChanged();
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

  // ── Feedback ─────────────────────────────────────────────────────────────

  /** Submit a match rating and/or freeform feedback. Anonymous players are
   *  accepted (no sign-in gate — feedback is input, not published content).
   *  Best-effort by design: never throws, returns null on any failure so a
   *  post-match "rate this" flow can't break gameplay. */
  async submitFeedback(input: FeedbackInput): Promise<{ id: string } | null> {
    try {
      return await this.withPlayer<{ id: string }>((headers) =>
        fetch(`${this.base()}/api/feedback`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            rating: input.rating,
            text: input.text,
            context: input.context,
            match_id: input.matchId,
            game_id: this.config.gameId,
          }),
        }),
      );
    } catch {
      return null;
    }
  }

  /** Convenience for the post-match star prompt. */
  async rateMatch(rating: number, matchId?: string): Promise<{ id: string } | null> {
    return this.submitFeedback({ rating, matchId });
  }

  /** File a task into the project's inbox from inside the game (the debug
   *  reporter). Server-enforced admin-only — throws on any failure (including
   *  403 admin_required) so the reporter UI can show what went wrong. */
  async reportTask(input: TaskReportInput): Promise<{ id: string }> {
    return this.withPlayer<{ id: string }>((headers) =>
      fetch(`${this.base()}/api/tasks/report`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          context: input.context,
          screenshot: input.screenshotDataUrl,
          game_id: this.config.gameId,
        }),
      }),
    );
  }

  // ── Presence (online / in-game) ──────────────────────────────────────────

  #presenceTimer: ReturnType<typeof setInterval> | null = null;
  #presenceStatus: PresenceStatus = "online";

  /**
   * Heartbeat: mark this player online or in-game. Call once when the app
   * opens, again when entering a match (`status: "playing"`), and on a
   * ~30s interval (see `startPresenceHeartbeat`). Best-effort — never throws.
   * Response includes current project counts.
   */
  async setPresence(opts?: {
    status?: PresenceStatus;
    /** Override game id (defaults to CloudContent config.gameId). */
    gameId?: string | null;
  }): Promise<PresenceCounts | null> {
    if (opts?.status) this.#presenceStatus = opts.status;
    try {
      return await this.withPlayer<PresenceCounts & { ok: boolean }>((headers) =>
        fetch(`${this.base()}/api/presence`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            status: this.#presenceStatus,
            game_id:
              opts && "gameId" in opts
                ? opts.gameId
                : this.config.gameId,
          }),
        }),
      );
    } catch {
      return null;
    }
  }

  /** Clear this player's presence row (app close / sign out). */
  async clearPresence(): Promise<void> {
    this.stopPresenceHeartbeat();
    try {
      await this.withPlayer((headers) =>
        fetch(`${this.base()}/api/presence`, { method: "DELETE", headers }),
      );
    } catch { /* ignore */ }
  }

  /**
   * Project-wide online counts (API key auth — no player required).
   * Optional `gameId` filters to one game tag.
   */
  async getPresence(gameId?: string): Promise<PresenceCounts | null> {
    try {
      const q = gameId ? `?game_id=${encodeURIComponent(gameId)}` : "";
      const res = await fetch(`${this.base()}/api/presence${q}`, {
        headers: { "X-API-Key": this.config.apiKey },
      });
      if (!res.ok) return null;
      return (await res.json()) as PresenceCounts;
    } catch {
      return null;
    }
  }

  /**
   * Auto-heartbeat every `intervalMs` (default 30s). Stops previous timer if any.
   * Also fires one immediate heartbeat. Pair with `clearPresence` on unmount.
   */
  startPresenceHeartbeat(
    opts?: { status?: PresenceStatus; intervalMs?: number },
  ): void {
    if (opts?.status) this.#presenceStatus = opts.status;
    this.stopPresenceHeartbeat();
    void this.setPresence({ status: this.#presenceStatus });
    const ms = opts?.intervalMs ?? 30_000;
    this.#presenceTimer = setInterval(() => {
      void this.setPresence({ status: this.#presenceStatus });
    }, ms);
  }

  stopPresenceHeartbeat(): void {
    if (this.#presenceTimer) {
      clearInterval(this.#presenceTimer);
      this.#presenceTimer = null;
    }
  }
}
