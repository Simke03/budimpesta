import type { VercelRequest, VercelResponse } from "@vercel/node";
import { neon } from "@neondatabase/serverless";

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  return neon(url);
}

async function initDb() {
  const sql = getDb();
  await sql`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name VARCHAR(100) UNIQUE NOT NULL, created_at TIMESTAMP DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS votes (id SERIAL PRIMARY KEY, user_name VARCHAR(100) NOT NULL, activity_id VARCHAR(100) NOT NULL, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(user_name, activity_id))`;
  await sql`CREATE TABLE IF NOT EXISTS settings (key VARCHAR(100) PRIMARY KEY, value TEXT NOT NULL)`;
  await sql`INSERT INTO settings (key, value) VALUES ('voting_closed', 'false') ON CONFLICT (key) DO NOTHING`;
}

let dbInitialized = false;
async function ensureDb() {
  if (!dbInitialized) {
    await initDb();
    dbInitialized = true;
  }
}

function json(res: VercelResponse, data: any, status = 200) {
  return res.status(status).json(data);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { method } = req;
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    await ensureDb();
    const sql = getDb();

    // GET /api/status
    if (method === "GET" && path === "/api/status") {
      const rows = await sql`SELECT value FROM settings WHERE key = 'voting_closed'`;
      return json(res, { voting_closed: rows[0]?.value === "true" });
    }

    // GET /api/votes
    if (method === "GET" && path === "/api/votes") {
      const rows = await sql`SELECT user_name, activity_id FROM votes ORDER BY user_name`;
      return json(res, rows);
    }

    // GET /api/votes/:name
    if (method === "GET" && path.startsWith("/api/votes/")) {
      const name = decodeURIComponent(path.replace("/api/votes/", ""));
      const rows = await sql`SELECT activity_id FROM votes WHERE user_name = ${name}`;
      return json(res, rows.map((r: any) => r.activity_id));
    }

    // POST /api/vote
    if (method === "POST" && path === "/api/vote") {
      const statusRows = await sql`SELECT value FROM settings WHERE key = 'voting_closed'`;
      if (statusRows[0]?.value === "true") {
        return json(res, { error: "Glasanje je zatvoreno" }, 403);
      }
      const { user_name, activity_id, selected } = req.body;
      if (!user_name || typeof user_name !== "string" || !user_name.trim()) {
        return json(res, { error: "Ime je obavezno" }, 400);
      }
      if (!activity_id || typeof activity_id !== "string") {
        return json(res, { error: "Aktivnost je obavezna" }, 400);
      }
      const trimmedName = user_name.trim();
      await sql`INSERT INTO users (name) VALUES (${trimmedName}) ON CONFLICT (name) DO NOTHING`;
      if (selected) {
        await sql`INSERT INTO votes (user_name, activity_id) VALUES (${trimmedName}, ${activity_id}) ON CONFLICT (user_name, activity_id) DO NOTHING`;
      } else {
        await sql`DELETE FROM votes WHERE user_name = ${trimmedName} AND activity_id = ${activity_id}`;
      }
      return json(res, { ok: true });
    }

    // POST /api/selections
    if (method === "POST" && path === "/api/selections") {
      const statusRows = await sql`SELECT value FROM settings WHERE key = 'voting_closed'`;
      if (statusRows[0]?.value === "true") {
        return json(res, { error: "Glasanje je zatvoreno" }, 403);
      }
      const { name, activities } = req.body;
      if (!name || typeof name !== "string" || !name.trim()) {
        return json(res, { error: "Ime je obavezno" }, 400);
      }
      const trimmedName = name.trim();
      await sql`INSERT INTO users (name) VALUES (${trimmedName}) ON CONFLICT (name) DO NOTHING`;
      await sql`DELETE FROM votes WHERE user_name = ${trimmedName}`;
      if (Array.isArray(activities)) {
        for (const actId of activities) {
          await sql`INSERT INTO votes (user_name, activity_id) VALUES (${trimmedName}, ${actId}) ON CONFLICT (user_name, activity_id) DO NOTHING`;
        }
      }
      return json(res, { ok: true });
    }

    // GET /api/selections
    if (method === "GET" && path === "/api/selections") {
      const rows = await sql`SELECT user_name as name, activity_id as activity FROM votes ORDER BY user_name`;
      return json(res, rows);
    }

    // GET /api/selections/:name
    if (method === "GET" && path.startsWith("/api/selections/")) {
      const name = decodeURIComponent(path.replace("/api/selections/", ""));
      const rows = await sql`SELECT activity_id FROM votes WHERE user_name = ${name}`;
      return json(res, rows.map((r: any) => r.activity_id));
    }

    // POST /api/admin/close
    if (method === "POST" && path === "/api/admin/close") {
      const { password } = req.body;
      if (password !== "budimpesta2026") {
        return json(res, { error: "Pogrešna lozinka" }, 401);
      }
      await sql`UPDATE settings SET value = 'true' WHERE key = 'voting_closed'`;
      return json(res, { ok: true, message: "Glasanje je zatvoreno!" });
    }

    // POST /api/admin/open (reopen voting)
    if (method === "POST" && path === "/api/admin/open") {
      const { password } = req.body;
      if (password !== "budimpesta2026") {
        return json(res, { error: "Pogrešna lozinka" }, 401);
      }
      await sql`UPDATE settings SET value = 'false' WHERE key = 'voting_closed'`;
      return json(res, { ok: true, message: "Glasanje je ponovo otvoreno!" });
    }

    // POST /api/admin/reset
    if (method === "POST" && path === "/api/admin/reset") {
      const { password } = req.body;
      if (password !== "budimpesta2026") {
        return json(res, { error: "Pogrešna lozinka" }, 401);
      }
      await sql`DELETE FROM votes`;
      await sql`DELETE FROM users`;
      await sql`UPDATE settings SET value = 'false' WHERE key = 'voting_closed'`;
      await sql`DELETE FROM settings WHERE key = 'generated_plan'`;
      return json(res, { ok: true, message: "Sve resetovano!" });
    }

    // POST /api/admin/clear-plan
    if (method === "POST" && path === "/api/admin/clear-plan") {
      const { password } = req.body;
      if (password !== "budimpesta2026") {
        return json(res, { error: "Pogrešna lozinka" }, 401);
      }
      await sql`DELETE FROM settings WHERE key = 'generated_plan'`;
      return json(res, { ok: true, message: "Plan obrisan!" });
    }

    // GET /api/plan
    if (method === "GET" && path === "/api/plan") {
      const rows = await sql`SELECT value FROM settings WHERE key = 'generated_plan'`;
      if (!rows[0]?.value) {
        return json(res, { plan: null });
      }
      try {
        return json(res, { plan: JSON.parse(rows[0].value) });
      } catch {
        return json(res, { plan: null });
      }
    }

    // POST /api/admin/generate-plan
    if (method === "POST" && path === "/api/admin/generate-plan") {
      const { password } = req.body;
      if (password !== "budimpesta2026") {
        return json(res, { error: "Pogrešna lozinka" }, 401);
      }

      const statusRows = await sql`SELECT value FROM settings WHERE key = 'voting_closed'`;
      if (statusRows[0]?.value !== "true") {
        return json(res, { error: "Prvo zatvori glasanje!" }, 400);
      }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return json(res, { error: "ANTHROPIC_API_KEY nije podešen" }, 500);
      }

      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey });

      const systemPrompt = `Ti generišeš plan putovanja u Budimpešti za grupu od 13 osoba.
Smještaj: Mester utca 29 (M3 metro, Corvin-negyed stanica).

STRIKTNI RASPORED — ne mijenjaj redosljed ni vremena:

SUBOTA 28. jun — "Dolazak i prvi utisci"
- 11:30 Dolazak na smještaj, Mester utca 29
- 12:30 Szent István Bazilika + trg — šetnja, kafići, opuštena atmosfera
- 14:00 Ručak — Retro Lángos, Vécsey utca 3 (5 min pješice od Bazilika)
- 16:00 360 Bar — rooftop koktel bar, Andrássy út 39, panoramski pogled na grad
- 19:00 Večera — Menza restoran, Liszt Ferenc tér 2 (retro šik, odlična mađarska kuhinja)
- 20:30 Dunav night cruise — noćna vožnja Dunavom sa pogledom na osvijetljeni Parlament i tvrđavu
- 22:30 Noćni izlazak — IZBOR: Instant-Fogas (7 soba, svaka drugačija muzika) ILI Széchenyi noćna žurka u termama

NEDJELJA 29. jun — "Klasični Budimpešta"
- 09:00 Doručak — New York Café, Erzsébet krt. 9-11 (najljepši kafić na svijetu)
- 11:00 Fisherman's Bastion + Budimska tvrđava — Castle Hill, najbolji pogled na Dunav i Parlament. Sa Fisherman's Bastiona pruža se spektakularan pogled na Parlament s druge strane Dunava. Uveče mogu prošetati pored Parlamenta koji je osvijetljen i izgleda nevjerovatno noću.
- 14:00 Ručak — Velika tržnica (Nagy Vásárcsarnok), lángos na spratu, suveniri
- 16:00 Slobodno vrijeme / kafići
- 19:00 Večera — Gettó Gulyás, Wesselényi utca 18 (rezervacija obavezna!)
- 21:00 Szimpla Kert ruin bar, Kazinczy utca 14

PONEDJELJAK 30. jun — "City Park i opuštanje"
- 10:00 Heroes' Square (Hősök tere) — ikonični trg
- 11:00 Vajdahunyad Castle — bajkoviti zamak, 5 min pješice, besplatan ulaz
- 13:00 Ručak u okolini City Parka
- 14:30 Széchenyi termalne kupke — vanjski bazeni, M1 metro stanica Széchenyi fürdő
- 18:00 Opciono: Velika sinagoga (Dohány utca 2) — najveća sinagoga u Evropi sa muzejom, označi kao OPCIONO
- 20:00 Opciono: Tropicarium-Oceanarium — najveći akvarijum u centralnoj Evropi (M4 do Kelenföldi, pa bus 103, ~30 min), označi kao OPCIONO

Za svaku lokaciju dodaj:
- Tačno vrijeme
- Naziv i adresu
- Kratak opis (1 rečenica)
- Kako doći od prethodne lokacije (metro/tramvaj linija, broj stanica, pješice)
- Trajanje posjete

VAŽNO:
- Vrati ISKLJUČIVO validan JSON, bez teksta prije ili poslije
- Koristi crnogorski jezik
- Ne dodavaj nikakve lokacije koje nisu navedene u ovom promptu
- Ne mijenjaj redosljed ni vremena`;

      const userPrompt = `Generiši plan putovanja prema uputstvima. Vrati ISKLJUČIVO validan JSON u ovom formatu:
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
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        });

        const textBlock = response.content.find((b: any) => b.type === "text");
        if (!textBlock || textBlock.type !== "text") {
          return json(res, { error: "Nema odgovora od Claude" }, 500);
        }

        let jsonText = textBlock.text.trim();
        if (jsonText.startsWith("```")) {
          jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
        }

        const plan = JSON.parse(jsonText);
        await sql`INSERT INTO settings (key, value) VALUES ('generated_plan', ${JSON.stringify(plan)}) ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(plan)}`;

        return json(res, { ok: true, plan });
      } catch (err: any) {
        return json(res, { error: "Greška pri generisanju plana: " + (err.message || "Nepoznata greška") }, 500);
      }
    }

    // Fallback: serve static HTML for root
    if (method === "GET") {
      const { readFileSync } = await import("fs");
      const { join } = await import("path");
      try {
        const html = readFileSync(join(process.cwd(), "public", "index.html"), "utf-8");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(200).send(html);
      } catch {
        return res.status(404).send("Not found");
      }
    }

    return json(res, { error: "Not found" }, 404);
  } catch (err: any) {
    return json(res, { error: err.message || "Internal server error" }, 500);
  }
}
