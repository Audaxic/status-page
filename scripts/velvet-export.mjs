#!/usr/bin/env node
// Convert Upptime monitoring data into the Velvet v1 data documents that the
// Velvet status page (github.com/phranck/velvet) requires:
//
//   velvet-data/v1/status.json          current status + daily availability
//   velvet-data/v1/response-times.json  response-time samples per service
//   velvet-data/v1/incidents.json       incidents + maintenance (GitHub issues)
//
// Data sources (all local except the optional issues fetch):
//   * history/summary.json              Upptime service list + current status
//   * history/<slug>.yml                per-service check history, reconstructed
//                                       per commit from this git repository
//   * GitHub Issues API (optional)      incidents / maintenance events; needs a
//                                       token only for higher rate limits
//
// The output is validated against the Velvet v1 contract rules (the same rules
// as @velvet/contracts validation) and fails loudly instead of producing a
// document the Velvet build would reject.
//
// Usage: node scripts/velvet-export.mjs [output-dir]
//   output-dir defaults to velvet-data/v1 relative to the repository root.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(
  REPO_ROOT,
  process.argv[2] ?? join("velvet-data", "v1"),
);
const HISTORY_DIR = join(REPO_ROOT, "history");

const STATUS_MAP = {
  up: "operational",
  degraded: "degraded",
  down: "outage",
};
const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const DAY_MS = 86_400_000;

function log(message) {
  console.log(`velvet-export: ${message}`);
}

function fail(message) {
  console.error(`velvet-export: ${message}`);
  process.exit(1);
}

// ── Flat YAML parsing (history/*.yml is a single-level key: value map) ──────
function parseScalar(raw) {
  const value = raw.trim().replace(/^["']|["']$/g, "");
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseFlatYaml(text) {
  const result = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*)$/.exec(line);
    if (match) result[match[1]] = parseScalar(match[2]);
  }
  return result;
}

function readHistoryFile(slug) {
  const path = join(HISTORY_DIR, `${slug}.yml`);
  if (!existsSync(path)) return null;
  return parseFlatYaml(readFileSync(path, "utf8"));
}

function isValidTimestamp(value) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function clampTimestamp(value, minimum, maximum) {
  return Math.min(Math.max(Date.parse(value), minimum), maximum);
}

// ── Git history of a per-service history file ───────────────────────────────
// One `git log -p` call per service: each commit block contributes the added
// lines for the fields we track; unchanged fields inherit from the previous
// commit. Returns samples in chronological order, deduplicated by lastUpdated.
function historySamples(slug) {
  const path = `history/${slug}.yml`;
  let output = "";
  try {
    output = execFileSync(
      "git",
      ["--no-pager", "log", "--format=%H", "-p", "--", path],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    throw new Error(`git log failed for ${path}: ${error.message}`);
  }

  // `git log -p` lists commits newest first; process them oldest first so that
  // fields unchanged by a commit correctly inherit the previous (older) value.
  const blocks = [];
  let block = null;
  for (const line of output.split(/\r?\n/)) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      block = [];
      blocks.push(block);
      continue;
    }
    if (block === null || !line.startsWith("+") || line.startsWith("+++")) {
      continue;
    }
    block.push(line.slice(1));
  }

  const samples = [];
  let current = { lastUpdated: null, status: null, responseTime: null, startTime: null };
  for (const addedLines of blocks.reverse()) {
    const entry = parseFlatYaml(addedLines.join("\n"));
    for (const key of ["lastUpdated", "status", "responseTime", "startTime"]) {
      if (entry[key] !== undefined) current[key] = entry[key];
    }
    if (current.lastUpdated) {
      samples.push({ ...current });
    }
  }

  // The working tree may be ahead of the latest commit; merge it in.
  const working = readHistoryFile(slug);
  if (working && isValidTimestamp(working.lastUpdated)) {
    const last = samples.at(-1);
    if (!last || Date.parse(working.lastUpdated) > Date.parse(last.lastUpdated)) {
      samples.push({
        lastUpdated: working.lastUpdated,
        status: working.status,
        responseTime: working.responseTime,
        startTime: working.startTime,
      });
    }
  }

  const seen = new Set();
  const unique = samples.filter((sample) => {
    if (!isValidTimestamp(sample.lastUpdated) || seen.has(sample.lastUpdated)) {
      return false;
    }
    seen.add(sample.lastUpdated);
    return true;
  });
  unique.sort((left, right) =>
    Date.parse(left.lastUpdated) - Date.parse(right.lastUpdated),
  );
  return unique;
}

