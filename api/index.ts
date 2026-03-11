import { Hono } from "hono";
import { handle } from "hono/vercel";
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";
import { join } from "path";

const app = new Hono().basePath("/");

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  return neon(url);
}

async function initDb() {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      user_name VARCHAR(100) NOT NULL,
      activity_id VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_name, activity_id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;
  await sql`
    INSERT INTO settings (key, value) VALUES ('voting_closed', 'false')
    ON CONFLICT (key) DO NOTHING
  `;
}

let dbInitialized = false;

async function ensureDb() {
  if (!dbInitialized) {
    await initDb();
    dbInitialized = true;
  }
}

// Serve static HTML
app.get("/", async (c) => {
  try {
    const html = readFileSync(join(process.cwd(), "public", "index.html"), "utf-8");
    return c.html(html);
  } catch {
    return c.text("Not found", 404);
  }
});

// GET /api/status
app.get("/api/status", async (c) => {
  await ensureDb();
  const sql = getDb();
  const rows = await sql`SELECT value FROM settings WHERE key = 'voting_closed'`;
  const closed = rows[0]?.value === "true";
  return c.json({ voting_closed: closed });
});

// GET /api/votes
app.get("/api/votes", async (c) => {
  await ensureDb();
  const sql = getDb();
  const rows = await sql`SELECT user_name, activity_id FROM votes ORDER BY user_name`;
  return c.json(rows);
});

// GET /api/votes/:name
app.get("/api/votes/:name", async (c) => {
  await ensureDb();
  const sql = getDb();
  const name = decodeURIComponent(c.req.param("name"));
  const rows = await sql`SELECT activity_id FROM votes WHERE user_name = ${name}`;
  return c.json(rows.map((r: any) => r.activity_id));
});

// POST /api/vote
app.post("/api/vote", async (c) => {
  await ensureDb();
  const sql = getDb();

  // Check if voting is closed
  const statusRows = await sql`SELECT value FROM settings WHERE key = 'voting_closed'`;
  if (statusRows[0]?.value === "true") {
    return c.json({ error: "Glasanje je zatvoreno" }, 403);
  }

  const { user_name, activity_id, selected } = await c.req.json();

  if (!user_name || typeof user_name !== "string" || !user_name.trim()) {
    return c.json({ error: "Ime je obavezno" }, 400);
  }
  if (!activity_id || typeof activity_id !== "string") {
    return c.json({ error: "Aktivnost je obavezna" }, 400);
  }

  const trimmedName = user_name.trim();

  // Ensure user exists
  await sql`INSERT INTO users (name) VALUES (${trimmedName}) ON CONFLICT (name) DO NOTHING`;

  if (selected) {
    await sql`
      INSERT INTO votes (user_name, activity_id) VALUES (${trimmedName}, ${activity_id})
      ON CONFLICT (user_name, activity_id) DO NOTHING
    `;
  } else {
    await sql`DELETE FROM votes WHERE user_name = ${trimmedName} AND activity_id = ${activity_id}`;
  }

  return c.json({ ok: true });
});

// Legacy endpoint compatibility: POST /api/selections
app.post("/api/selections", async (c) => {
  await ensureDb();
  const sql = getDb();

  const statusRows = await sql`SELECT value FROM settings WHERE key = 'voting_closed'`;
  if (statusRows[0]?.value === "true") {
    return c.json({ error: "Glasanje je zatvoreno" }, 403);
  }

  const { name, activities } = await c.req.json();
  if (!name || typeof name !== "string" || !name.trim()) {
    return c.json({ error: "Ime je obavezno" }, 400);
  }

  const trimmedName = name.trim();
  await sql`INSERT INTO users (name) VALUES (${trimmedName}) ON CONFLICT (name) DO NOTHING`;
  await sql`DELETE FROM votes WHERE user_name = ${trimmedName}`;

  if (Array.isArray(activities)) {
    for (const actId of activities) {
      await sql`
        INSERT INTO votes (user_name, activity_id) VALUES (${trimmedName}, ${actId})
        ON CONFLICT (user_name, activity_id) DO NOTHING
      `;
    }
  }

  return c.json({ ok: true });
});

// Legacy: GET /api/selections
app.get("/api/selections", async (c) => {
  await ensureDb();
  const sql = getDb();
  const rows = await sql`SELECT user_name as name, activity_id as activity FROM votes ORDER BY user_name`;
  return c.json(rows);
});

// Legacy: GET /api/selections/:name
app.get("/api/selections/:name", async (c) => {
  await ensureDb();
  const sql = getDb();
  const name = decodeURIComponent(c.req.param("name"));
  const rows = await sql`SELECT activity_id FROM votes WHERE user_name = ${name}`;
  return c.json(rows.map((r: any) => r.activity_id));
});

