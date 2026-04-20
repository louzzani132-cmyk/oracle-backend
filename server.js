const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const cron = require("node-cron");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ── BASE DE DONNÉES ──────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analyses (
      id SERIAL PRIMARY KEY,
      fixture_id INTEGER UNIQUE,
      match_name TEXT,
      league TEXT,
      country TEXT,
      match_date TEXT,
      home_team TEXT,
      away_team TEXT,
      home_prob INTEGER,
      draw_prob INTEGER,
      away_prob INTEGER,
      recommendation TEXT,
      recommendation_label TEXT,
      confidence INTEGER,
      reasoning TEXT,
      key_factors TEXT,
      risks TEXT,
      value_bet BOOLEAN,
      home_odd REAL,
      draw_odd REAL,
      away_odd REAL,
      actual_result TEXT,
      won BOOLEAN,
      final_home_goals INTEGER,
      final_away_goals INTEGER,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS matches_cache (
      id SERIAL PRIMARY KEY,
      fixture_id INTEGER UNIQUE,
      data JSONB,
      cached_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("✅ Base de données initialisée");
}

// ── API FOOTBALL ─────────────────────────────────────────────
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

async function apiFetch(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { "x-apisports-key": API_KEY },
  });
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0)
    throw new Error(Object.values(data.errors)[0]);
  return data.response;
}

