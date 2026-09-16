import asyncio
import unittest

from app.evidence.benchmark import run_benchmark


class RouteMatrixBenchmarkTests(unittest.TestCase):
    def test_simulated_benchmark_retains_all_runs_and_counts_quota(self) -> None:
        result = asyncio.run(run_benchmark(
            mode="simulated",
            runs=3,
            destination_count=6,
            simulated_latency_ms=0,
            api_base_url="",
        ))
        self.assertEqual(len(result["runs"]), 12)
        summaries = {(item["strategy"], item["cacheState"]): item for item in result["summaries"]}
        self.assertEqual(summaries[("point", "cold")]["meanUpstreamCalls"], 6)
        self.assertEqual(summaries[("batch", "cold")]["meanUpstreamCalls"], 1)
        self.assertEqual(summaries[("point", "cache-hit")]["meanUpstreamCalls"], 0)
        self.assertEqual(summaries[("batch", "cache-hit")]["meanUpstreamCalls"], 0)
        self.assertEqual(summaries[("point", "cold")]["meanSuccessRate"], 1)
        self.assertEqual(len(summaries[("batch", "cold")]["elapsedMs"]["allRuns"]), 3)
        self.assertEqual(result["environment"]["source"], "offline-simulated")
        self.assertEqual(result["sampleSize"]["totalRunRecords"], 12)
        self.assertEqual(result["confidence"]["level"], "simulation-only")


if __name__ == "__main__":
    unittest.main()
