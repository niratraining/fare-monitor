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
//
// طبق مشاهده‌ی واقعی: نرخ پروازهای نزدیک (امروز/فردا/چندروز آینده) هر
// نیم‌ساعت تا یک ساعت عوض می‌شه، ولی روزهای دورتر (بیش از یک هفته)
// عملاً به‌ندرت تغییر می‌کنن. قبلاً بودجه‌ی رصد (سقف MAX_TARGETS_PER_RUN
// در هر اجرا) یکنواخت‌تر بین لایه‌ها تقسیم می‌شد؛ الان لایه‌های نزدیک
// خیلی تنگ‌ترن (بیشترین سهم رصد رو می‌گیرن) و لایه‌ی دور شل‌تر شده
// (سهمش کمتره) تا اون بودجه بیشتر خرج جایی بشه که واقعاً تغییر می‌کنه.
function tierIntervalHours(dtdDays) {
  if (dtdDays <= 0) return 20 / 60;  // امروز: هر ۲۰ دقیقه (سقف واقعی، برابر ضربان کرون)
  if (dtdDays <= 1) return 0.5;      // فردا: هر ۳۰ دقیقه
  if (dtdDays <= 3) return 1;        // ۲-۳ روز مونده: هر ۱ ساعت
  if (dtdDays <= 7) return 3;        // تا یک هفته: هر ۳ ساعت
  return 12;                          // بیش از یک هفته: هر ۱۲ ساعت (به‌ندرت تغییر می‌کنه)
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
// نرمال‌سازی نام فروشنده — سپهر۳۶۰ بعضی‌وقتا همون فروشنده رو با
// کاراکترهای نامرئی اضافه (ZWSP/LRM/RLM/BOM)، حروف عربی به‌جای فارسی
// (ي به‌جای ی، ك به‌جای ک)، یا چند فاصله‌ی پشت‌سرهم برمی‌گردونه. بدون
// این نرمال‌سازی، تاریخچه‌ی قیمت (که بر اساس رشته‌ی دقیق seller
// گروه‌بندی می‌شه) بی‌دلیل قطع می‌شه — انگار یه فروشنده‌ی جدیده، درحالی
// که همون فروشنده‌ی قبلیه با یه بایت اضافه.
// ===========================================================
function normalizeSellerName(s) {
  if (!s) return "";
  let out = String(s);
  out = out.replace(/[\u200b\u200e\u200f\ufeff]/g, ""); // کاراکترهای نامرئی
  out = out.replace(/\u064a/g, "\u06cc").replace(/\u0643/g, "\u06a9"); // عربی -> فارسی
  out = out.replace(/\s+/g, " ").trim(); // چند فاصله -> یک فاصله
  return out;
}

// ===========================================================
// ابزارهای آماری مشترک (میانه/MAD) — برای baseline نوسان مسیر و Price
// Index. عیناً همون پیاده‌سازی‌ای که قبلاً تو docs/index.html بود؛ حالا
// این محاسبات یک‌بار اینجا (سمت Worker) انجام می‌شن، نه هر بار تو کلاینت.
// ===========================================================
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mad(arr, med) {
  if (!arr.length) return 0;
  const m = med !== undefined && med !== null ? med : median(arr);
  return median(arr.map((x) => Math.abs(x - m))) || 0;
}

function normalizeCabin(raw) {
  const key = String(raw || "").toLowerCase();
  if (key.includes("first")) return "first";
  if (key.includes("business")) return "business";
  if (key.includes("premium")) return "premium";
  return "economy";
}

// تبدیل میلادی به شمسی — فقط برای تشخیص نوروز/شب یلدا تو isSeasonalDate.
// عیناً همون الگوریتم index.html/fare_monitor.py؛ اگه اونجا عوض شد، اینجا
// هم دستی سینک کن (کپی جدا شده چون Worker و پنل دو باندل مجزان).
function gregorianToJalali(gy, gm, gd) {
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  gy = gy - 1600; gm = gm - 1; gd = gd - 1;
  let g_day_no = 365 * gy + Math.floor((gy + 3) / 4) - Math.floor((gy + 99) / 100) + Math.floor((gy + 399) / 400);
  g_day_no += g_d_m[gm] + gd;
  if (gm > 1 && ((gy + 1600) % 4 === 0 && ((gy + 1600) % 100 !== 0 || (gy + 1600) % 400 === 0))) g_day_no += 1;
  let j_day_no = g_day_no - 79;
  const j_np = Math.floor(j_day_no / 12053);
  j_day_no %= 12053;
  let jy = 979 + 33 * j_np + 4 * Math.floor(j_day_no / 1461);
  j_day_no %= 1461;
  if (j_day_no >= 366) {
    jy += Math.floor((j_day_no - 1) / 365);
    j_day_no = (j_day_no - 1) % 365;
  }
  const j_days_in_month = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];
  let jm = 0, jd = j_day_no;
  for (; jm < 11; jm++) {
    if (jd < j_days_in_month[jm]) break;
    jd -= j_days_in_month[jm];
  }
  return [jy, jm + 1, jd + 1];
}