// ── Daily availability from the sample timeline ─────────────────────────────
// Sample i covers [lastUpdated_i, lastUpdated_{i+1}); the final sample covers
// [lastUpdated_n, generatedAt). Down time is only counted for "down" samples,
// which matches how Upptime reports minutes down.
function dailyAvailability(samples, generatedAt) {
  const end = Date.parse(generatedAt);
  const days = new Map();
  const addToDay = (dateKey, startMs, durationMs, unavailable) => {
    if (durationMs <= 0) return;
    let day = days.get(dateKey);
    if (!day) {
      day = { monitoredMs: 0, unavailableMs: 0 };
      days.set(dateKey, day);
    }
    day.monitoredMs += durationMs;
    if (unavailable) day.unavailableMs += durationMs;
  };

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const intervalStart = Date.parse(sample.lastUpdated);
    const intervalEnd =
      index + 1 < samples.length
        ? Date.parse(samples[index + 1].lastUpdated)
        : end;
    if (intervalEnd <= intervalStart) continue;

    let cursor = intervalStart;
    while (cursor < intervalEnd) {
      const dayStartsAt = Math.floor(cursor / DAY_MS) * DAY_MS;
      const dayEndsAt = dayStartsAt + DAY_MS;
      const segmentEnd = Math.min(intervalEnd, dayEndsAt);
      addToDay(
        new Date(dayStartsAt).toISOString().slice(0, 10),
        cursor,
        segmentEnd - cursor,
        sample.status === "down",
      );
      cursor = segmentEnd;
    }
  }

  const availability = [];
  for (const [date, totals] of days) {
    const monitoredSeconds = Math.floor(totals.monitoredMs / 1000);
    if (monitoredSeconds < 1) continue;
    availability.push({
      date,
      monitoredSeconds,
      unavailableSeconds: Math.min(
        Math.floor(totals.unavailableMs / 1000),
        monitoredSeconds,
      ),
    });
  }
  availability.sort((left, right) => left.date.localeCompare(right.date));
  return availability;
}

// Retain at most this many days of response-time samples (the site's year chart
// only spans 365 days; older samples are never rendered and would only bloat the
// document the browser downloads on every visit). Override for testing with
// VELVET_RESPONSE_RETENTION_DAYS.
const RESPONSE_RETENTION_DAYS = Number(
  process.env.VELVET_RESPONSE_RETENTION_DAYS ?? 366,
);

function responseSamples(samples, generatedAt) {
  const cutoff = Date.parse(generatedAt) - RESPONSE_RETENTION_DAYS * DAY_MS;
  const seen = new Set();
  const result = [];
  for (const sample of samples) {
    if (!isValidTimestamp(sample.lastUpdated) || seen.has(sample.lastUpdated)) {
      continue;
    }
    seen.add(sample.lastUpdated);
    if (Date.parse(sample.lastUpdated) < cutoff) {
      continue;
    }
    result.push({
      timestamp: sample.lastUpdated,
      responseTimeMs:
        typeof sample.responseTime === "number" && sample.responseTime >= 0
          ? sample.responseTime
          : null,
    });
  }
  return result;
}

// ── GitHub issues → incidents / maintenance events ──────────────────────────
async function fetchIssues(owner, repo, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "velvet-export",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const issues = [];
  let page = 1;
  while (true) {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=all&per_page=100&page=${page}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`GitHub Issues API returned ${response.status}`);
    }
    const batch = await response.json();
    issues.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return issues.filter((issue) => !issue.pull_request);
}

function slugFromLabels(labels, knownSlugs) {
  const names = labels.map((label) => String(label.name ?? label).toLowerCase());
  return knownSlugs.find((slug) => names.includes(slug));
}

function maintenanceMeta(body) {
  const match = /<!--\s*start:\s*([^ ]+)\s+end:\s*([^ ]+)(.*?)-->/.exec(
    String(body ?? ""),
  );
  if (!match) return null;
  const meta = match[3] ?? "";
  const degraded = /expectedDegraded:\s*([^ ]+)/.exec(meta);
  const down = /expectedDown:\s*([^ ]+)/.exec(meta);
  const services = (degraded ?? down)?.[1]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  return {
    startsAt: match[1],
    endsAt: match[2],
    services,
  };
}

