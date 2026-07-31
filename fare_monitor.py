"""
Fare Monitor — رصد نرخ پروازهای چندمسیره (تهران↔استانبول، تهران↔دبی، ...)
با استفاده از endpoint واقعی موبایل سپهر۳۶۰ که با DevTools پیدا شد.

مسیرها دیگه این‌جا هاردکد نیستن؛ از جدول routes روی D1 خونده می‌شن
(از طریق GET /routes رو Worker). اضافه/غیرفعال کردن مسیر یعنی یه ردیف
تو دیتابیس یا از پنل routes.html، نه ادیت این فایل.

===========================================================
معماری (نسخه‌ی جدید)
===========================================================
دیگه دیتابیس محلی (fares.db) نداریم. تمام اسنپ‌شات‌های قیمت روی
Cloudflare D1 نگه داشته می‌شن، از طریق یه Worker (worker.js) که سه کار
می‌کنه:
  1) می‌گه کدوم پروازها الان "نوبتشونه" (بر اساس DTD و آخرین رصد)
  2) اسنپ‌شات‌های جدید رو ذخیره می‌کنه
  3) دو تا JSON خروجی (برای پنل) رو تولید می‌کنه

این اسکریپت فقط: کاندیدها رو به Worker می‌ده -> لیست "نوبت‌دارها" رو
می‌گیره -> برای همونا از سپهر۳۶۰ قیمت می‌گیره -> به Worker می‌فرسته ->
در آخر دو فایل docs/data.json و docs/history.json رو از Worker می‌گیره
و می‌نویسه (این دوتا فایل کوچیک، همون چیزیه که باید commit بشه).

===========================================================
متغیرهای محیطی لازم (به‌عنوان GitHub Secrets ست کن)
===========================================================
    CF_WORKER_URL       مثلا https://fare-monitor-api.username.workers.dev
    CF_INGEST_SECRET    همون secret ای که رو Worker هم ست کردی

===========================================================
نصب پیش‌نیاز
===========================================================
    pip install requests

زمان‌بندی: هر ۲ ساعت (چون ریزترین لایه‌ی رصد هر ۲ ساعته)؛
خودِ Worker تصمیم می‌گیره کدوم پروازها الان واقعاً نیاز به رصد دارن.
"""

import time
import json
import os
import random
from datetime import datetime, timedelta

import requests

DOCS_JSON_PATH = os.path.join("docs", "data.json")
DOCS_HISTORY_JSON_PATH = os.path.join("docs", "history.json")
DOCS_ROUTE_TREND_JSON_PATH = os.path.join("docs", "route-trend.json")
DOCS_AIRLINE_TREND_JSON_PATH = os.path.join("docs", "airline-trend.json")

WORKER_URL = os.environ.get("CF_WORKER_URL", "").rstrip("/")
CF_SECRET = os.environ.get("CF_INGEST_SECRET", "")

CF_HEADERS = {
    "Authorization": f"Bearer {CF_SECRET}",
    "Content-Type": "application/json",
}

# به‌جای یه عدد ثابت، یه بازه؛ عدد ثابت خودش یه الگوی قابل شناسایی می‌سازه
DELAY_MIN_SEC = 3
DELAY_MAX_SEC = 9

# سقف تعداد درخواست به سپهر۳۶۰ در هر بار اجرا (حتی اگه "due" خیلی بیشتر باشه)
MAX_TARGETS_PER_RUN = 15

# جیتر شروع: قبل از اولین درخواست، یه مدت رندوم صبر می‌کنیم تا لحظه‌ی
# دقیق اجرا هر بار فرق کنه (نه دقیقاً سر ساعت‌های زوج)
STARTUP_JITTER_MAX_SEC = 90

API_URL = "https://api.sepehr360.ir/api/Parvaz/Oneway/B2c/Search/GetNatayejParvaz/Mobile/V2"

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://m.sepehr360.ir",
    "Referer": "https://m.sepehr360.ir/",
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
}