// همون لیست تعطیلات قمری هاردکد که تو index.html هست — دستی سینک نگه دار
const LUNAR_HOLIDAYS_GREGORIAN = [
  // 'YYYY-MM-DD',
];

function isSeasonalDate(dateStr) {
  if (!dateStr) return false;
  if (LUNAR_HOLIDAYS_GREGORIAN.includes(dateStr)) return true;
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = d.getUTCDay(); // ۴=پنج‌شنبه، ۵=جمعه
  if (dow === 4 || dow === 5) return true;
  const [, jm, jd] = gregorianToJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  if (jm === 1 && jd <= 13) return true; // نوروز
  if (jm === 9 && jd === 30) return true; // شب یلدا
  return false;
}

// ===========================================================
// پاک‌سازی خودکار fare_snapshots/check_state برای تاریخ‌های خیلی
// گذشته — بدون این، جدول با گذشت ماه‌ها (چون هر رصد حتی بدون تغییر
// قیمت یک ردیف خام ثبت می‌کنه) بی‌نهایت بزرگ می‌شه و کوئری‌های export
// کند می‌شن. اجرا فقط حداکثر هر ۲۰ ساعت یک‌بار واقعاً کار می‌کنه (وضعیتش
// تو maintenance_state ذخیره می‌شه)، پس صدا زدنش از هر /ingest تقریباً
// بی‌هزینه‌ست (یک SELECT ساده در بیشتر اجراها) و نیازی به cron جدا نداره.
// ۳ روز بعد از تاریخ پرواز نگه داشته می‌شه (حاشیه‌ی کافی برای بج
// «اتمام نرخ‌گذاری»/بررسی دستی)، نه بیشتر.
const CLEANUP_RETENTION_DAYS = 3;
const CLEANUP_MIN_INTERVAL_HOURS = 20;