async function buildIncidents(owner, repo, token, knownSlugs, generatedAt) {
  const now = Date.parse(generatedAt);
  const events = [];

  let issues = [];
  try {
    issues = await fetchIssues(owner, repo, token);
  } catch (error) {
    log(`warn: could not fetch issues (${error.message}); incidents.json will be empty`);
    return { events, issuesUnavailable: true };
  }

  for (const issue of issues) {
    const labels = issue.labels ?? [];
    const slug = slugFromLabels(labels, knownSlugs);
    const isIncidentLabel = labels.some(
      (label) => String(label.name ?? label).toLowerCase() === "incident",
    );
    const isMaintenance = labels.some(
      (label) => String(label.name ?? label).toLowerCase() === "maintenance",
    );

    if (isMaintenance) {
      const meta = maintenanceMeta(issue.body);
      if (!meta) continue;
      const startsAt = clampTimestamp(meta.startsAt, 0, now);
      let endsAt = clampTimestamp(meta.endsAt, startsAt, now);
      if (issue.state === "closed") endsAt = Math.min(endsAt, now);
      if (endsAt <= startsAt) continue;
      const state =
        endsAt <= now ? "completed" : startsAt <= now ? "active" : "scheduled";
      const id = `maintenance-${issue.number}`;
      if (!IDENTIFIER_PATTERN.test(id)) continue;
      events.push({
        id,
        kind: "maintenance",
        state,
        title: issue.title || `Scheduled maintenance #${issue.number}`,
        summary: issue.body ?? "",
        affectedServiceIds: meta.services.filter((service) =>
          knownSlugs.includes(service.toLowerCase()),
        ),
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
      });
      continue;
    }

    if (!slug && !isIncidentLabel) continue;
    const affectedServiceIds = slug ? [slug] : [];
    if (isIncidentLabel && affectedServiceIds.length === 0) continue;
    const startsAt = clampTimestamp(issue.created_at, 0, now);
    const endedAt =
      issue.state === "closed" && issue.closed_at
        ? clampTimestamp(issue.closed_at, startsAt, now)
        : null;
    const id = `incident-${issue.number}`;
    if (!IDENTIFIER_PATTERN.test(id)) continue;
    events.push({
      id,
      kind: "incident",
      state: endedAt === null ? "open" : "resolved",
      title: issue.title || `Incident #${issue.number}`,
      summary: issue.body ?? "",
      affectedServiceIds,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: endedAt === null ? null : new Date(endedAt).toISOString(),
    });
  }

  events.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  return { events, issuesUnavailable: false };
}

// ── Contract validation mirrors of @velvet/contracts ────────────────────────
function assertIdentifier(value, path) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 64 ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    fail(`invalid identifier at ${path}: "${value}"`);
  }
}

function validateStatusDocument(document) {
  if (document.schemaVersion !== 1) {
    fail("status document schemaVersion must be 1");
  }
  if (Date.parse(document.monitoringStartedAt) > Date.parse(document.generatedAt)) {
    fail("status document monitoringStartedAt must not be after generatedAt");
  }
  const firstMonitoringDate = document.monitoringStartedAt.slice(0, 10);
  const generatedDate = document.generatedAt.slice(0, 10);
  const serviceIds = new Set();
  for (const service of document.services) {
    assertIdentifier(service.id, `/services/${service.id}/id`);
    if (serviceIds.has(service.id)) {
      fail(`duplicate service id: ${service.id}`);
    }
    serviceIds.add(service.id);
    if (typeof service.name !== "string" || service.name.length < 1) {
      fail(`service ${service.id} must have a name`);
    }
    const checkIds = new Set();
    for (const check of service.checks) {
      assertIdentifier(check.id, `/services/${service.id}/checks/${check.id}/id`);
      if (checkIds.has(check.id)) {
        fail(`duplicate check id in service ${service.id}: ${check.id}`);
      }
      checkIds.add(check.id);
      if (check.checkedAt !== null && !isValidTimestamp(check.checkedAt)) {
        fail(`service ${service.id} check ${check.id}: invalid checkedAt`);
      }
    }
    for (const day of service.dailyAvailability) {
      if (day.date < firstMonitoringDate || day.date > generatedDate) {
        fail(
          `service ${service.id}: daily availability ${day.date} outside monitoring period`,
        );
      }
      const dayStartsAt = Date.parse(`${day.date}T00:00:00.000Z`);
      const dayEndsAt = dayStartsAt + DAY_MS;
      const monitoredStartsAt = Math.max(dayStartsAt, Date.parse(document.monitoringStartedAt));
      const monitoredEndsAt = Math.min(dayEndsAt, Date.parse(document.generatedAt));
      const maximumMonitoredSeconds = Math.max(
        0,
        Math.floor((monitoredEndsAt - monitoredStartsAt) / 1000),
      );
      if (day.monitoredSeconds > maximumMonitoredSeconds) {
        fail(
          `service ${service.id}: day ${day.date} monitoredSeconds ${day.monitoredSeconds} exceeds window ${maximumMonitoredSeconds}`,
        );
      }
      if (day.unavailableSeconds > day.monitoredSeconds) {
        fail(
          `service ${service.id}: day ${day.date} unavailableSeconds exceeds monitoredSeconds`,
        );
      }
    }
  }
}

