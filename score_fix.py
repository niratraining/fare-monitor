import json, math, random
from collections import defaultdict

HISTORY_PATH = "docs/history.json"
MIN_POINTS_PER_FLIGHT = 4
MIN_FLIGHTS_PER_SELLER = 3
N_BOOTSTRAP = 1000
random.seed(42)


def pearson(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx == 0 or vy == 0:
        return None
    return cov / math.sqrt(vx * vy)


def fisher_z(r):
    r = max(-0.999999, min(0.999999, r))
    return math.atanh(r)


def load_flights(path):
    data = json.load(open(path, encoding="utf-8"))
    by_flight = defaultdict(list)
    for row in data["history"]:
        key = (row["seller"], row["route"], row["flight_no"], row["flight_date"])
        by_flight[key].append(row)

    out = defaultdict(lambda: defaultdict(list))
    for (seller, route, flight_no, flight_date), pts in by_flight.items():
        if not seller:
            continue
        pts_sorted = sorted(pts, key=lambda r: r["captured_at"])
        n = len(pts_sorted)
        if n < MIN_POINTS_PER_FLIGHT:
            continue
        xs = list(range(n))
        ys = [p["price"] for p in pts_sorted]
        rho = pearson(xs, ys)
        if rho is None:
            continue
        out[seller][route].append((n, rho))
    return out


def route_effective_abs_rho(flight_list):
    total_w = sum(max(n - 3, 1) for n, _ in flight_list)
    if total_w == 0:
        return None, 0
    z_avg = sum(max(n - 3, 1) * abs(fisher_z(rho)) for n, rho in flight_list) / total_w
    return math.tanh(z_avg), total_w


def seller_score(seller_data):
    route_vals = []
    total_flights = 0
    for route, flist in seller_data.items():
        abs_rho, w = route_effective_abs_rho(flist)
        if abs_rho is None:
            continue
        route_vals.append((abs_rho, w))
        total_flights += len(flist)
    if not route_vals or total_flights < MIN_FLIGHTS_PER_SELLER:
        return None
    total_w = sum(w for _, w in route_vals)
    mean_abs_rho = sum(abs_rho * w for abs_rho, w in route_vals) / total_w
    return 1 - mean_abs_rho, total_w, len(route_vals), total_flights


def bootstrap_ci(seller_data, n_boot=N_BOOTSTRAP):
    routes = list(seller_data.keys())
    scores = []
    for _ in range(n_boot):
        resampled = {}
        boot_routes = [random.choice(routes) for _ in routes]
        for i, route in enumerate(boot_routes):
            flist = seller_data[route]
            boot_flist = [random.choice(flist) for _ in flist]
            resampled[f"{route}#{i}"] = boot_flist
        result = seller_score(resampled)
        if result:
            scores.append(result[0])
    if len(scores) < n_boot * 0.5:
        return None, None
    scores.sort()
    lo = scores[int(0.05 * len(scores))]
    hi = scores[int(0.95 * len(scores)) - 1]
    return lo, hi


def main():
    by_seller = load_flights(HISTORY_PATH)
    rows = []
    for seller, seller_data in by_seller.items():
        result = seller_score(seller_data)
        if result is None:
            continue
        score, total_w, n_routes, n_flights = result
        lo, hi = bootstrap_ci(seller_data)
        rows.append({
            "seller": seller, "score": score, "lo": lo, "hi": hi,
            "n_routes": n_routes, "n_flights": n_flights,
        })
    rows.sort(key=lambda r: r["score"], reverse=True)

    print(f"{'رتبه':<4}{'فروشنده':<28}{'مسیر':<6}{'پرواز':<6}{'v3 امتیاز':<10}{'بازه ۹۰٪':<16}")
    for i, r in enumerate(rows, 1):
        ci = f"{r['lo']*100:.1f}-{r['hi']*100:.1f}" if r["lo"] is not None else "—"
        print(f"{i:<4}{r['seller']:<28}{r['n_routes']:<6}{r['n_flights']:<6}"
              f"{r['score']*100:<9.1f}%{ci:<16}")
    print(f"\nتعداد فروشنده‌ی واجدشرایط (v3، حداقل {MIN_FLIGHTS_PER_SELLER} پرواز واجد شرایط): {len(rows)}")


if __name__ == "__main__":
    main()
