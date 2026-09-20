import { test, expect } from "@playwright/test";
test("Finance uses real Hub broker protocol: one login, cross-origin session and logout, no Finance persisted token", async ({
  context,
  page,
}) => {
  let logins = 0;
  const id = "00000000-0000-0000-0000-000000000001";
  const user = {
    id,
    email: "test@example.invalid",
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  };
  await context.routeWebSocket("**", (ws) => ws.close());
  await context.route("https://**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "finance-test.supabase.invalid") {
      let result: unknown = [];
      if (u.pathname === "/auth/v1/token") {
        logins++;
        const access_token =
          Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url") +
          "." +
          Buffer.from(
            JSON.stringify({
              sub: id,
              exp: Math.floor(Date.now() / 1000) + 3600,
              aud: "authenticated",
              role: "authenticated",
            }),
          ).toString("base64url") +
          ".fixture";
        result = {
          access_token,
          refresh_token: "fixture-refresh",
          expires_in: 3600,
          token_type: "bearer",
          user,
        };
      } else if (u.pathname.endsWith("/finance_context"))
        result = {
          profile: { id, display_name: "Suite Student", role: "student" },
          can_create: true,
          is_admin: false,
          capabilities: [],
          areas: [],
          people: [],
        };
      else if (u.pathname === "/auth/v1/logout") result = {};
      else if (u.pathname === "/auth/v1/user") result = user;
      return route.fulfill({ json: result });
    }
    if (["finance.frc4418.org", "team.frc4418.org"].includes(u.hostname)) {
      let path = u.pathname;
      if (u.hostname === "team.frc4418.org") {
        if (path === "/suite-auth.html") path = "/tests/fixtures/broker.html";
        else if (path === "/") path = "/tests/fixtures/hub.html";
      }
      const response = await route.fetch({
        url: "http://127.0.0.1:4430" + path + u.search,
      });
      return route.fulfill({ response });
    }
    return route.abort();
  });
  await page.goto("https://finance.frc4418.org/");
  await page.getByLabel("Email", { exact: true }).fill("test@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Shared session ready")).toBeVisible();
  await page.goto("https://finance.frc4418.org/");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(page.getByRole("banner").getByText("Suite Student", { exact: true })).toBeVisible();
  expect(logins).toBe(1);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  const hub = await context.newPage();
  await hub.goto("https://team.frc4418.org/");
  await expect(hub.getByText("Shared session ready")).toBeVisible();
  expect(logins).toBe(1);
  await hub.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(logins).toBe(1);
});

test("unresponsive production-origin broker cannot leave loading forever", async ({context,page}) => {
  await context.route("https://team.frc4418.org/suite-auth.html", r => r.fulfill({contentType:"text/html",body:"<!doctype html><title>Unresponsive broker</title>"}));
  await context.route("https://finance.frc4418.org/**", async r => {
    const u=new URL(r.request().url());
    const response=await r.fetch({url:"http://127.0.0.1:4430"+u.pathname});
    await r.fulfill({response});
  });
  await page.goto("https://finance.frc4418.org/");
  await expect(page.getByRole("alert")).toContainText("Unable to connect securely",{timeout:20000});
  await expect(page.locator(".suite-header")).toHaveCount(0);
  await expect(page.getByText("Loading Finance…")).toHaveCount(0);
});