function validateResponseTimesDocument(document) {
  if (document.schemaVersion !== 1) {
    fail("response-times document schemaVersion must be 1");
  }
  const monitoringStartedAt = Date.parse(document.monitoringStartedAt);
  const generatedAt = Date.parse(document.generatedAt);
  const seriesIds = new Set();
  for (const series of document.series) {
    assertIdentifier(series.serviceId, `/series/${series.serviceId}/serviceId`);
    assertIdentifier(series.checkId, `/series/${series.serviceId}/${series.checkId}/checkId`);
    const seriesId = `${series.serviceId}\u0000${series.checkId}`;
    if (seriesIds.has(seriesId)) {
      fail(`duplicate response-time series: ${series.serviceId}/${series.checkId}`);
    }
    seriesIds.add(seriesId);
    let previousTimestamp = monitoringStartedAt - 1;
    const timestamps = new Set();
    for (const sample of series.samples) {
      if (timestamps.has(sample.timestamp)) {
        fail(`duplicate sample timestamp: ${sample.timestamp}`);
      }
      timestamps.add(sample.timestamp);
      const timestamp = Date.parse(sample.timestamp);
      if (
        timestamp < monitoringStartedAt ||
        timestamp > generatedAt ||
        timestamp <= previousTimestamp
      ) {
        fail(
          `sample timestamp out of order or range: ${sample.timestamp} (${series.serviceId})`,
        );
      }
      previousTimestamp = timestamp;
    }
  }
}

