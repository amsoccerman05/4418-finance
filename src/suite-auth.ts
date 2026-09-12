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
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error("Team sign-in is unavailable. Reload or open Team Hub."),
        ),
      15000,
    );
    frame.onload = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  // A failed bootstrap is surfaced through the normal getSession/login paths.
  void ready.catch(() => {});
  async function request(method: string, args: unknown[] = []) {
    await ready;
    return new Promise<any>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Team sign-in timed out. Reload or open Team Hub."));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      frame.contentWindow!.postMessage({ protocol, id, method, args }, hub);
    });
  }
  const dataClient = createClient(url, key, {
    accessToken: async () => {
      const r = await request("getSession");
      if (r.error) throw new Error(r.error.message);
      return r.data.session?.access_token ?? null;
    },
  });
  function emit(event: AuthChangeEvent, next: Session | null) {
    session = next;
    void dataClient.realtime.setAuth(next?.access_token ?? key);
    if (!next) void dataClient.removeAllChannels();
    for (const cb of listeners) cb(event, next);
  }
  window.addEventListener("message", (e) => {
    if (
      e.origin !== hub ||
      e.source !== frame.contentWindow ||
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
  document.body.append(frame);
  const bootstrap = (async () => {
    const query = new URLSearchParams(location.search),
      hash = new URLSearchParams(location.hash.slice(1));
    const code = query.get("code"),
      access = hash.get("access_token"),
      refresh = hash.get("refresh_token");
    let result;
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
    emit(
      query.has("password-reset") || hash.get("type") === "recovery"
        ? "PASSWORD_RECOVERY"
        : "INITIAL_SESSION",
      result.data.session,
    );
    return result;
  })();
  void bootstrap.catch(() => emit("INITIAL_SESSION", null));
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
          if (listeners.has(cb)) cb("INITIAL_SESSION", null);
        });
      return {
        data: { subscription: { unsubscribe: () => listeners.delete(cb) } },
      };
    },
    async getSession() {
      try {
        await bootstrap;
        return await request("getSession");
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
