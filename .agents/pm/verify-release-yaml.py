"""Verify the release workflow alert job is wired correctly.

Checks that release.yml parses as YAML and that the
alert-on-release-failure job triggers on failure of every release job with
only issues:write permissions.
"""

import yaml

with open(".github/workflows/release.yml", encoding="utf-8") as handle:
    workflow = yaml.safe_load(handle)

jobs = workflow["jobs"]
release_jobs = [name for name in jobs if name != "alert-on-release-failure"]
assert release_jobs, "no release jobs found"

assert "alert-on-release-failure" in jobs, "missing alert-on-release-failure job"
alert = jobs["alert-on-release-failure"]
assert alert["if"] == "failure()", f"unexpected if: {alert['if']!r}"
needs = alert["needs"]
needs = [needs] if isinstance(needs, str) else list(needs)
assert sorted(needs) == sorted(release_jobs), (
    f"needs {needs!r} does not cover all jobs {release_jobs!r}"
)
assert alert["permissions"] == {"issues": "write"}, (
    f"unexpected permissions: {alert['permissions']!r}"
)

steps = alert["steps"]
assert any(
    "release-failure" in (step.get("run") or "") for step in steps
), "dedup marker label not used in the alert script"

print("release.yml alert job verified")
