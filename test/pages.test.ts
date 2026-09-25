import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

// Port of tests/test_pages.py. Goes through the real assets router + Worker (SELF), so it also
// checks the wrangler.jsonc wiring: pages come from app/static, API paths hit the Worker first.
// (Cloudflare Access sits in front of both at the edge; it isn't simulated locally.)

const page = async (path: string) => {
  const r = await SELF.fetch(`https://minty.example.workers.dev${path}`);
  return { status: r.status, type: r.headers.get("content-type") ?? "", html: await r.text() };
};

describe("static pages", () => {
  it("serves the dashboard with its links and no hard-coded people", async () => {
    const { status, type, html } = await page("/");
    expect(status).toBe(200);
    expect(type).toMatch(/text\/html/);
    expect(html).toContain("<title>Minty</title>");
    expect(html).toContain('href="/connect">+ Add account');
    expect(html).toContain('href="/add-user">+ Add user');
    expect(html).not.toContain('data-owner="spouse"');            // person buttons come from /users
    expect(html).toContain('id="tagBtn"');                         // multi-tag filter
  });

  it.each(["/", "/connect", "/add-user"])("%s has the theme toggle and dark palette", async (path) => {
    const { status, html } = await page(path);
    expect(status).toBe(200);
    expect(html).toContain('id="themeToggle"');
    expect(html).toContain(':root[data-theme="dark"]');
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toMatch(/<script>[^<]*minty-theme[^<]*<\/script>\s*<style>/);   // no light flash
  });

  it("connect page sends the institution name and can reconnect login_required banks", async () => {
    const { html } = await page("/connect");
    expect(html).toContain('id="reconnect"');
    expect(html).toContain('"/link/token/update"');
    expect(html).toContain("institution_name: metadata?.institution?.name");
  });

  it("routes API paths to the Worker (Access check applies)", async () => {
    const r = await SELF.fetch("https://minty.example.workers.dev/transactions");
    expect(r.status).toBe(403);
    expect((await SELF.fetch("https://minty.example.workers.dev/healthz")).status).toBe(200);
  });
});
