// External scheduler for the status-page monitoring workflows.
//
// GitHub's cron scheduler delivers schedule events irregularly (often 1-2h+
// gaps instead of 5 min), so this Worker fires repository_dispatch events
// directly: GitHub delivers those promptly, giving us real ~10 min checks
// (uptime) and ~30 min page freshness (response_time).
//
//   * /10 * * * * -> uptime         (endpoint checks; Upptime only commits on
//                                    status change, so no commit churn)
//   * /30 * * * * -> response_time  (fresh samples -> velvet-data docs ->
//                                    page "Last updated" moves)
//
// Secret: GITHUB_TOKEN = classic PAT with `repo` scope (wrangler secret put).
// The same token gates manual triggers so strangers cannot burn Actions runs.

const REPO = "Audaxic/status-page";

const CRON_EVENT_TYPES = {
  "*/10 * * * *": "uptime",
  "*/30 * * * *": "response_time",
};

async function dispatch(eventType, token) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "status-page-dispatch",
    },
    body: JSON.stringify({ event_type: eventType }),
  });
  return response.status;
}

function isAuthorized(request, token) {
  return request.headers.get("Authorization") === `Bearer ${token}`;
}

export default {
  async scheduled(event, env, ctx) {
    const eventType = CRON_EVENT_TYPES[event.cron];
    if (!eventType) {
      console.warn(`status-page-dispatch: unmapped cron ${event.cron}`);
      return;
    }
    const status = await dispatch(eventType, env.GITHUB_TOKEN);
    console.log(`status-page-dispatch: ${eventType} -> ${status}`);
    if (status >= 500) {
      ctx.waitUntil(
        new Promise((resolve) => setTimeout(resolve, 30_000))
          .then(() => dispatch(eventType, env.GITHUB_TOKEN))
          .then((retryStatus) =>
            console.log(`status-page-dispatch: ${eventType} retry -> ${retryStatus}`),
          ),
      );
    }
  },

  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    if (!isAuthorized(request, env.GITHUB_TOKEN)) {
      return new Response("unauthorized", { status: 401 });
    }
    const type = new URL(request.url).searchParams.get("type");
    if (type !== "uptime" && type !== "response_time") {
      return new Response("unknown type; use ?type=uptime|response_time", {
        status: 400,
      });
    }
    const status = await dispatch(type, env.GITHUB_TOKEN);
    return new Response(`dispatch ${type}: ${status}`, {
      status: status === 204 ? 200 : 502,
    });
  },
};