function validateIncidentsDocument(document) {
  if (document.schemaVersion !== 1) {
    fail("incidents document schemaVersion must be 1");
  }
  const generatedAt = Date.parse(document.generatedAt);
  const eventIds = new Set();
  for (const event of document.events) {
    assertIdentifier(event.id, `/events/${event.id}/id`);
    if (eventIds.has(event.id)) {
      fail(`duplicate event id: ${event.id}`);
    }
    eventIds.add(event.id);
    const startsAt = Date.parse(event.startsAt);
    const endsAt = event.endsAt === null ? null : Date.parse(event.endsAt);
    if (event.kind === "incident") {
      if ((event.state === "open" && endsAt !== null) || (event.state === "resolved" && endsAt === null)) {
        fail(`event ${event.id}: incident state and end timestamp inconsistent`);
      }
      if (startsAt > generatedAt || (endsAt !== null && endsAt > generatedAt)) {
        fail(`event ${event.id}: incident timestamps later than generation time`);
      }
    }
    if (event.kind === "maintenance") {
      const invalid =
        (event.state === "scheduled" && startsAt <= generatedAt) ||
        (event.state === "active" && startsAt > generatedAt) ||
        (event.state === "active" && endsAt <= generatedAt) ||
        (event.state === "completed" && endsAt > generatedAt);
      if (invalid) {
        fail(`event ${event.id}: maintenance state inconsistent with generation time`);
      }
    }
    if (endsAt !== null && endsAt < startsAt) {
      fail(`event ${event.id}: cannot end before it starts`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
// Reuse the previously written generatedAt when the document content is
// otherwise unchanged, keeping exports byte-stable between data updates.
function stableDocument(path, document) {
  if (!existsSync(path)) return document;
  let previous;
  try {
    previous = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return document;
  }
  const { generatedAt: previousGeneratedAt } = previous;
  if (typeof previousGeneratedAt !== "string") return document;
  const current = { ...document, generatedAt: undefined };
  const existing = { ...previous, generatedAt: undefined };
  return JSON.stringify(current) === JSON.stringify(existing)
    ? { ...document, generatedAt: previousGeneratedAt }
    : document;
}

async function main() {
  const summaryPath = join(HISTORY_DIR, "summary.json");
  if (!existsSync(summaryPath)) {
    fail(`missing ${summaryPath}; run this from the repository root`);
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const generatedAt = new Date().toISOString();

  const owner = process.env.GITHUB_REPOSITORY?.split("/")[0];
  const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

  const services = [];
  const series = [];
  let monitoringStartedAt = null;

  for (const entry of summary) {
    const slug = String(entry.slug ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) {
      log(`warn: skipping service without a slug: ${entry.name ?? "?"}`);
      continue;
    }
    const samples = historySamples(slug);
    if (samples.length === 0) {
      log(`warn: no history samples for ${slug}; emitting check without data`);
    }
    const startTime = samples
      .map((sample) => sample.startTime)
      .filter(isValidTimestamp)
      .sort()[0];
    const serviceStart = startTime ?? samples[0]?.lastUpdated ?? generatedAt;
    if (monitoringStartedAt === null || Date.parse(serviceStart) < Date.parse(monitoringStartedAt)) {
      monitoringStartedAt = serviceStart;
    }

    const status = STATUS_MAP[String(entry.status ?? "").toLowerCase()] ?? "unknown";
    const latest = samples.at(-1);
    const availability = dailyAvailability(samples, generatedAt);

    services.push({
      id: slug,
      name: entry.name,
      status,
      checks: [
        {
          id: `${slug}-ipv4`,
          protocol: "ipv4",
          status,
          checkedAt: latest?.lastUpdated ?? null,
          responseTimeMs:
            typeof latest?.responseTime === "number" && latest.responseTime >= 0
              ? latest.responseTime
              : null,
        },
      ],
      dailyAvailability: availability,
    });

    series.push({
      serviceId: slug,
      checkId: `${slug}-ipv4`,
      protocol: "ipv4",
      samples: responseSamples(samples, generatedAt),
    });
  }

  if (monitoringStartedAt === null) monitoringStartedAt = generatedAt;

  let incidents;
  if (owner && repo) {
    incidents = await buildIncidents(
      owner,
      repo,
      token,
      summary.map((entry) => String(entry.slug ?? "")),
      generatedAt,
    );
  } else {
    log("warn: GITHUB_REPOSITORY not set; incidents.json will be empty");
    incidents = { events: [], issuesUnavailable: true };
  }

  const statusDocument = {
    schemaVersion: 1,
    generatedAt,
    monitoringStartedAt,
    services,
  };
  const responseTimesDocument = {
    schemaVersion: 1,
    generatedAt,
    monitoringStartedAt,
    series,
  };
  const incidentsDocument = {
    schemaVersion: 1,
    generatedAt,
    events: incidents.events,
  };

  validateStatusDocument(statusDocument);
  validateResponseTimesDocument(responseTimesDocument);
  validateIncidentsDocument(incidentsDocument);

  mkdirSync(OUT_DIR, { recursive: true });
  const files = {
    "status.json": statusDocument,
    "response-times.json": responseTimesDocument,
    "incidents.json": incidentsDocument,
  };
  for (const [fileName, document] of Object.entries(files)) {
    const path = join(OUT_DIR, fileName);
    // Keep the previous generatedAt when nothing else changed, so an unchanged
    // export produces no diff and the velvet-data workflow only commits on real
    // data changes (not every five minutes).
    writeFileSync(path, `${JSON.stringify(stableDocument(path, document), null, 2)}\n`);
    log(`wrote ${path}`);
  }

  const sampleCount = series.reduce((total, entry) => total + entry.samples.length, 0);
  log(
    `status: ${services.length} services, ${series.length} series (${sampleCount} samples), ${incidents.events.length} events, issues ${incidents.issuesUnavailable ? "unavailable" : "ok"}`,
  );
}

main().catch((error) => {
  console.error(`velvet-export: ${error.stack ?? error}`);
  process.exit(1);
});