# ===========================================================
# تبدیل تاریخ میلادی به شمسی (بدون نیاز به پکیج جانبی)
# ===========================================================
def gregorian_to_jalali(g_y, g_m, g_d):
    g_days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    j_days_in_month = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29]

    gy = g_y - 1600
    gm = g_m - 1
    gd = g_d - 1

    g_day_no = 365 * gy + (gy + 3) // 4 - (gy + 99) // 100 + (gy + 399) // 400
    for i in range(gm):
        g_day_no += g_days_in_month[i]
    if gm > 1 and ((g_y % 4 == 0 and g_y % 100 != 0) or (g_y % 400 == 0)):
        g_day_no += 1
    g_day_no += gd

    j_day_no = g_day_no - 79

    j_np = j_day_no // 12053
    j_day_no %= 12053

    jy = 979 + 33 * j_np + 4 * (j_day_no // 1461)
    j_day_no %= 1461

    if j_day_no >= 366:
        jy += (j_day_no - 1) // 365
        j_day_no = (j_day_no - 1) % 365

    for i in range(11):
        if j_day_no < j_days_in_month[i]:
            jm = i + 1
            jd = j_day_no + 1
            break
        j_day_no -= j_days_in_month[i]
    else:
        jm = 12
        jd = j_day_no + 1

    return jy, jm, jd


def to_jalali_str(date_str):
    """ورودی: '2026-08-01' (میلادی) -> خروجی: '1405-05-10' (شمسی)"""
    d = datetime.strptime(date_str, "%Y-%m-%d")
    jy, jm, jd = gregorian_to_jalali(d.year, d.month, d.day)
    return f"{jy:04d}-{jm:02d}-{jd:02d}"


def daterange(start, end):
    d0 = datetime.strptime(start, "%Y-%m-%d")
    d1 = datetime.strptime(end, "%Y-%m-%d")
    cur = d0
    while cur <= d1:
        yield cur.strftime("%Y-%m-%d")
        cur += timedelta(days=1)


# ===========================================================
# فراخوانی API سپهر۳۶۰
# ===========================================================
def fetch_via_api(origin, destination, date_str_greg, session):
    jalali_date = to_jalali_str(date_str_greg)
    payload = {
        "originAirportIataCode": origin,
        "destinationAirportIataCode": destination,
        "airLinesFilterList": [],
        "cabinFilterList": [],
        "dayPartsFilterList": [],
        "isMiladi": False,
        "pageNumber": 0,
        "searchDate": jalali_date,
        "sortOrder": 1,
        "tablighNatayejParvazSort": 2,
        "tavaghofFilterList": [],
    }
    resp = session.post(API_URL, headers=HEADERS, json=payload, timeout=20)
    resp.raise_for_status()
    data = resp.json()

    flights = []
    for radif in data.get("radifList", []):
        rp = radif.get("radifParvazi")
        if not rp:
            continue  # این یه ردیف تبلیغاتیه (tabligh)، پرواز واقعی نیست

        airline = rp.get("airlineNameFa", "")
        flight_no = rp.get("cleanFlightNumber", "")
        dep_time = rp.get("zamanKhorojAzMabda", "")
        arr_time = rp.get("zamanVorodBeMaghsad", "")
        airplane = rp.get("airplaneName", "")
        cabin = rp.get("cabinType", "")

        for entry in rp.get("radifParvaziEntekhabForoshandeList", []):
            pc = entry.get("parvazCharteri") or entry.get("parvazWebservice")
            if not pc:
                continue
            tk = pc.get("taminKonande", {})
            flights.append({
                "airline": airline,
                "flight_no": flight_no,
                "dep_time": dep_time,
                "arr_time": arr_time,
                "airplane": airplane,
                "cabin": cabin,
                "seller": tk.get("nameFa", ""),
                "adult_price": pc.get("formattedAdultPrice", ""),
                "child_price": pc.get("formattedChildPrice", ""),
                "infant_price": pc.get("formattedInfantPrice", ""),
                "seat_count": pc.get("seatCount", ""),
            })
    return flights


# ===========================================================
# ارتباط با Cloudflare Worker
# ===========================================================
def get_active_routes(session):
    """مسیرهای فعال رو از جدول routes (روی D1) می‌گیره."""
    resp = session.get(f"{WORKER_URL}/routes", headers=CF_HEADERS, timeout=20)
    resp.raise_for_status()
    routes = resp.json().get("routes", [])
    return [r for r in routes if r.get("active")]


def get_due_targets(session, routes):
    candidates = [
        {"route": route["label"], "flight_date": date_str}
        for route in routes
        for date_str in daterange(route["start_date"], route["end_date"])
    ]
    resp = session.post(
        f"{WORKER_URL}/due", headers=CF_HEADERS,
        json={"candidates": candidates}, timeout=20
    )
    resp.raise_for_status()
    return resp.json().get("due", [])


def ingest_snapshot(session, route_label, date_str, flights, captured_at):
    payload = {
        "route": route_label,
        "flight_date": date_str,
        "captured_at": captured_at,
        "flights": flights,
    }
    resp = session.post(f"{WORKER_URL}/ingest", headers=CF_HEADERS, json=payload, timeout=20)
    resp.raise_for_status()


def export_json(session, kind, out_path):
    resp = session.get(f"{WORKER_URL}/export/{kind}", headers=CF_HEADERS, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return data


# ===========================================================
# اجرای اصلی
# ===========================================================
def run_snapshot():
    session = requests.Session()

    # جیتر شروع: تاخیر رندوم قبل از هر کاری، تا زمان دقیق اجرا هر بار فرق کنه
    startup_delay = random.uniform(0, STARTUP_JITTER_MAX_SEC)
    print(f"جیتر شروع: {startup_delay:.1f} ثانیه صبر می‌کنیم...")
    time.sleep(startup_delay)

    routes = get_active_routes(session)
    if not routes:
        print("هیچ مسیر فعالی تو جدول routes تعریف نشده — رد شدن از این اجرا")
        return
    route_map = {r["label"]: r for r in routes}

    due = get_due_targets(session, routes)
    if not due:
        print("هیچ پروازی الان نوبتش نرسیده — رد شدن از این اجرا")
        return

    # ترتیب رو رندوم می‌کنیم تا همیشه یه الگوی ثابت (مثلاً همیشه اول
    # مسیر تهران-استانبول) تکرار نشه
    random.shuffle(due)

    # سقف تعداد درخواست در هر اجرا؛ بقیه می‌مونن برای اجرای بعدی
    # (چون due بر اساس DTD دوباره محاسبه می‌شه، چیزی گم نمی‌شه)
    if len(due) > MAX_TARGETS_PER_RUN:
        print(f"{len(due)} پرواز نوبتشونه؛ فقط {MAX_TARGETS_PER_RUN} تا رو "
              f"این اجرا انجام می‌دیم و بقیه می‌مونن برای اجرای بعدی")
        due = due[:MAX_TARGETS_PER_RUN]

    captured_at = datetime.now().isoformat(timespec="minutes")

    for item in due:
        route_label = item["route"]
        date_str = item["flight_date"]
        route = route_map.get(route_label)
        if not route:
            continue
        try:
            flights = fetch_via_api(route["origin"], route["destination"], date_str, session)
        except Exception as e:
            print(f"خطا در {route_label} - {date_str}: {e}")
            continue

        try:
            ingest_snapshot(session, route_label, date_str, flights, captured_at)
        except Exception as e:
            print(f"خطا در ثبت {route_label} - {date_str} روی Cloudflare: {e}")
            continue

        print(f"✓ {route_label} — {date_str} — {len(flights)} پرواز ثبت شد ({captured_at})")
        time.sleep(random.uniform(DELAY_MIN_SEC, DELAY_MAX_SEC))


if __name__ == "__main__":
    if not WORKER_URL or not CF_SECRET:
        raise SystemExit("متغیرهای CF_WORKER_URL و CF_INGEST_SECRET ست نشدن.")

    run_snapshot()

    session = requests.Session()
    data = export_json(session, "data", DOCS_JSON_PATH)
    print(f"✓ docs/data.json به‌روزرسانی شد ({len(data.get('flights', []))} ردیف)")

    history = export_json(session, "history", DOCS_HISTORY_JSON_PATH)
    print(f"✓ docs/history.json به‌روزرسانی شد ({len(history.get('history', []))} نقطه‌ی قیمتی)")

    route_trend = export_json(session, "route-trend", DOCS_ROUTE_TREND_JSON_PATH)
    print(f"✓ docs/route-trend.json به‌روزرسانی شد ({len(route_trend.get('route_trend', []))} نقطه‌ی میانگین مسیر)")

    airline_trend = export_json(session, "airline-trend", DOCS_AIRLINE_TREND_JSON_PATH)
    print(f"✓ docs/airline-trend.json به‌روزرسانی شد ({len(airline_trend.get('airline_trend', []))} نقطه‌ی میانگین ایرلاین)")
