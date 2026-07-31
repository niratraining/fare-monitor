/**
 * Fare Monitor API — Cloudflare Worker + D1
 * ===========================================================
 * جایگزین fares.db محلی: تمام اسنپ‌شات‌های قیمت اینجا نگه داشته می‌شن،
 * و منطق «الان نوبت رصد این پرواز رسیده یا نه» هم همین‌جاست، نه تو پایتون.
 *
 * Routes:
 *   POST /due            -> کدوم (route, flight_date) ها الان باید رصد بشن
 *   POST /ingest          -> ثبت یک اسنپ‌شات (چند پرواز از یک route+date)
 *   GET  /export/data     -> آخرین وضعیت هر پرواز (معادل قبلی data.json)
 *   GET  /export/history  -> تاریخچه‌ی کامل قیمت هر پرواز (معادل history.json)
 *
 * همه‌ی endpoint ها با هدر زیر محافظت می‌شن:
 *   Authorization: Bearer <INGEST_SECRET>
 * (INGEST_SECRET رو باید به‌عنوان Secret تو تنظیمات Worker ست کنی)
 *
 * D1 binding لازم: نام متغیر باید DB باشه (env.DB)
 * ===========================================================
 */

// ---- سطح‌بندی فاصله‌ی رصد بر اساس DTD (روزهای مونده به پرواز) ----
// اینجا رو هر وقت خواستی تغییر بدی، فقط همین چند خط رو عوض کن.
function tierIntervalHours(dtdDays) {
  if (dtdDays <= 2) return 2;   // نزدیک: هر ۲ ساعت
  if (dtdDays <= 7) return 6;   // متوسط: هر ۶ ساعت
  return 12;                     // دور: هر ۱۲ ساعت
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function priceNum(s) {
  if (!s) return null;
  const digits = String(s).replace(/[^0-9]/g, "");
  return digits ? parseInt(digits, 10) : null;
}

// ===========================================================
// POST /due — لیست کاندیدها رو می‌گیره، فقط اونایی که الان نوبتشونه برمی‌گردونه
// body: { candidates: [{ route, flight_date }, ...] }
// ===========================================================
async function handleDue(request, env) {
  const { candidates } = await request.json();
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return json({ due: [] });
  }

  const now = new Date();
  const due = [];

  for (const c of candidates) {
    const flightDate = new Date(c.flight_date + "T00:00:00Z");
    const dtdDays = Math.floor((flightDate - now) / 86400000);
    if (dtdDays < 0) continue; // پرواز گذشته

    const interval = tierIntervalHours(dtdDays);
    const row = await env.DB.prepare(
      "SELECT last_checked_at FROM check_state WHERE route = ? AND flight_date = ?"
    )
      .bind(c.route, c.flight_date)
      .first();

    let isDue = true;
    if (row && row.last_checked_at) {
      const hoursSince = (now - new Date(row.last_checked_at)) / 3600000;
      isDue = hoursSince >= interval;
    }
    if (isDue) due.push(c);
  }

  return json({ due });
}

// ===========================================================
// POST /ingest — ثبت یک اسنپ‌شات (همه‌ی پروازهای یک route+date با هم)
// body: { route, flight_date, captured_at, flights: [...] }
// ===========================================================
async function handleIngest(request, env) {
  const body = await request.json();
  const { route, flight_date, captured_at, flights } = body;

  if (!route || !flight_date || !captured_at || !Array.isArray(flights)) {
    return json({ error: "بدنه‌ی درخواست ناقصه" }, 400);
  }

  const stmts = flights.map((f) =>
    env.DB.prepare(
      `INSERT INTO fare_snapshots
       (route, flight_date, airline, flight_no, dep_time, arr_time, airplane, cabin,
        adult_price, child_price, infant_price, seller, seat_count, captured_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      route,
      flight_date,
      f.airline || "",
      f.flight_no || "",
      f.dep_time || "",
      f.arr_time || "",
      f.airplane || "",
      f.cabin || "",
      f.adult_price || "",
      f.child_price || "",
      f.infant_price || "",
      f.seller || "",
      f.seat_count || "",
      captured_at
    )
  );

  stmts.push(
    env.DB.prepare(
      `INSERT INTO check_state (route, flight_date, last_checked_at)
       VALUES (?, ?, ?)
       ON CONFLICT(route, flight_date) DO UPDATE SET last_checked_at = excluded.last_checked_at`
    ).bind(route, flight_date, captured_at)
  );

  if (stmts.length > 0) {
    await env.DB.batch(stmts);
  }

  return json({ ok: true, inserted: flights.length });
}

// ===========================================================
// GET /export/data — آخرین اسنپ‌شات هر (route, flight_date)
// ===========================================================
async function handleExportData(env) {
  const { results } = await env.DB.prepare(
    `SELECT f.*
     FROM fare_snapshots f
     INNER JOIN (
       SELECT route, flight_date, MAX(captured_at) AS max_captured
       FROM fare_snapshots
       GROUP BY route, flight_date
     ) latest
     ON f.route = latest.route
        AND f.flight_date = latest.flight_date
        AND f.captured_at = latest.max_captured
     ORDER BY f.route, f.flight_date, f.dep_time`
  ).all();

  return json({
    generated_at: new Date().toISOString().slice(0, 16),
    flights: results,
  });
}

// ===========================================================
// GET /export/history — تاریخچه‌ی کامل قیمت هر پرواز
// (ارزان‌ترین قیمت بین فروشنده‌ها در هر لحظه‌ی رصد)
// ===========================================================
async function handleExportHistory(env) {
  const { results } = await env.DB.prepare(
    `SELECT route, flight_date, flight_no, airline, captured_at, adult_price
     FROM fare_snapshots`
  ).all();

  const grouped = new Map();
  for (const r of results) {
    const price = priceNum(r.adult_price);
    if (price === null) continue;
    const key = [r.route, r.flight_date, r.flight_no, r.airline, r.captured_at].join("|");
    const existing = grouped.get(key);
    if (!existing || price < existing.price) {
      grouped.set(key, {
        route: r.route,
        flight_date: r.flight_date,
        flight_no: r.flight_no,
        airline: r.airline,
        captured_at: r.captured_at,
        price,
      });
    }
  }

  const history = [...grouped.values()].sort((a, b) =>
    (a.route + a.flight_date + a.flight_no + a.captured_at).localeCompare(
      b.route + b.flight_date + b.flight_no + b.captured_at
    )
  );

  return json({
    generated_at: new Date().toISOString().slice(0, 16),
    history,
  });
}

// ===========================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const auth = request.headers.get("Authorization") || "";
    if (auth !== `Bearer ${env.INGEST_SECRET}`) {
      return json({ error: "unauthorized" }, 401);
    }

    if (url.pathname === "/due" && request.method === "POST") {
      return handleDue(request, env);
    }
    if (url.pathname === "/ingest" && request.method === "POST") {
      return handleIngest(request, env);
    }
    if (url.pathname === "/export/data" && request.method === "GET") {
      return handleExportData(env);
    }
    if (url.pathname === "/export/history" && request.method === "GET") {
      return handleExportHistory(env);
    }
    return json({ error: "not found" }, 404);
  },
};