async function maybeRunCleanup(env) {
  const { results } = await env.DB.prepare(
    `SELECT value FROM maintenance_state WHERE key = 'last_cleanup_at'`
  ).all();
  const lastCleanupAt = results[0]?.value || null;
  const now = new Date();

  if (lastCleanupAt) {
    const hoursSince = (now - new Date(lastCleanupAt)) / 3600000;
    if (hoursSince < CLEANUP_MIN_INTERVAL_HOURS) return null; // هنوز نوبتش نرسیده
  }

  const cutoffStr = new Date(now.getTime() - CLEANUP_RETENTION_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);

  const delSnap = await env.DB.prepare(`DELETE FROM fare_snapshots WHERE flight_date < ?`)
    .bind(cutoffStr)
    .run();
  const delState = await env.DB.prepare(`DELETE FROM check_state WHERE flight_date < ?`)
    .bind(cutoffStr)
    .run();

  await env.DB.prepare(
    `INSERT INTO maintenance_state (key, value) VALUES ('last_cleanup_at', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(now.toISOString()).run();

  return {
    cutoff: cutoffStr,
    deleted_snapshots: delSnap.meta?.changes ?? null,
    deleted_check_state: delState.meta?.changes ?? null,
  };
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
    // overdueRatio = چند برابر فاصله‌ی مجاز خودش رد شده. این عدد رو به
    // پایتون برمی‌گردونیم تا اونجا موقع اولویت‌بندی، به‌جای صرفاً «نزدیک‌تر
    // بودن روز تقویمی»، «چقدر واقعاً عقب افتاده نسبت به سرعت لازمش»
    // ملاک باشه — وگرنه لایه‌ی امروز (که تقریباً هر اجرا due می‌شه) همیشه
    // کل بودجه‌ی MAX_TARGETS_PER_RUN رو می‌بلعه و لایه‌ی فردا هیچ‌وقت
    // نوبتش نمی‌رسه، حتی وقتی خیلی بیشتر از فاصله‌ی مجازش عقبه.
    let overdueRatio = 999999; // هیچ‌وقت رصد نشده -> فوری‌ترین حالت ممکن
    if (lastCheckedAt) {
      const hoursSince = (now - new Date(lastCheckedAt)) / 3600000;
      isDue = hoursSince >= interval;
      overdueRatio = hoursSince / interval;
    }
    if (isDue) due.push({ ...c, dtd_days: dtdDays, overdue_ratio: overdueRatio });
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
      normalizeSellerName(f.seller),
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

  const cleanup = await maybeRunCleanup(env);

  return json({ ok: true, inserted: flights.length, cleanup });
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
  // نکته: گروه‌بندی seller تو کوئری‌های زیر مستقیماً SQL هست (نه از طریق
  // normalizeSellerName جاوااسکریپتی)، چون از این به بعد seller همیشه در
  // لحظه‌ی ingest نرمال شده ذخیره می‌شه؛ ردیف‌های قدیمی‌تر که قبل از این
  // تغییر با نام نرمال‌نشده ثبت شدن، حداکثر تا CLEANUP_RETENTION_DAYS روز
  // دیگه خودشون پاک می‌شن (رجوع کن به maybeRunCleanup)، پس این مشکل به‌مرور
  // خودش برطرف می‌شه، بدون نیاز به migration دستی.
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

  // ===========================================================
  // Price Index: قیمت هر پرواز باز رو با میانه‌ی بقیه‌ی پیشنهادهای همون
  // (route, flight_date, cabin) تو همین اسنپ‌شات مقایسه می‌کنه. قبلاً این
  // مقایسه هر بار تو کلاینت، با فیلتر روی کل allFlights، برای هر کارت
  // دوباره محاسبه می‌شد؛ حالا یک‌بار همین‌جا حساب و به‌عنوان فیلد آماده
  // (price_index: {pct, count, low_sample}) به خود ردیف flight اضافه
  // می‌شه — index.html فقط می‌خونتش، دوباره محاسبه نمی‌کنه.
  // ===========================================================
  const PRICE_INDEX_MIN_FULL_SAMPLE = 4;
  const peerGroups = new Map(); // "route|flight_date|cabin" -> [{row, price}]
  for (const f of openFlights) {
    const price = priceNum(f.adult_price);
    if (price === null) continue;
    const key = [f.route, f.flight_date, normalizeCabin(f.cabin)].join("|");
    if (!peerGroups.has(key)) peerGroups.set(key, []);
    peerGroups.get(key).push({ row: f, price });
  }
  for (const entries of peerGroups.values()) {
    for (const entry of entries) {
      const peerPrices = entries.filter((e) => e !== entry).map((e) => e.price);
      if (peerPrices.length < 1) {
        entry.row.price_index = null;
        continue;
      }
      const med = median(peerPrices);
      if (!med) {
        entry.row.price_index = null;
        continue;
      }
      entry.row.price_index = {
        pct: Math.round(((entry.price - med) / med) * 100),
        count: peerPrices.length,
        low_sample: peerPrices.length < PRICE_INDEX_MIN_FULL_SAMPLE,
      };
    }
  }

  // نکته‌ی مهم: قبلاً این دو فیلتر روی «todayStr» بودن (فقط امروز/آینده)، که یعنی
  // به‌محض رد شدن یه flight_date از امروز به دیروز، کل تاریخچه‌ی پروازهایی که
  // اون روز باز و بسته شده بودن (و هنوز تو fare_snapshots هستن) از این کوئری
  // می‌افتاد بیرون — فقط تک‌اسنپ‌شات آخرِ همون روز (از openFlights بی‌فیلتر بالا)
  // می‌موند و بقیه بدون این‌که «بسته‌شده» حساب بشن، ناپدید می‌شدن.
  // به‌جاش همون بازه‌ای که fare_snapshots واقعاً نگه‌داشته می‌شه (رجوع کن به
  // CLEANUP_RETENTION_DAYS/maybeRunCleanup) رو پوشش می‌دیم؛ چون ردیف‌های قدیمی‌تر
  // از اون بازه به‌مرور توسط cleanup پاک می‌شن، این فیلتر عملاً هیچ‌وقت بیشتر از
  // حجم موجود تو دیتابیس رو برنمی‌گردونه — فقط اجازه می‌ده یه تاریخ تازه‌گذشته
  // حداقل یک‌بار روستر کامل closed خودش رو کامل نشون بده.
  const closedLookbackStr = new Date(
    Date.now() + IRAN_OFFSET_MS - (CLEANUP_RETENTION_DAYS - 1) * 86400000
  )
    .toISOString()
    .slice(0, 10);

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
  ).bind(closedLookbackStr, closedLookbackStr).all();

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
    const seller = normalizeSellerName(r.seller); // برای ردیف‌های قدیمی قبل از نرمال‌سازی هم درست گروه‌بندی بشه
    // cabin و seller هر دو تو کلید هستن: یه پرواز هم‌زمان اکونومی/بیزنس داره،
    // و هر فروشنده هم روند قیمت جدای خودش رو داره. بدون seller تو کلید،
    // ارزون‌ترین فروشنده قیمت بقیه‌ی فروشنده‌ها رو تو تاریخچه پاک می‌کرد
    // (باگ: افزایش نرخ یه فروشنده گرون‌تر اصلاً تو تاریخچه دیده نمی‌شد).
    const key = [r.route, r.flight_date, r.flight_no, r.airline, r.cabin, seller, r.captured_at].join("|");
    const existing = grouped.get(key);
    if (!existing || price < existing.price) {
      grouped.set(key, {
        route: r.route,
        flight_date: r.flight_date,
        flight_no: r.flight_no,
        airline: r.airline,
        cabin: r.cabin,
        seller,
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

  // ===========================================================
  // baseline نوسان هر مسیر: میانه/MAD نوسان قیمت بین رصدهای پیاپیِ هر گروه
  // (پرواز+فروشنده+کلاس)، بدون تاریخ‌های فصلی/پرتقاضا. این عدد برای
  // تشخیص «نوسان غیرعادی» پروازهایی که تاریخچه‌ی خودشون هنوز کوتاهه
  // (cold start) استفاده می‌شه. قبلاً کلاینت برای هر پرواز cold-start
  // این باشلاین رو از روی کل allHistory دوباره می‌ساخت (سنگین با رشد
  // تاریخچه)؛ حالا یک‌بار همین‌جا به‌ازای هر route حساب می‌شه.
  // ===========================================================
  const baselineGroups = new Map(); // route -> Map(groupKey -> points[])
  for (const p of history) {
    if (isSeasonalDate(p.flight_date)) continue;
    if (!baselineGroups.has(p.route)) baselineGroups.set(p.route, new Map());
    const routeGroups = baselineGroups.get(p.route);
    const gk = [p.flight_date, p.flight_no, p.airline, normalizeCabin(p.cabin), p.seller].join("|");
    if (!routeGroups.has(gk)) routeGroups.set(gk, []);
    routeGroups.get(gk).push(p);
  }

  const route_baselines = {};
  for (const [route, groups] of baselineGroups) {
    const absDiffs = [];
    for (const points of groups.values()) {
      const sorted = [...points].sort((a, b) => (a.captured_at || "").localeCompare(b.captured_at || ""));
      for (let i = 1; i < sorted.length; i++) {
        const d = sorted[i].price - sorted[i - 1].price;
        if (d !== 0) absDiffs.push(Math.abs(d));
      }
    }
    const med = median(absDiffs);
    route_baselines[route] = {
      median_abs_diff: med,
      mad_abs_diff: mad(absDiffs, med),
      sample_size: absDiffs.length,
    };
  }

  return json({
    generated_at: new Date().toISOString().slice(0, 16),
    history,
    route_baselines,
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
