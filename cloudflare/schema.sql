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
);

CREATE TABLE IF NOT EXISTS check_state (
  route TEXT,
  flight_date TEXT,
  last_checked_at TEXT,
  PRIMARY KEY (route, flight_date)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_route_date
  ON fare_snapshots (route, flight_date);

CREATE INDEX IF NOT EXISTS idx_snapshots_captured
  ON fare_snapshots (captured_at);

-- برای ردیابی «آخرین باری که پاک‌سازی خودکار fare_snapshots اجرا شد»
-- (رشد بی‌رویه‌ی جدول با گذشت زمان، چون هر رصد حتی بدون تغییر قیمت
-- یک ردیف خام ثبت می‌کنه)
CREATE TABLE IF NOT EXISTS maintenance_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- مسیرهای تحت رصد. هر مسیر origin/destination (کد ایاتا، چند فرودگاه با کاما)
-- و بازه‌ی تاریخ خودش رو داره. اضافه/غیرفعال کردن مسیر یعنی یه ردیف
-- این‌جا، نه تغییر کد پایتون یا Worker.
CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT UNIQUE NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);

INSERT OR IGNORE INTO routes (label, origin, destination, start_date, end_date, active, created_at) VALUES
  ('تهران-استانبول', 'THR,IKA,PYK', 'TEQ,SAW,IST', '2026-08-01', '2026-08-11', 1, datetime('now')),
  ('استانبول-تهران', 'TEQ,SAW,IST', 'THR,IKA,PYK', '2026-08-01', '2026-08-11', 1, datetime('now')),
  ('تهران-دبی',       'THR,IKA,PYK', 'SHJ,DWC,DXB', '2026-08-01', '2026-08-11', 1, datetime('now')),
  ('دبی-تهران',       'SHJ,DWC,DXB', 'THR,IKA,PYK', '2026-08-01', '2026-08-11', 1, datetime('now'));