// POST /api/admin/close
app.post("/api/admin/close", async (c) => {
  await ensureDb();
  const sql = getDb();
  const { password } = await c.req.json();

  if (password !== "budimpesta2026") {
    return c.json({ error: "Pogrešna lozinka" }, 401);
  }

  await sql`UPDATE settings SET value = 'true' WHERE key = 'voting_closed'`;
  return c.json({ ok: true, message: "Glasanje je zatvoreno!" });
});

// GET /api/plan
app.get("/api/plan", async (c) => {
  await ensureDb();
  const sql = getDb();
  const rows = await sql`SELECT value FROM settings WHERE key = 'generated_plan'`;
  if (!rows[0]?.value) {
    return c.json({ plan: null });
  }
  try {
    return c.json({ plan: JSON.parse(rows[0].value) });
  } catch {
    return c.json({ plan: null });
  }
});

// POST /api/admin/generate-plan
app.post("/api/admin/generate-plan", async (c) => {
  await ensureDb();
  const sql = getDb();

  const { password } = await c.req.json();
  if (password !== "budimpesta2026") {
    return c.json({ error: "Pogrešna lozinka" }, 401);
  }

  // Check voting is closed
  const statusRows = await sql`SELECT value FROM settings WHERE key = 'voting_closed'`;
  if (statusRows[0]?.value !== "true") {
    return c.json({ error: "Prvo zatvori glasanje!" }, 400);
  }

  // Get vote counts
  const voteCounts = await sql`
    SELECT activity_id, COUNT(*) as count
    FROM votes
    GROUP BY activity_id
    ORDER BY count DESC
  `;

  const activityList = voteCounts
    .map((r: any) => `- ${r.activity_id}: ${r.count} glasova`)
    .join("\n");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json({ error: "ANTHROPIC_API_KEY nije podešen" }, 500);
  }

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const userPrompt = `Napravi plan putovanja za grupu od 13 osoba u Budimpešti.

Smještaj: Mester utca 29, Budapest (IX kvart, Corvin-negyed metro stanica M3)

Trajanje:
- Subota dolazak ~11:30
- Utorak rano ujutro odlazak

Aktivnosti sortirane po glasovima (od najviše ka najmanje):
${activityList}

Pravila za raspored:
- Kulturne atrakcije ujutro i poslijepodne
- Kupke uvijek poslijepodne (14:00-18:00)
- Izlasci i klubovi od 22:00
- Geografski grupiši aktivnosti (City Park blok zajedno, Jevrejski kvart zajedno, Castle Hill zajedno)
- Subota rezervisana za: Bazilika, Retro Lángos, 360 Bar, noćni izlazak
- Nedjelja: New York Café doručak, Fisherman's Bastion, Velika tržnica, Gettó Gulyás, Szimpla
- Ponedjeljak: City Park (Heroes Square + Vajdahunyad + Széchenyi), opciono Tropicarium
- Aktivnosti sa malo glasova staviti kao opcione ili izostaviti
- Svaka lokacija treba imati: naziv, adresu, kako doći od smještaja ili prethodne lokacije (metro/tramvaj linija i broj stanica), procijenjeno trajanje

Vrati ISKLJUČIVO validan JSON u ovom formatu, bez ikakvog teksta prije ili poslije:
{
  "days": [
    {
      "day": "Subota",
      "date": "28. jun",
      "theme": "Dolazak i prvi utisci",
      "locations": [
        {
          "time": "12:30",
          "name": "Naziv lokacije",
          "address": "Adresa",
          "description": "Kratki opis",
          "transport": "Kako doći od prethodne lokacije",
          "duration": "1-2 sata",
          "optional": false
        }
      ]
    }
  ]
}`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: "Ti si asistent za planiranje putovanja. Generiši detaljan plan putovanja na crnogorskom jeziku u JSON formatu.",
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = response.content.find((b: any) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return c.json({ error: "Nema odgovora od Claude" }, 500);
    }

    let jsonText = textBlock.text.trim();
    // Strip markdown code fences if present
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const plan = JSON.parse(jsonText);
    await sql`
      INSERT INTO settings (key, value) VALUES ('generated_plan', ${JSON.stringify(plan)})
      ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(plan)}
    `;

    return c.json({ ok: true, plan });
  } catch (err: any) {
    return c.json({ error: "Greška pri generisanju plana: " + (err.message || "Nepoznata greška") }, 500);
  }
});

export default handle(app);
