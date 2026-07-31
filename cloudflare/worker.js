/**
 * Fare Monitor API — Cloudflare Worker + D1
 * ===========================================================
 * جایگزین fares.db محلی: تمام اسنپ‌شات‌های قیمت اینجا نگه داشته می‌شن،
 * و منطق «الان نوبت رصد این پرواز رسیده یا نه» هم همین‌جاست، نه تو پایتون.
 *
 * Routes:
 *   POST /due            -> کدوم (route, flight_date) ها الان باید رصد بشن
 *   POST /ingest          -> ثبت یک اسنپ‌شات (چند پرواز از یک route+date)
 *   GET  /export/data          -> آخرین وضعیت هر پرواز (معادل قبلی data.json)
 *   GET  /export/history       -> تاریخچه‌ی کامل قیمت هر پرواز (معادل history.json)
 *   GET  /export/route-trend   -> میانگین قیمت کل مسیر+تاریخ در هر لحظه‌ی رصد (لایه‌ی ۳)
 *   GET  /export/airline-trend -> میانگین قیمت هر ایرلاین در هر لحظه‌ی رصد، برای رسم میانگین متحرک (لایه‌ی ۴)
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

// روزهای مونده به پرواز، نسبت به لحظه‌ی رصد (dtd = days to departure)
// این فیلد پایه‌ی هر مدل پیش‌بینی آینده‌ست: "هرچی به پرواز نزدیک‌تر، قیمت چطور تغییر می‌کنه؟"
function dtdDays(flightDate, capturedAt) {
  const fd = new Date(flightDate + "T00:00:00Z");
  const ca = new Date(capturedAt);
  if (isNaN(fd) || isNaN(ca)) return null;
  return Math.floor((fd - ca) / 86400000);
}

// از چند ردیف هم‌کلید (مثلاً چند فروشنده‌ی یک پرواز)، فقط ارزون‌ترین رو نگه می‌داره
function cheapestPerKey(rows, keyFn) {
  const grouped = new Map();
  for (const r of rows) {
    const price = priceNum(r.adult_price);
    if (price === null) continue;
    const key = keyFn(r);
    const existing = grouped.get(key);
    if (!existing || price < existing.price) {
      grouped.set(key, { ...r, price });
    }
  }
  return [...grouped.values()];
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
// GET /export/history — تاریخچه‌ی کامل قیمت هر پرواز، جدا برای هر کلاس پرواز
// (ارزان‌ترین قیمت بین فروشنده‌های همون کلاس، در هر لحظه‌ی رصد)
// ===========================================================
async function handleExportHistory(env) {
  const { results } = await env.DB.prepare(
    `SELECT route, flight_date, flight_no, airline, cabin, captured_at, adult_price
     FROM fare_snapshots`
  ).all();

  // cabin تو کلید هست چون یه پرواز می‌تونه هم‌زمان اکونومی و بیزنس/فرست داشته باشه؛
  // بدون این، قیمت ارزون‌تر (معمولاً اکونومی) قیمت کلاس‌های دیگه رو تو تاریخچه پاک می‌کرد.
  const deduped = cheapestPerKey(
    results,
    (r) => [r.route, r.flight_date, r.flight_no, r.airline, r.cabin, r.captured_at].join("|")
  );

  const history = deduped
    .map((r) => ({
      route: r.route,
      flight_date: r.flight_date,
      flight_no: r.flight_no,
      airline: r.airline,
      cabin: r.cabin,
      captured_at: r.captured_at,
      price: r.price,
      dtd_days: dtdDays(r.flight_date, r.captured_at),
    }))
    .sort((a, b) =>
    (a.route + a.flight_date + a.flight_no + a.cabin + a.captured_at).localeCompare(
      b.route + b.flight_date + b.flight_no + b.cabin + b.captured_at
    )
  );

  return json({
    generated_at: new Date().toISOString().slice(0, 16),
    history,
  });
}

// ===========================================================
// GET /export/route-trend — لایه‌ی ۳: روند کل مسیر+تاریخ (نه یک پرواز خاص)
// در هر لحظه‌ی رصد، میانگین ارزون‌ترین قیمت همه‌ی پروازهای موجود اون
// route+flight_date+cabin رو حساب می‌کنه -> یه "شاخص قیمت مسیر"
// ===========================================================
async function handleExportRouteTrend(env) {
  const { results } = await env.DB.prepare(
    `SELECT route, flight_date, flight_no, cabin, captured_at, adult_price
     FROM fare_snapshots`
  ).all();

  // قدم ۱: ارزون‌ترین قیمت هر پرواز در هر لحظه‌ی رصد (بین فروشنده‌های مختلف)
  const perFlight = cheapestPerKey(
    results,
    (r) => [r.route, r.flight_date, r.flight_no, r.cabin, r.captured_at].join("|")
  );

  // قدم ۲: میانگین‌گیری روی همه‌ی پروازهای یک route+flight_date+cabin، در همون لحظه‌ی رصد
  const groups = new Map();
  for (const r of perFlight) {
    const key = [r.route, r.flight_date, r.cabin, r.captured_at].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        route: r.route,
        flight_date: r.flight_date,
        cabin: r.cabin,
        captured_at: r.captured_at,
        prices: [],
      });
    }
    groups.get(key).prices.push(r.price);
  }

  const trend = [...groups.values()]
    .map((g) => ({
      route: g.route,
      flight_date: g.flight_date,
      cabin: g.cabin,
      captured_at: g.captured_at,
      avg_price: Math.round(g.prices.reduce((a, b) => a + b, 0) / g.prices.length),
      min_price: Math.min(...g.prices),
      flight_count: g.prices.length,
      dtd_days: dtdDays(g.flight_date, g.captured_at),
    }))
    .sort((a, b) =>
      (a.route + a.flight_date + a.cabin + a.captured_at).localeCompare(
        b.route + b.flight_date + b.cabin + b.captured_at
      )
    );

  return json({
    generated_at: new Date().toISOString().slice(0, 16),
    route_trend: trend,
  });
}

// ===========================================================
// GET /export/airline-trend — لایه‌ی ۴: روند یک ایرلاین (نه یک پرواز خاص)
// در هر لحظه‌ی رصد، میانگین ارزون‌ترین قیمتِ همه‌ی پروازهای همون ایرلاین
// روی یک مسیر (در همه‌ی تاریخ‌های زیر رصد) حساب می‌شه. میانگین متحرک
// (rolling average) رو عمداً این‌جا نمی‌سازیم — فرانت‌اند با پنجره‌ی
// دلخواه (مثلاً ۳ یا ۷ نقطه) روی همین نقاط خام حسابش می‌کنه، چون پنجره‌ی
// مناسب به حجم داده بستگی داره و بهتره قابل‌تغییر بمونه.
// ===========================================================
async function handleExportAirlineTrend(env) {
  const { results } = await env.DB.prepare(
    `SELECT route, flight_date, flight_no, airline, cabin, captured_at, adult_price
     FROM fare_snapshots`
  ).all();

  const perFlight = cheapestPerKey(
    results,
    (r) => [r.route, r.flight_date, r.flight_no, r.airline, r.cabin, r.captured_at].join("|")
  );

  const groups = new Map();
  for (const r of perFlight) {
    const key = [r.route, r.airline, r.cabin, r.captured_at].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        route: r.route,
        airline: r.airline,
        cabin: r.cabin,
        captured_at: r.captured_at,
        prices: [],
      });
    }
    groups.get(key).prices.push(r.price);
  }

  const trend = [...groups.values()]
    .map((g) => ({
      route: g.route,
      airline: g.airline,
      cabin: g.cabin,
      captured_at: g.captured_at,
      avg_price: Math.round(g.prices.reduce((a, b) => a + b, 0) / g.prices.length),
      sample_size: g.prices.length,
    }))
    .sort((a, b) =>
      (a.route + a.airline + a.cabin + a.captured_at).localeCompare(
        b.route + b.airline + b.cabin + b.captured_at
      )
    );

  return json({
    generated_at: new Date().toISOString().slice(0, 16),
    airline_trend: trend,
  });
}

// ===========================================================
// /routes — مدیریت مسیرهای تحت رصد (برای پنل ادمین و fare_monitor.py)
// GET    /routes  -> لیست همه‌ی مسیرها
// POST   /routes   body: { id?, label, origin, destination, start_date, end_date, active? }
//        اگه id بدی، آپدیت می‌کنه؛ وگرنه بر اساس label جدید می‌سازه یا آپسرت می‌کنه
// DELETE /routes   body: { id }
// ===========================================================
async function handleRoutesList(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, label, origin, destination, start_date, end_date, active FROM routes ORDER BY id`
  ).all();
  return json({ routes: results });
}

async function handleRoutesUpsert(request, env) {
  const b = await request.json();
  const { id, label, origin, destination, start_date, end_date } = b;
  if (!label || !origin || !destination || !start_date || !end_date) {
    return json({ error: "فیلدهای مسیر ناقصه" }, 400);
  }
  const activeVal = b.active === undefined ? 1 : (b.active ? 1 : 0);

  if (id) {
    await env.DB.prepare(
      `UPDATE routes SET label=?, origin=?, destination=?, start_date=?, end_date=?, active=? WHERE id=?`
    ).bind(label, origin, destination, start_date, end_date, activeVal, id).run();
    return json({ ok: true, id });
  }

  const res = await env.DB.prepare(
    `INSERT INTO routes (label, origin, destination, start_date, end_date, active, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(label) DO UPDATE SET origin=excluded.origin, destination=excluded.destination,
       start_date=excluded.start_date, end_date=excluded.end_date, active=excluded.active`
  ).bind(label, origin, destination, start_date, end_date, activeVal, new Date().toISOString()).run();
  return json({ ok: true, id: res.meta.last_row_id });
}

async function handleRoutesDelete(request, env) {
  const { id } = await request.json();
  if (!id) return json({ error: "id لازمه" }, 400);
  await env.DB.prepare(`DELETE FROM routes WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

function withCORS(resp) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return resp;
}

// ===========================================================
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return withCORS(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    const auth = request.headers.get("Authorization") || "";
    if (auth !== `Bearer ${env.INGEST_SECRET}`) {
      return withCORS(json({ error: "unauthorized" }, 401));
    }

    let resp;
    if (url.pathname === "/due" && request.method === "POST") {
      resp = await handleDue(request, env);
    } else if (url.pathname === "/ingest" && request.method === "POST") {
      resp = await handleIngest(request, env);
    } else if (url.pathname === "/export/data" && request.method === "GET") {
      resp = await handleExportData(env);
    } else if (url.pathname === "/export/history" && request.method === "GET") {
      resp = await handleExportHistory(env);
    } else if (url.pathname === "/export/route-trend" && request.method === "GET") {
      resp = await handleExportRouteTrend(env);
    } else if (url.pathname === "/export/airline-trend" && request.method === "GET") {
      resp = await handleExportAirlineTrend(env);
    } else if (url.pathname === "/routes" && request.method === "GET") {
      resp = await handleRoutesList(env);
    } else if (url.pathname === "/routes" && request.method === "POST") {
      resp = await handleRoutesUpsert(request, env);
    } else if (url.pathname === "/routes" && request.method === "DELETE") {
      resp = await handleRoutesDelete(request, env);
    } else {
      resp = json({ error: "not found" }, 404);
    }
    return withCORS(resp);
  },
};
