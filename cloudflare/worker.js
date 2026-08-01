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

// ---- وقت ایران (UTC+۳:۳۰، بدون تغییر فصلی از ۱۴۰۱ به بعد) ----
const IRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;

// «امروز» به‌عنوان یه روز تقویمی کامل به وقت ایران، نه یه لحظه‌ی UTC.
// flight_date یه برچسب روز تقویمیه (روزی که پرواز توش انجام می‌شه)،
// نه یه لحظه؛ پس باید با «امروزِ» تقویم ایران مقایسه بشه، نه با
// نیمه‌شب UTC (که معادل ساعت ۳:۳۰ بامداد ایرانه و باعث می‌شد از اون
// ساعت به بعد، پرواز «امروز» به‌اشتباه «گذشته» حساب بشه و کلاً از
// رصد حذف بشه — همون چیزی که باعث می‌شد پرواز امروز از صبح دیگه
// اصلاً به‌روز نشه).
function iranTodayUTCms(nowUtcMs) {
  const shifted = new Date(nowUtcMs + IRAN_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

function flightDateUTCms(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

// ---- سطح‌بندی فاصله‌ی رصد بر اساس DTD (روزهای مونده به پرواز) ----
// اینجا رو هر وقت خواستی تغییر بدی، فقط همین چند خط رو عوض کن.
// نکته: این عدد فقط سقف بالای فاصله‌ی رصده؛ چون کرون بیرونی (GitHub
// Actions) هر ۲۰ دقیقه ضربان می‌زنه، این تایمرها معمولاً با دقت
// ۲۰ دقیقه‌ای رعایت می‌شن، نه اینکه دقیقاً سر ساعت باشن.
function tierIntervalHours(dtdDays) {
  if (dtdDays <= 0) return 20 / 60; // امروز: هر ۲۰ دقیقه (هم‌قدم با ضربان پایه‌ی گیت‌هاب اکشن، برای تشخیص سریع‌تر «بسته‌شده»)
  if (dtdDays <= 1) return 1;   // فردا: هر ۱ ساعت
  if (dtdDays <= 3) return 2;   // نزدیک: هر ۲ ساعت
  if (dtdDays <= 7) return 4;   // متوسط: هر ۴ ساعت
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
  const todayMs = iranTodayUTCms(now.getTime());

  // به‌جای یه SELECT جدا برای هر کاندید (که با ~۴۰-۵۰ کاندید سریالی
  // می‌شد و گاهی از ۲۰ ثانیه تایم‌اوت کلاینت پایتون رد می‌شد)، همه‌ی
  // route های دخیل رو یه‌جا با IN (...) می‌خونیم و بقیه‌ی منطق (تشخیص
  // due بودن بر اساس DTD) رو تو خود جاوااسکریپت انجام می‌دیم؛ یعنی کل
  // /due همیشه دقیقاً یک رفت‌وبرگشت به D1 داره، صرف‌نظر از تعداد کاندیدها.
  const routes = [...new Set(candidates.map((c) => c.route))];
  const placeholders = routes.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT route, flight_date, last_checked_at FROM check_state WHERE route IN (${placeholders})`
  )
    .bind(...routes)
    .all();

  const stateMap = new Map();
  for (const row of results) {
    stateMap.set(`${row.route}|${row.flight_date}`, row.last_checked_at);
  }

  const due = [];
  for (const c of candidates) {
    const dtdDays = Math.round((flightDateUTCms(c.flight_date) - todayMs) / 86400000);
    if (dtdDays < 0) continue; // پرواز گذشته (روز تقویمی ایرانش گذشته، نه فقط لحظه‌ی UTC)

    const interval = tierIntervalHours(dtdDays);
    const lastCheckedAt = stateMap.get(`${c.route}|${c.flight_date}`);

    let isDue = true;
    if (lastCheckedAt) {
      const hoursSince = (now - new Date(lastCheckedAt)) / 3600000;
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
// GET /export/data — آخرین اسنپ‌شات هر (route, flight_date)، به‌علاوه‌ی
// پروازهایی که از آخرین رصد همون (route, flight_date) بیرون افتادن —
// یعنی سپهر دیگه نشونشون نمی‌ده (نرخ‌گذاری/فروششون تموم شده). این‌ها
// closed:1 می‌گیرن تا تو پنل به‌جای ناپدید شدن، برن تو آرشیو.
// فقط برای تاریخ‌های امروز/آینده محاسبه می‌شه تا حجم خروجی با گذشت
// زمان و انباشته‌شدن fare_snapshots بی‌نهایت بزرگ نشه.
// ===========================================================
async function handleExportData(env) {
  const { results: openFlights } = await env.DB.prepare(
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

  const todayStr = new Date(Date.now() + IRAN_OFFSET_MS).toISOString().slice(0, 10);

  const { results: closedFlights } = await env.DB.prepare(
    `SELECT f.*
     FROM fare_snapshots f
     INNER JOIN (
       SELECT route, flight_date, flight_no, airline, cabin, seller, MAX(captured_at) AS max_captured
       FROM fare_snapshots
       WHERE flight_date >= ?
       GROUP BY route, flight_date, flight_no, airline, cabin, seller
     ) lastSeen
     ON f.route = lastSeen.route AND f.flight_date = lastSeen.flight_date
        AND f.flight_no = lastSeen.flight_no AND f.airline = lastSeen.airline
        AND f.cabin = lastSeen.cabin AND f.seller = lastSeen.seller
        AND f.captured_at = lastSeen.max_captured
     INNER JOIN (
       SELECT route, flight_date, MAX(captured_at) AS max_captured
       FROM fare_snapshots
       WHERE flight_date >= ?
       GROUP BY route, flight_date
     ) latestOfDay
     ON f.route = latestOfDay.route AND f.flight_date = latestOfDay.flight_date
     WHERE f.captured_at != latestOfDay.max_captured
     ORDER BY f.route, f.flight_date, f.dep_time`
  ).bind(todayStr, todayStr).all();

  const flights = [
    ...openFlights.map((f) => ({ ...f, closed: 0 })),
    ...closedFlights.map((f) => ({ ...f, closed: 1 })),
  ];

  // «به‌روزرسانی ۱۰:۵۰» تو هدر پنل قبلاً یعنی «الان که export صدا زده شد»،
  // نه «قدیمی‌ترین ردیفی که رو صفحه می‌بینی کِی واقعاً از سپهر گرفته شده».
  // این دو تا می‌تونن ساعت‌ها فاصله داشته باشن (وقتی MAX_TARGETS_PER_RUN
  // یه route+date رو عقب می‌ندازه)، و همون چیزیه که باعث می‌شد کاربر با
  // دیدن «۱۰:۵۰» فکر کنه همه‌چیز تا اون لحظه تازه‌ست. stalest_captured_at
  // پایین‌ترین (قدیمی‌ترین) captured_at بین ردیف‌های باز صفحه‌ست — پنل
  // ازش برای هشدار «این عدد ممکنه قدیمی باشه» استفاده می‌کنه.
  let stalestCapturedAt = null;
  for (const f of openFlights) {
    if (!f.captured_at) continue;
    if (stalestCapturedAt === null || f.captured_at < stalestCapturedAt) {
      stalestCapturedAt = f.captured_at;
    }
  }

  return json({
    generated_at: new Date().toISOString().slice(0, 16),
    stalest_captured_at: stalestCapturedAt,
    flights,
  });
}

// ===========================================================
// GET /export/history — تاریخچه‌ی کامل قیمت هر پرواز، جدا برای هر کلاس پرواز
// (ارزان‌ترین قیمت بین فروشنده‌های همون کلاس، در هر لحظه‌ی رصد)
// ===========================================================
async function handleExportHistory(env) {
  const { results } = await env.DB.prepare(
    `SELECT route, flight_date, flight_no, airline, cabin, seller, captured_at, adult_price
     FROM fare_snapshots`
  ).all();

  const grouped = new Map();
  for (const r of results) {
    const price = priceNum(r.adult_price);
    if (price === null) continue;
    // cabin و seller هر دو تو کلید هستن: یه پرواز هم‌زمان اکونومی/بیزنس داره،
    // و هر فروشنده هم روند قیمت جدای خودش رو داره. بدون seller تو کلید،
    // ارزون‌ترین فروشنده قیمت بقیه‌ی فروشنده‌ها رو تو تاریخچه پاک می‌کرد
    // (باگ: افزایش نرخ یه فروشنده گرون‌تر اصلاً تو تاریخچه دیده نمی‌شد).
    const key = [r.route, r.flight_date, r.flight_no, r.airline, r.cabin, r.seller, r.captured_at].join("|");
    const existing = grouped.get(key);
    if (!existing || price < existing.price) {
      grouped.set(key, {
        route: r.route,
        flight_date: r.flight_date,
        flight_no: r.flight_no,
        airline: r.airline,
        cabin: r.cabin,
        seller: r.seller,
        captured_at: r.captured_at,
        price,
      });
    }
  }

  const points = [...grouped.values()].sort((a, b) =>
    (a.route + a.flight_date + a.flight_no + a.cabin + a.seller + a.captured_at).localeCompare(
      b.route + b.flight_date + b.flight_no + b.cabin + b.seller + b.captured_at
    )
  );

  // هر رصد (هر ۲/۶/۱۲ ساعت) یه ردیف خام تو fare_snapshots ثبت می‌شه، حتی اگه
  // قیمت عوض نشده باشه (چون این جدول برای «آخرین وضعیت» هم استفاده می‌شه).
  // اما تاریخچه‌ی قیمت فقط باید نقطه‌هایی داشته باشه که واقعاً یه تغییر
  // (افزایش/کاهش) نسبت به نقطه‌ی قبلی رخ داده؛ رصدهای پشت‌سرهم با قیمت
  // یکسان اینجا فشرده می‌شن (به‌جز اولین رصد از هر گروه که نقطه‌ی شروعه)
  // تا «بدون تغییر» به‌عنوان یک تغییر جدا ثبت نشه.
  const groupKeyOf = (p) => [p.route, p.flight_date, p.flight_no, p.airline, p.cabin, p.seller].join("|");
  const history = [];
  const lastPriceByGroup = new Map();
  for (const p of points) {
    const gk = groupKeyOf(p);
    if (lastPriceByGroup.get(gk) === p.price) continue; // بدون تغییر نسبت به آخرین نقطه‌ی ثبت‌شده
    lastPriceByGroup.set(gk, p.price);
    history.push(p);
  }

  return json({
    generated_at: new Date().toISOString().slice(0, 16),
    history,
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
