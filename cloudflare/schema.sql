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
