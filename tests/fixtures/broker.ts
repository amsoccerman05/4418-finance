// Exact Hub broker implementation snapshot; import path adjusted for local protocol tests.
import { createClient, type Session } from "@supabase/supabase-js";
import { suiteOrigins } from "../../src/suite-auth";
const protocol = "4418-suite-auth-v1";
const client = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      storageKey: "4418-team-hub-auth",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: "pkce",
    },
  },
);
let parentOrigin: string | null = null;
function publicSession(s: Session | null) {
  return s
    ? {
        ...s,
        refresh_token: "",
        provider_token: undefined,
        provider_refresh_token: undefined,
      }
    : null;
}
function clean(result: any) {
  if (result?.data?.session)
    result = {
      ...result,
      data: { ...result.data, session: publicSession(result.data.session) },
    };
  if (result?.error)
    result = {
      ...result,
      error: {
        message: result.error.message,
        status: result.error.status,
        code: result.error.code,
      },
    };
  return result;
}
client.auth.onAuthStateChange((event, session) => {
  if (parentOrigin)
    window.parent.postMessage(
      { protocol, event, session: publicSession(session) },
      parentOrigin,
    );
});
window.addEventListener("message", async (e) => {
  if (
    e.source !== window.parent ||
    window.parent === window ||
    !suiteOrigins.includes(e.origin) ||
    e.data?.protocol !== protocol ||
    typeof e.data.id !== "string"
  )
    return;
  if (parentOrigin && parentOrigin !== e.origin) return;
  parentOrigin = e.origin;
  const { id, method, args = [] } = e.data;
  let result;
  try {
    switch (method) {
      case "getSession":
        result = await client.auth.getSession();
        break;
      case "getUser":
        result = await client.auth.getUser();
        break;
      case "signInWithPassword":
        result = await client.auth.signInWithPassword({
          email: args[0].email,
          password: args[0].password,
        });
        break;
      case "signOut":
        result = await client.auth.signOut({ scope: "local" });
        break;
      case "resetPasswordForEmail": {
        const redirect = new URL(args[1]?.redirectTo);
        if (!suiteOrigins.includes(redirect.origin))
          throw new Error("Invalid password reset destination");
        result = await client.auth.resetPasswordForEmail(args[0], {
          redirectTo: redirect.href,
        });
        break;
      }
      case "updateUser":
        result = await client.auth.updateUser({ password: args[0].password });
        break;
      case "exchangeCodeForSession":
        result = await client.auth.exchangeCodeForSession(args[0]);
        break;
      case "setSession":
        result = await client.auth.setSession({
          access_token: args[0].access_token,
          refresh_token: args[0].refresh_token,
        });
        break;
      default:
        throw new Error("Unsupported authentication operation");
    }
  } catch (error) {
    result = {
      data: { session: null },
      error: {
        message:
          error instanceof Error ? error.message : "Authentication failed",
      },
    };
  }
  window.parent.postMessage({ protocol, id, result: clean(result) }, e.origin);
});
