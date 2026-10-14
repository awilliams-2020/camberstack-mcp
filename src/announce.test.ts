import { describe, expect, it } from "vitest";
import { openDb, now } from "./db.js";
import { Lifecycle } from "./lifecycle.js";
import { Announcements, render } from "./announce.js";

function setup(o: { address?: string; failFor?: string } = {}) {
  const db = openDb(":memory:");
  const sent: any[] = [];
  const mail = { apiKey: "re_test", from: "Adam at Camberstack <adam@camberstack.io>", replyTo: "adam@camberstack.io", postalAddress: o.address };
  const lifecycle = new Lifecycle({
    db, baseUrl: "https://camberstack.io", signingKey: Buffer.alloc(32, 7), mail, internalEmails: new Set(), upgradeLink: () => null,
    fetch: (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (o.failFor && body.to[0] === o.failFor) return new Response("down", { status: 500 });
      sent.push({ ...body, key: (init.headers as Record<string, string>)["Idempotency-Key"] });
      return new Response("{}", { status: 200 });
    }) as any,
  });
  const ann = new Announcements({ db, lifecycle, internalEmails: new Set(["me@example.com"]), canSend: true, postalAddress: o.address, sleep: async () => {} });
  const user = (id: string, email: string, plan = "free", optOut = 0) =>
    db.prepare("INSERT INTO users (id, google_sub, email, plan, created_at, email_opt_out) VALUES (?, ?, ?, ?, ?, ?)").run(id, `s-${id}`, email, plan, now(), optOut);
  return { db, ann, sent, user };
}

describe("announcements", () => {
  it("goes to the audience, never to unsubscribed or internal accounts, and only once", async () => {
    const { ann, sent, user } = setup({ address: "PO Box 1, Austin TX 78701" });
    user("a", "a@example.com"); user("b", "b@example.com", "pro"); user("c", "c@example.com", "free", 1); user("me", "me@example.com");
    const free = ann.create({ subject: "News", body: "Hi", audience: "free", by: "me@example.com" });
    expect(ann.recipients(ann.get(free)!).map((u) => u.email)).toEqual(["a@example.com"]);
    const all = ann.create({ subject: "GA4 is here", body: "Hi,\n\n**Google Analytics** is open: https://camberstack.io/docs", audience: "all", by: "me@example.com" });
    expect(ann.recipients(ann.get(all)!).map((u) => u.email)).toEqual(["a@example.com", "b@example.com"]);
    expect(ann.start(all)).toBe(true);
    expect(await ann.process()).toBe(2);
    expect(ann.get(all)!.status).toBe("sent");
    expect(sent.map((m) => m.to[0])).toEqual(["a@example.com", "b@example.com"]);
    expect(sent[0].text).toContain("Camberstack, PO Box 1, Austin TX 78701.");          // the postal address in the footer
    expect(sent[0].headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(sent[0].key).toBe(`a:announce:${all}`);
    expect(await ann.process()).toBe(0);                                               // never twice
    expect(ann.update(all, { subject: "x", body: "y", audience: "all" })).toBe(false);   // what was sent stays on record
    expect(ann.delete(all)).toBe(false);
  });

  it("won't send to users without a postal address, but a test still works", async () => {
    const { ann, sent, user } = setup();
    user("a", "a@example.com");
    const id = ann.create({ subject: "News", body: "Hi", audience: "all", by: "me@example.com" });
    expect(ann.blocker()).toContain("MAIL_POSTAL_ADDRESS");
    expect(ann.start(id)).toBe(false);
    await ann.sendTest(id, "me@example.com");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("[TEST] News");
    expect(ann.get(id)!.status).toBe("draft");
  });

  it("resumes after a failed send without resending to anyone", async () => {
    const s = setup({ address: "PO Box 1", failFor: "b@example.com" });
    s.user("a", "a@example.com"); s.user("b", "b@example.com"); s.user("c", "c@example.com");
    const id = s.ann.create({ subject: "News", body: "Hi", audience: "all", by: "me@example.com" });
    const err = console.error; console.error = () => {};
    try { s.ann.start(id); expect(await s.ann.process()).toBe(1); } finally { console.error = err; }
    expect(s.ann.get(id)!.status).toBe("sending");
    expect(s.ann.recipients(s.ann.get(id)!).map((u) => u.email)).toEqual(["b@example.com", "c@example.com"]);
  });

  it("renders paragraphs, bullets, bold and links, and escapes everything else", () => {
    const m = render({ subject: "S", body: "Hi <b>there</b>,\n\n- **one**\n- [two](https://x.test/a?b=1&c=2)\n\nSee https://camberstack.io/changelog." }, false);
    expect(m.html).toContain("Hi &lt;b&gt;there&lt;/b&gt;,");
    expect(m.html).toContain("<li><strong>one</strong></li>");
    expect(m.html).toContain('<a href="https://x.test/a?b=1&amp;c=2">two</a>');
    expect(m.html).toContain('<a href="https://camberstack.io/changelog">https://camberstack.io/changelog</a>.');
    expect(m.text).toContain("two (https://x.test/a?b=1&c=2)");
  });
});