// ── AGENT IA ─────────────────────────────────────────────────
async function analyzeWithAI(matchData, history = []) {
  const historyContext = history.length > 0
    ? `Mes ${history.length} analyses passées — Taux de réussite: ${Math.round(history.filter(h => h.won).length / history.length * 100)}%`
    : "Pas encore d'historique.";

  const prompt = `Tu es ORACLE, un analyste expert en paris sportifs. Analyse ce match et retourne UNIQUEMENT du JSON valide.

DONNÉES:
${JSON.stringify(matchData, null, 2)}

HISTORIQUE: ${historyContext}

Retourne ce JSON exact (sans markdown, sans texte avant ou après):
{
  "homeProb": <0-100>,
  "drawProb": <0-100>,
  "awayProb": <0-100>,
  "confidence": <0-100>,
  "recommendation": "home"|"draw"|"away",
  "recommendationLabel": "<équipe ou Nul>",
  "reasoning": "<analyse experte 3-4 phrases>",
  "keyFactors": ["<fact1>", "<fact2>", "<fact3>"],
  "risks": "<risque principal>",
  "valueBet": true|false
}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json();
  const text = data.content?.[0]?.text || "{}";
  return JSON.parse(text.replace(/```json\n?|\n?```/g, "").trim());
}

// ════════════════════════════════════════════════════════════
//  ROUTES API
// ════════════════════════════════════════════════════════════

// GET /matches — matchs du jour
app.get("/matches", async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const matches = await apiFetch(`/fixtures?date=${today}&timezone=Europe/Paris`);

    // Cache en DB
    for (const m of matches) {
      await pool.query(
        `INSERT INTO matches_cache (fixture_id, data) VALUES ($1, $2)
         ON CONFLICT (fixture_id) DO UPDATE SET data = $2, cached_at = NOW()`,
        [m.fixture.id, JSON.stringify(m)]
      );
    }

    res.json({ success: true, count: matches.length, matches });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /analyze/:fixtureId — analyser un match
app.post("/analyze/:fixtureId", async (req, res) => {
  const { fixtureId } = req.params;
  try {
    // Récupère les données du match
    const [fixtures, h2hRaw] = await Promise.allSettled([
      apiFetch(`/fixtures?id=${fixtureId}`),
      apiFetch(`/fixtures/statistics?fixture=${fixtureId}`),
    ]);

    const fixture = fixtures.value?.[0];
    if (!fixture) return res.status(404).json({ error: "Match non trouvé" });

    const homeId = fixture.teams.home.id;
    const awayId = fixture.teams.away.id;
    const leagueId = fixture.league.id;
    const season = new Date().getFullYear();

    // Données enrichies en parallèle
    const [h2h, statsHome, statsAway, odds] = await Promise.allSettled([
      apiFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`),
      apiFetch(`/teams/statistics?team=${homeId}&league=${leagueId}&season=${season}`),
      apiFetch(`/teams/statistics?team=${awayId}&league=${leagueId}&season=${season}`),
      apiFetch(`/odds?fixture=${fixtureId}&bookmaker=6`),
    ]).then(r => r.map(p => p.status === "fulfilled" ? p.value : null));

    // Historique pour contextualiser l'IA
    const { rows: history } = await pool.query(
      `SELECT * FROM analyses WHERE won IS NOT NULL ORDER BY created_at DESC LIMIT 20`
    );

    const matchData = {
      homeTeam: fixture.teams.home.name,
      awayTeam: fixture.teams.away.name,
      league: fixture.league.name,
      country: fixture.league.country,
      round: fixture.league.round,
      date: fixture.fixture.date,
      h2h: h2h?.slice(0, 5).map(m => ({
        date: m?.fixture?.date?.split("T")[0],
        home: m?.teams?.home?.name,
        away: m?.teams?.away?.name,
        score: `${m?.goals?.home ?? "?"}-${m?.goals?.away ?? "?"}`,
        winner: m?.teams?.home?.winner ? m?.teams?.home?.name : m?.teams?.away?.winner ? m?.teams?.away?.name : "Nul",
      })) || [],
      homeStats: statsHome ? {
        played: statsHome?.fixtures?.played?.total,
        wins: statsHome?.fixtures?.wins?.total,
        draws: statsHome?.fixtures?.draws?.total,
        losses: statsHome?.fixtures?.loses?.total,
        goalsFor: statsHome?.goals?.for?.total?.total,
        goalsAgainst: statsHome?.goals?.against?.total?.total,
        formLast5: statsHome?.form?.slice(-5),
        avgGoalsHome: statsHome?.goals?.for?.average?.home,
        cleanSheets: statsHome?.clean_sheet?.total,
      } : null,
      awayStats: statsAway ? {
        played: statsAway?.fixtures?.played?.total,
        wins: statsAway?.fixtures?.wins?.total,
        draws: statsAway?.fixtures?.draws?.total,
        losses: statsAway?.fixtures?.loses?.total,
        goalsFor: statsAway?.goals?.for?.total?.total,
        goalsAgainst: statsAway?.goals?.against?.total?.total,
        formLast5: statsAway?.form?.slice(-5),
        avgGoalsAway: statsAway?.goals?.for?.average?.away,
        cleanSheets: statsAway?.clean_sheet?.total,
      } : null,
      bookmakerOdds: odds?.[0]?.bookmakers?.[0]?.bets?.[0]?.values || [],
    };

    // Analyse IA
    const analysis = await analyzeWithAI(matchData, history);

    // Extraire les cotes
    const homeOdd = parseFloat(odds?.[0]?.bookmakers?.[0]?.bets?.[0]?.values?.find(v => v.value === "Home")?.odd || 0);
    const drawOdd = parseFloat(odds?.[0]?.bookmakers?.[0]?.bets?.[0]?.values?.find(v => v.value === "Draw")?.odd || 0);
    const awayOdd = parseFloat(odds?.[0]?.bookmakers?.[0]?.bets?.[0]?.values?.find(v => v.value === "Away")?.odd || 0);

    // Sauvegarde en DB
    await pool.query(
      `INSERT INTO analyses (
        fixture_id, match_name, league, country, match_date,
        home_team, away_team, home_prob, draw_prob, away_prob,
        recommendation, recommendation_label, confidence, reasoning,
        key_factors, risks, value_bet, home_odd, draw_odd, away_odd, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'analyzed')
      ON CONFLICT (fixture_id) DO UPDATE SET
        home_prob=$8, draw_prob=$9, away_prob=$10,
        recommendation=$11, recommendation_label=$12,
        confidence=$13, reasoning=$14, key_factors=$15,
        risks=$16, value_bet=$17, updated_at=NOW()`,
      [
        fixtureId,
        `${fixture.teams.home.name} vs ${fixture.teams.away.name}`,
        fixture.league.name, fixture.league.country,
        fixture.fixture.date?.split("T")[0],
        fixture.teams.home.name, fixture.teams.away.name,
        analysis.homeProb, analysis.drawProb, analysis.awayProb,
        analysis.recommendation, analysis.recommendationLabel,
        analysis.confidence, analysis.reasoning,
        JSON.stringify(analysis.keyFactors || []),
        analysis.risks, analysis.valueBet,
        homeOdd, drawOdd, awayOdd,
      ]
    );

    res.json({ success: true, fixtureId, analysis, odds: { home: homeOdd, draw: drawOdd, away: awayOdd } });
  } catch (e) {
    console.error("Erreur analyse:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /history — historique complet
app.get("/history", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM analyses ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ success: true, count: rows.length, history: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /stats — statistiques globales
app.get("/stats", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN won = true THEN 1 END) as wins,
        COUNT(CASE WHEN won = false THEN 1 END) as losses,
        AVG(confidence) as avg_confidence,
        COUNT(CASE WHEN value_bet = true AND won = true THEN 1 END) as value_bet_wins,
        COUNT(CASE WHEN value_bet = true THEN 1 END) as total_value_bets
      FROM analyses WHERE won IS NOT NULL
    `);
    const s = rows[0];
    const winRate = s.total > 0 ? Math.round((s.wins / s.total) * 100) : 0;
    res.json({ success: true, stats: { ...s, winRate } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /agent — chat avec l'agent
app.post("/agent", async (req, res) => {
  const { messages } = req.body;
  try {
    const { rows: analyses } = await pool.query(
      `SELECT * FROM analyses ORDER BY created_at DESC LIMIT 10`
    );
    const { rows: stats } = await pool.query(`
      SELECT COUNT(*) as total,
        COUNT(CASE WHEN won=true THEN 1 END) as wins
      FROM analyses WHERE won IS NOT NULL
    `);

    const winRate = stats[0].total > 0
      ? Math.round((stats[0].wins / stats[0].total) * 100) : 0;

    const context = analyses.map(a =>
      `• ${a.match_name} (${a.league}): prono=${a.recommendation_label}, conf=${a.confidence}%, ${a.won === true ? "GAGNÉ ✓" : a.won === false ? "PERDU ✗" : "en attente"}\n  Raisonnement: ${a.reasoning}`
    ).join("\n\n");

    const system = `Tu es ORACLE, agent expert en paris sportifs.

ANALYSES RÉCENTES:
${context || "Aucune analyse disponible."}

PERFORMANCES GLOBALES: ${stats[0].total} analyses, ${winRate}% de réussite

Réponds en français, de façon experte et directe. Base-toi sur les vraies données pour répondre.`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system,
        messages,
      }),
    });

    const data = await aiRes.json();
    res.json({ success: true, reply: data.content?.[0]?.text || "Erreur." });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
//  BOT AUTOMATIQUE — CRON JOBS
// ════════════════════════════════════════════════════════════

// Toutes les heures : enregistre les résultats des matchs terminés
cron.schedule("0 * * * *", async () => {
  console.log("🤖 Bot: vérification des résultats terminés...");
  try {
    const { rows: pending } = await pool.query(
      `SELECT fixture_id FROM analyses WHERE won IS NULL AND status = 'analyzed'`
    );

    for (const row of pending) {
      try {
        const fixtures = await apiFetch(`/fixtures?id=${row.fixture_id}`);
        const fixture = fixtures?.[0];
        if (!fixture) continue;

        const status = fixture.fixture.status?.short;
        if (status !== "FT" && status !== "AET" && status !== "PEN") continue;

        const homeGoals = fixture.goals.home;
        const awayGoals = fixture.goals.away;
        const actual = homeGoals > awayGoals ? "home" : homeGoals < awayGoals ? "away" : "draw";

        const { rows: [analysis] } = await pool.query(
          `SELECT recommendation FROM analyses WHERE fixture_id = $1`, [row.fixture_id]
        );

        const won = analysis?.recommendation === actual;

        await pool.query(
          `UPDATE analyses SET
            actual_result = $1, won = $2,
            final_home_goals = $3, final_away_goals = $4,
            status = 'completed', updated_at = NOW()
          WHERE fixture_id = $5`,
          [actual, won, homeGoals, awayGoals, row.fixture_id]
        );

        console.log(`✅ Résultat enregistré: ${row.fixture_id} — ${won ? "GAGNÉ" : "PERDU"}`);
      } catch (err) {
        console.error(`Erreur fixture ${row.fixture_id}:`, err.message);
      }
    }
  } catch (e) {
    console.error("Erreur cron résultats:", e.message);
  }
});

// Chaque jour à 10h : analyse automatique des matchs du jour
cron.schedule("0 10 * * *", async () => {
  console.log("🤖 Bot: analyse automatique des matchs du jour...");
  try {
    const today = new Date().toISOString().split("T")[0];
    const matches = await apiFetch(`/fixtures?date=${today}&timezone=Europe/Paris`);
    console.log(`📅 ${matches.length} matchs trouvés pour aujourd'hui`);

    // Analyse les 10 premiers matchs automatiquement
    for (const m of matches.slice(0, 10)) {
      try {
        await fetch(`http://localhost:${PORT}/analyze/${m.fixture.id}`, { method: "POST" });
        await new Promise(r => setTimeout(r, 2000)); // attente entre chaque
      } catch (err) {
        console.error(`Erreur analyse auto ${m.fixture.id}:`, err.message);
      }
    }
  } catch (e) {
    console.error("Erreur cron analyse:", e.message);
  }
});

// ── DÉMARRAGE ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`🚀 ORACLE Backend démarré sur le port ${PORT}`);
});
