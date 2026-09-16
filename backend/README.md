# P1/P2/P3 Backend

FastAPI backend for the online P2 flow. It keeps the Baidu service AK on the server and exposes the contract consumed by the Vite frontend.

## Local start

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

`app.config` automatically loads `backend/.env` for local development. Existing process environment variables take precedence.

Live health: `GET http://localhost:8000/api/health?verify=true`

Route matrix: `POST http://localhost:8000/api/v1/map/route-matrix`

POI search: `POST http://localhost:8000/api/v1/map/poi/search`

Complete P3 flow: `POST http://localhost:8000/api/v1/map/poi/analyze`

Blind-spot analysis: `POST http://localhost:8000/api/v1/map/blind-spots`

The request uses internal `{ lng, lat }` objects. The adapter converts them to Baidu's required `lat,lng` string and requests `coord_type=bd09ll`. A successful response is normalized to `{ ok: true, data, meta }` for the existing frontend client.

The P1 adapter provides bounded concurrency, a configurable sliding-window QPS limiter, exponential retry with jitter, TTL caching, a circuit breaker, sanitized errors, and aggregate upstream/cache/retry/rate-wait/upstream-limit counters in response metadata. `BAIDU_MAX_QPS=1` and `BAIDU_QPS_WINDOW_SECONDS=3.2` are the conservative defaults for the current service quota; the extra interval absorbs provider-side clock, network jitter, and shared-AK quota accounting. Circle search uses `radius_limit=true`; polygon requests use Baidu's `bounds` parameter and are locally checked again.

The complete P3 endpoint fetches real multi-page Baidu Place Search results, reads `classified_poi_tag`, applies the local dictionary in `app/poi_dictionary.py`, deduplicates results, filters the service area, and executes blind-spot analysis. Its quality statistics include raw, standardized, deduplicated, excluded, review, and per-category counts. Boundary candidates are rechecked with at most 20 Walking RouteMatrix calls.

Run offline backend tests without a real AK:

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

Do not put `BAIDU_SERVICE_AK` in `VITE_*` variables, frontend source, Docker image build arguments, or logs.
