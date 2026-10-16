import {
  createClient,
  type SupabaseClient,
  type Session,
  type AuthChangeEvent,
} from "@supabase/supabase-js";
/** The Hub broker owns SDK persistence/refresh. Other origins receive only
 * short-lived access tokens in memory; never write/copy cross-origin storage. */
export const suiteOrigins = [
  "https://team.frc4418.org",
  "https://inventory.frc4418.org",
  "https://pit.frc4418.org",
  "https://finance.frc4418.org",
];
const hub = suiteOrigins[0];
const protocol = "4418-suite-auth-v1";
export function createSuiteClient(
  url: string,
  key: string,
  fallback?: Parameters<typeof createClient>[2],
): SupabaseClient {
  if (!suiteOrigins.includes(location.origin))
    return createClient(url, key, fallback);
  // A Hub-opened app talks to its first-party opener, not an isolated iframe.
  // Referrer selects the transport; every reply still checks origin AND source.
  let firstParty = location.origin !== hub && window.opener &&
    document.referrer && new URL(document.referrer).origin === hub
      ? window.opener as Window : null;
  const children = new Map<Window, string>();
  const methods = new Set(["getSession", "getUser", "signInWithPassword", "signOut",
    "resetPasswordForEmail", "updateUser", "exchangeCodeForSession", "setSession"]);
  const frame = document.createElement("iframe");
  frame.src = hub + "/suite-auth.html";
  frame.hidden = true;
  frame.title = "Team 4418 secure session";
  frame.referrerPolicy = "origin";
  const listeners = new Set<
    (event: AuthChangeEvent, session: Session | null) => void
  >();
  const pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let session: Session | null = null;
  let authVersion = 0;
  let frameReady: Promise<void> | null = null;
  let frameLoaded = false;
  function connectFrame() {
    if (frameLoaded) return Promise.resolve();
    if (frameReady) return frameReady;
    frameReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        frameReady = null;
        reject(new Error("Team sign-in is unavailable. Try again or open Team Hub."));
      }, 15000);
      frame.onload = () => { frameLoaded = true; clearTimeout(timer); resolve(); };
      document.body.append(frame);
    });
    void frameReady.catch(() => {});
    return frameReady;
  }
  async function request(method: string, args: unknown[] = []) {
    // Closing the launch tab is not a sign-out. Reconnect to the same existing
    // broker used by direct visits; it alone decides whether a session exists.
    if (firstParty?.closed) firstParty = null;
    if (!firstParty) await connectFrame();
    return new Promise<any>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Team sign-in timed out. Reload or open Team Hub."));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      (firstParty || frame.contentWindow)!.postMessage({ protocol, id, method, args }, hub);
    });
  }
  const dataClient = createClient(url, key, {
    accessToken: async () => {
      const version = authVersion, actorId = session?.user.id;
      const r = await request("getSession");
      if (r.error) throw new Error(r.error.message);
      if (version !== authVersion) {
        if (!actorId || actorId !== session?.user.id)
          throw new Error("Your account changed. Retry from the current account.");
        return session?.access_token ?? null;
      }
      return r.data.session?.access_token ?? null;
    },
  });
  function emit(event: AuthChangeEvent, next: Session | null) {
    authVersion++;
    session = next;
    void dataClient.realtime.setAuth(next?.access_token ?? key);
    if (!next) void dataClient.removeAllChannels();
    for (const cb of listeners) cb(event, next);
    for (const [child, origin] of children) {
      if (child.closed) { children.delete(child); continue; }
      child.postMessage({ protocol, event, session: next }, origin);
    }
  }
  window.addEventListener("message", (e) => {
    // Only windows this Hub opened may use its broker. Pin each to the exact
    // allowlisted destination origin; a navigated/unrelated window is rejected.
    let childOrigin = children.get(e.source as Window);
    // A Hub reload clears the registry. Reconnect only an allowlisted window
    // whose browser-maintained opener is still this exact Hub window.
    if (!childOrigin && location.origin === hub && e.origin !== hub && suiteOrigins.includes(e.origin)) {
      try { if ((e.source as Window | null)?.opener === window) childOrigin = e.origin; } catch { /* unrelated window */ }
    }
    if (location.origin === hub && childOrigin && e.origin === childOrigin &&
        e.data?.protocol === protocol && typeof e.data.id === "string" &&
        e.data.id.length <= 100 && methods.has(e.data.method) && Array.isArray(e.data.args)) {
      const source = e.source as Window, { id, method, args } = e.data;
      children.set(source, childOrigin);
      void request(method, args).then(result => {
        // The existing Hub broker strips refresh/provider tokens from results.
        if (!source.closed) source.postMessage({ protocol, id, result }, childOrigin);
      }).catch(() => {
        if (!source.closed) source.postMessage({ protocol, id, result: {
          data: { session: null }, error: { message: "Team sign-in is unavailable. Open Team Hub." }
        } }, childOrigin);
      });
      return;
    }
    if (
      e.origin !== hub ||
      e.source !== (firstParty || frame.contentWindow) ||
      e.data?.protocol !== protocol
    )
      return;
    if (e.data.event) {
      emit(e.data.event, e.data.session);
      return;
    }
    const p = pending.get(e.data.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(e.data.id);
    p.resolve(e.data.result);
  });
  if (!firstParty) void connectFrame();
  if (location.origin === hub) {
    // One shared handler covers Quick access, the suite switcher and PO links.
    // Open synchronously during the user gesture so mobile popup rules permit it.
    document.addEventListener("click", e => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
      if (!link || link.hasAttribute("download")) return;
      const destination = new URL(link.href);
      if (destination.origin === hub || !suiteOrigins.includes(destination.origin) ||
          destination.username || destination.password) return;
      const child = window.open(destination.href, "_blank");
      if (!child) return; // Respect browser blocking; retain the native link.
      children.set(child, destination.origin);
      e.preventDefault();
    });
  }
  const bootstrap = (async () => {
    const query = new URLSearchParams(location.search),
      hash = new URLSearchParams(location.hash.slice(1));
    const code = query.get("code"),
      access = hash.get("access_token"),
      refresh = hash.get("refresh_token");
    let result;
    const version = authVersion;
    if (code || (access && refresh)) {
      // Consume existing Supabase callback values; never generate token URLs.
      query.delete("code");
      history.replaceState(
        null,
        "",
        location.pathname +
          (query.size ? "?" + query : "") +
          (access ? "" : location.hash),
      );
      result = await request(
        code ? "exchangeCodeForSession" : "setSession",
        code ? [code] : [{ access_token: access, refresh_token: refresh }],
      );
    } else result = await request("getSession");
    if (result.error) throw new Error(result.error.message);
    const recovery = query.has("password-reset") || hash.get("type") === "recovery";
    if (version === authVersion) emit(recovery ? "PASSWORD_RECOVERY" : "INITIAL_SESSION", result.data.session);
    else {
      const current = session as Session | null;
      if (recovery && current && current.user.id === result.data.session?.user.id)
        emit("PASSWORD_RECOVERY", current);
    }
    return result;
  })();
  void bootstrap.catch(() => { if (authVersion === 0) emit("INITIAL_SESSION", null); });
  // Reconcile on resume/reconnect for either transport. A hidden/suspended tab
  // can miss the broker's refresh notification. Network failures must not invent
  // a sign-out; expired-token access remains blocked by each app and the server.
  let checking = false;
  function reconcile(next: Session | null) {
    if (next?.access_token !== session?.access_token ||
        next?.user.id !== session?.user.id || next?.expires_at !== session?.expires_at)
      emit(next ? "TOKEN_REFRESHED" : "SIGNED_OUT", next);
  }
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      await bootstrap.catch(() => {});
      const version = authVersion;
      const result = await request("getSession");
      if (!result.error && version === authVersion) reconcile(result.data.session);
    } catch { /* retry on the next resume or check without changing identity */ }
    finally { checking = false; }
  };
  setInterval(() => { if (!document.hidden) void check(); }, 5000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void check(); });
  window.addEventListener("focus", () => void check());
  window.addEventListener("online", () => void check());
  const auth = {
    onAuthStateChange(
      cb: (event: AuthChangeEvent, session: Session | null) => void,
    ) {
      listeners.add(cb);
      void bootstrap
        .then(() => {
          if (listeners.has(cb)) cb("INITIAL_SESSION", session);
        })
        .catch(() => {
          if (listeners.has(cb)) cb("INITIAL_SESSION", session);
        });
      return {
        data: { subscription: { unsubscribe: () => listeners.delete(cb) } },
      };
    },
    async getSession() {
      try {
        await bootstrap.catch(() => {});
        const version = authVersion;
        const result = await request("getSession");
        if (!result.error && version === authVersion) reconcile(result.data.session);
        // A newer auth event wins over a response already in flight.
        return !result.error ? { ...result, data: { ...result.data, session } } : result;
      } catch (e) {
        return { data: { session: null }, error: e };
      }
    },
    async signInWithPassword(credentials: unknown) {
      return request("signInWithPassword", [credentials]);
    },
    async signOut() {
      return request("signOut");
    },
    async resetPasswordForEmail(email: string, options: unknown) {
      return request("resetPasswordForEmail", [email, options]);
    },
    async updateUser(attributes: unknown) {
      return request("updateUser", [attributes]);
    },
    async getUser() {
      return request("getUser");
    },
  };
  // Keep existing repositories/services intact. Only auth delegates to the broker;
  // database/storage/realtime continue using the normal Supabase client and RLS.
  return new Proxy(dataClient, {
    get(target, prop) {
      if (prop === "auth") return auth;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
