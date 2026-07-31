"""
Fare Monitor — رصد نرخ پرواز تهران↔استانبول
با استفاده از endpoint واقعی موبایل سپهر۳۶۰ که با DevTools پیدا شد.

===========================================================
نصب پیش‌نیاز
===========================================================
    pip install requests

===========================================================
زمان‌بندی هر ۶ ساعت (لینوکس/مک — cron)
===========================================================
    crontab -e
    0 */6 * * * /usr/bin/python3 /path/to/fare_monitor.py >> /path/to/fare_monitor.log 2>&1

روی ویندوز: Task Scheduler با تریگر "هر ۶ ساعت".
"""

import sqlite3
import time
import json
import os
from datetime import datetime, timedelta

import requests

DB_PATH = "fares.db"
DOCS_JSON_PATH = os.path.join("docs", "data.json")

# ---- بازه‌ی تاریخ میلادی مورد نظر برای رصد ----
START_DATE = "2026-08-01"
END_DATE   = "2026-08-11"

ROUTES = [
    {"origin": "THR,IKA,PYK", "destination": "TEQ,SAW,IST", "label": "تهران-استانبول"},
    {"origin": "TEQ,SAW,IST", "destination": "THR,IKA,PYK", "label": "استانبول-تهران"},
]

DELAY_BETWEEN_REQUESTS_SEC = 4

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


# ===========================================================
# فراخوانی API
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

        # این فیلدها مال خودِ پروازن (سطح radifParvazi)، مشترک بین همه‌ی فروشنده‌هاش
        airline = rp.get("airlineNameFa", "")
        flight_no = rp.get("cleanFlightNumber", "")
        dep_time = rp.get("zamanKhorojAzMabda", "")
        arr_time = rp.get("zamanVorodBeMaghsad", "")
        airplane = rp.get("airplaneName", "")
        cabin = rp.get("cabinType", "")

        for entry in rp.get("radifParvaziEntekhabForoshandeList", []):
            # ممکنه پرواز چارتری باشه (parvazCharteri) یا از طریق وب‌سرویس ایرلاین (parvazWebservice)
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
# دیتابیس
# ===========================================================
def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS fare_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            route TEXT,
            flight_date TEXT,
            airline TEXT,
            flight_no TEXT,
            dep_time TEXT,
            arr_time TEXT,
            airplane TEXT,
            cabin TEXT,
            adult_price TEXT,
            child_price TEXT,
            infant_price TEXT,
            seller TEXT,
            seat_count TEXT,
            captured_at TEXT
        )
    """)
    conn.commit()
    return conn


def daterange(start, end):
    d0 = datetime.strptime(start, "%Y-%m-%d")
    d1 = datetime.strptime(end, "%Y-%m-%d")
    cur = d0
    while cur <= d1:
        yield cur.strftime("%Y-%m-%d")
        cur += timedelta(days=1)


# ===========================================================
# اجرای اصلی
# ===========================================================
def run_snapshot():
    conn = init_db()
    session = requests.Session()
    captured_at = datetime.now().isoformat(timespec="minutes")

    for route in ROUTES:
        for date_str in daterange(START_DATE, END_DATE):
            try:
                flights = fetch_via_api(route["origin"], route["destination"], date_str, session)
            except Exception as e:
                print(f"خطا در {route['label']} - {date_str}: {e}")
                continue

            for f in flights:
                conn.execute(
                    """INSERT INTO fare_snapshots
                       (route, flight_date, airline, flight_no, dep_time, arr_time, airplane, cabin,
                        adult_price, child_price, infant_price, seller, seat_count, captured_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (route["label"], date_str, f["airline"], f["flight_no"], f["dep_time"], f["arr_time"],
                     f["airplane"], f["cabin"], f["adult_price"], f["child_price"], f["infant_price"],
                     f["seller"], f["seat_count"], captured_at)
                )
            conn.commit()
            print(f"✓ {route['label']} — {date_str} — {len(flights)} پرواز ذخیره شد ({captured_at})")

            time.sleep(DELAY_BETWEEN_REQUESTS_SEC)

    conn.close()


# ===========================================================
# خروجی JSON برای پنل وب (docs/data.json)
# فقط آخرین اسنپ‌شات هر مسیر+تاریخ رو می‌ذاره، نه کل تاریخچه،
# که فایل خیلی بزرگ نشه و پنل سریع لود بشه.
# ===========================================================
def export_latest_json():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    rows = conn.execute("""
        SELECT f.*
        FROM fare_snapshots f
        INNER JOIN (
            SELECT route, flight_date, MAX(captured_at) AS max_captured
            FROM fare_snapshots
            GROUP BY route, flight_date
        ) latest
        ON f.route = latest.route
           AND f.flight_date = latest.flight_date
           AND f.captured_at = latest.max_captured
        ORDER BY f.route, f.flight_date, f.dep_time
    """).fetchall()

    result = {
        "generated_at": datetime.now().isoformat(timespec="minutes"),
        "flights": [dict(r) for r in rows],
    }

    os.makedirs(os.path.dirname(DOCS_JSON_PATH), exist_ok=True)
    with open(DOCS_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    conn.close()
    print(f"✓ docs/data.json به‌روزرسانی شد ({len(rows)} ردیف)")


if __name__ == "__main__":
    run_snapshot()
    export_latest_json()
