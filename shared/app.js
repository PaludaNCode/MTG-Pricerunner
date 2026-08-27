// Page bootstrap for the cloud static site.
// The page sets window.DASH = { url, cmUrl?, intervalMs, showSrc?, quietStartHour?,
// quietEndHour? } before including
// this script. `url` is the CardTrader feed (refreshed every couple of minutes) and
// `cmUrl` the Cardmarket one (only ever refreshed on demand, so usually unchanged) — two
// files because the two workflows publish independently to their own branches.
// showSrc: false hides the Src column — useful if the data ever has a single source.
(function () {
  const cfg = window.DASH || {};
  const $ = (id) => document.getElementById(id);

  const bust = (u) => u + (u.includes("?") ? "&" : "?") + "t=" + Date.now();
  const load = async (u) => (u ? (await fetch(bust(u))).json() : null);

  // ---- The credit ledger is only true for the day it was written on ----------------
  // cardmarket.json is rewritten only when a Cardmarket run happens, and nothing starts
  // that workflow on a timer — it costs credits, so it waits for a human. So after
  // 00:00 UTC the published `meta` still carries *yesterday's* `day` and `credits`,
  // while the fetcher's own counters (which gate on the UTC day) have already reset.
  // Reading those numbers as today's mislabelled the rail, and — worse — let
  // budgetState() grey out ↻ CM on a morning when the full allowance was available,
  // blocking the one action that would rewrite the stale figure.
  //
  // Everything day-scoped therefore reads the ledger through here: past the UTC
  // boundary `credits` and `scrapes` come back 0, because that is what has been spent
  // today. `allowance`, `remaining` and `costPerScrape` are plan-level rather than
  // day-level, so they are kept as published (the next run recomputes them) — they just
  // must never be combined with a spend from another day. `stale` carries the fact
  // onwards for the wording; a ledger with no `day` at all is left alone.
  const utcDay = (t) => new Date(t).toISOString().slice(0, 10);

  // The overnight quiet window, mirroring inQuietHours() in cloud/fetch-cardmarket.js —
  // the workflow is the enforcement, this is only the explanation. Duplicated rather
  // than shared because a fifth page script would break the deploy workflow's
  // four-asset cache-bust stamp (see test/deploy-stamp.test.js); if you change the hours
  // in config.json, change them here too.
  // Overridable through window.DASH so the browser checks can pin the window instead of
  // depending on what time CI happens to run — without that, every existing assertion
  // about an armed button would fail between 00:00 and 08:00 UTC.
  const QUIET_START_HOUR = cfg.quietStartHour != null ? cfg.quietStartHour : 0;
  const QUIET_END_HOUR = cfg.quietEndHour != null ? cfg.quietEndHour : 8;
  function inQuietHours(now) {
    if (QUIET_START_HOUR === QUIET_END_HOUR) return false;
    const hour = new Date(now == null ? Date.now() : now).getUTCHours();
    return QUIET_START_HOUR < QUIET_END_HOUR
      ? hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR
      : hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
  }
  const hh = (h) => String(h).padStart(2, "0") + ":00";
  function dayLedger(meta, now) {
    if (!meta) return null;
    if (!meta.day || meta.day === utcDay(now == null ? Date.now() : now)) return { ...meta, stale: false };
    // The zeroed spend is kept as `priorCredits` so the wording can name what was
    // spent, and when, instead of presenting the 0 with no provenance.
    return { ...meta, scrapes: 0, credits: 0, stale: true, priorCredits: meta.credits || 0 };
  }

  async function refresh() {
    try {
      // Cardmarket must never take the page down with it: the branch may not exist yet,
      // and a failed scrape run is not a reason to hide CardTrader prices.
      const [ct, raw] = await Promise.all([load(cfg.url), load(cfg.cmUrl).catch(() => null)]);
      // A just-finished run is read straight from the branch, because the CDN copy can
      // be up to 5 minutes stale. Prefer it until the CDN catches up, then drop it.
      let cm = raw;
      if (cmFresh) {
        const rawAt = raw && raw.updatedAt ? Date.parse(raw.updatedAt) : 0;
        if (Date.parse(cmFresh.updatedAt) > rawAt) cm = cmFresh;
        else cmFresh = null;
      }
      lastCt = ct;
      lastCm = cm;
      paint();
    } catch (e) {
      // Reported in the rail rather than beside it: a failure is a status, and the
      // header has exactly one place for status now.
      renderRail([{ k: "Status", v: "load failed: " + esc(String(e)), bad: true }]);
    }
  }

  // Everything that turns the two cached feeds into pixels, split out of refresh() so
  // the source filter and the selection buttons can repaint instantly — both are pure
  // client-side state, and refetching both files to apply them would be a round trip
  // for nothing (and would make the ticks flicker on a slow connection).
  function paint() {
    const ct = lastCt;
    const cm = lastCm;
    const data = {
      updatedAt: ct && ct.updatedAt,
      results: [...((ct && ct.results) || []), ...((cm && cm.results) || [])],
    };
    const { totalOffers } = CardUI.renderGrid(data, {
      showShips: true,
      // With one source on screen every row's Src cell would say the same thing, so the
      // column goes and its width is handed to Set (see body.one-source in ui.css).
      showSrc: cfg.showSrc !== false && source === "all",
      source,
      selectable: !!cfg.dispatch,
      selected: picks,
      pending,
      cardmarketCards: (ct && ct.meta && ct.meta.cardmarketCards) || null,
      onToggle,
    });

    // Set before renderLegend and syncPicks: both report how many cards the selection
    // covers, so assigning afterwards left them a poll behind.
    allCards = (ct && ct.meta && ct.meta.cardmarketCards) || [];
    lastMeta = dayLedger(cm && cm.meta);
    // Remembered so a manual refresh can tell when a genuinely new snapshot lands.
    window.__cmUpdatedAt = cm && cm.updatedAt;

    paintStats(data, totalOffers, lastMeta);
    renderLegend(lastMeta);
    syncButton();
    syncPicks();
  }

  const esc = (v) =>
    String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // The header's status rail. Built as data, not as a string, so a fact that does not
  // exist yet is simply not emitted — "CM balance" only appears once a run has read the
  // Firecrawl balance — and so nothing can wrap into the middle of a clause.
  function paintStats(data, totalOffers, meta) {
    const at = data.updatedAt ? new Date(data.updatedAt) : null;
    const now = new Date();
    const sameDay = at && at.toDateString() === now.toDateString();
    renderRail([
      // The date is dropped on a same-day snapshot and kept otherwise; the tooltip
      // always carries the full stamp. The stale form also loses its seconds, because
      // the full locale string wraps the field to two lines at 320px — and a stale
      // feed is exactly when the header must stay readable.
      at
        ? {
            k: "Updated",
            v: sameDay
              ? at.toLocaleTimeString()
              : at.toLocaleDateString() + " " + at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            t: at.toLocaleString(),
          }
        : { k: "Updated", v: "starting…" },
      { k: "Offers", v: String(totalOffers) },
      ...cmFields(meta),
    ]);
  }

  // What the rail says about Cardmarket. Deliberately NOT the age of cardmarket.json:
  // that file is rewritten by every run even when the budget scraped nothing, so it
  // would read "0m" while every card on screen was days old. Credit spend is the honest
  // global number; per-card ages live on the cards themselves.
  function cmFields(m) {
    if (!m) return [{ k: "Cardmarket", v: "never scraped" }];
    if (m.allowance == null) return [{ k: "CM scrapes", v: (m.scrapes || 0) + '<span class="q"> today</span>' }];
    // A stale ledger reads as a genuine 0 rather than as its own field: the rail is
    // 2x2 at 320px and a fifth field would give it a third row, and "how current is
    // Cardmarket?" is already answered per card by the freshness chips — which is why
    // this field is credit spend and not the file's age. The tooltip says which day
    // the published ledger came from, so the 0 can be told apart from "a run today
    // spent nothing".
    const fields = [{
      k: "CM credits",
      v: (m.credits || 0) + `<span class="q"> / ${Math.round(m.allowance)} today</span>`,
      t: m.stale
        ? `no Cardmarket run yet today — the published ledger is from ${m.day} (${m.priorCredits || 0} credits spent that day, of an allowance since renewed)`
        : "credits spent today of the day's allowance",
    }];
    // The Firecrawl balance, when a run has read it. It is what decides whether the
    // button can spend at all, so it earns a field of its own rather than a parenthesis.
    // Named "CM balance" rather than "Balance": on a page with prices all over it, a
    // lone "Balance" reads like money owed somewhere.
    if (m.remaining != null) fields.push({ k: "CM balance", v: String(m.remaining), t: "Firecrawl credits left on the plan" });
    return fields;
  }

  function renderRail(fields) {
    const el = $("stats");
    if (!el) return;
    el.innerHTML = fields.map((f) =>
      `<div><dt>${esc(f.k)}</dt><dd${f.bad ? ' class="bad"' : ""}${f.t ? ` title="${esc(f.t)}"` : ""}>${f.v}</dd></div>`,
    ).join("");
  }

  // One line explaining the model, because "why is this card 3 days old?" and "what
  // will pressing this cost me?" are otherwise unanswerable from the page.
  function renderLegend(m) {
    const el = $("legend");
    if (!el) return;
    const cost = m && m.costPerScrape;
    const left = m && m.allowance != null ? Math.max(0, m.allowance - (m.credits || 0)) : null;
    const affordable = left != null && cost ? Math.floor(left / cost) : null;
    el.innerHTML =
      '<span class="label">Cardmarket is scraped only when you ask.</span> ' +
      "Nothing refreshes it on a timer — it costs credits, so it waits for you. " +
      (cfg.dispatch ? "Tick the cards you want, then press ↻ CM. " : "") +
      "The chip on each card shows how long ago that card was last scraped" +
      (affordable != null
        ? `, and today's budget still covers about <b>${affordable} card${affordable === 1 ? "" : "s"}</b>.`
        : ". CardTrader keeps updating on its own, for free.") +
      // Reading the balance is not billed, so this is genuinely free — worth offering,
      // since otherwise the only way to refresh that figure is to spend credits.
      (cfg.dispatch && getToken()
        ? ' · <a href="#" id="cm-balance">Check credit balance</a> <span class="muted">(free)</span>'
        : "");
  }

  // ---- On-demand Cardmarket refresh ------------------------------------------------
  // Triggering a workflow needs a GitHub PAT with Actions: write. This site is public,
  // so the token can never be baked into the page — it is typed once and kept in this
  // browser's localStorage, meaning the button only works for whoever holds a token.
  // Visitors without one can look but not spend.
  const TOKEN_KEY = "mtg-pricerunner.gh-token";
  // Which cards the next on-demand refresh should spend credits on. Empty = all of
  // them, rotated stalest-first by the fetcher.
  const PICKS_KEY = "mtg-pricerunner.cm-picks";
  const picks = new Set(loadPicks());

  // Which feed the grid shows. Remembered across visits like the picks are: the strip
  // always states the active mode, so a filter left on CM can't turn into a mystery
  // about where the CardTrader prices went.
  const SOURCE_KEY = "mtg-pricerunner.source";
  const SOURCES = ["all", "cardtrader", "cardmarket"];
  let source = SOURCES.includes(localStorage.getItem(SOURCE_KEY)) ? localStorage.getItem(SOURCE_KEY) : "all";

  function loadPicks() {
    try {
      const raw = JSON.parse(localStorage.getItem(PICKS_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }
  function savePicks() {
    localStorage.setItem(PICKS_KEY, JSON.stringify([...picks]));
  }
  function onToggle(group, checked) {
    if (checked) picks.add(group);
    else picks.delete(group);
    savePicks();
    syncButton();
    syncPicks();
  }

  const btn = $("cm-refresh");
  const tokenInput = $("cm-token");
  const tokenToggle = $("cm-token-toggle");
  const srcFilter = $("src-filter");
  const allBtn = $("cm-all");
  const noneBtn = $("cm-none");
  const pickCount = $("pick-count");
  let polling = false;
  let lastMeta = null;
  // The two feeds as last fetched, so paint() can redraw without hitting the network.
  let lastCt = null;
  let lastCm = null;
  // Cards the in-flight run is scraping, so they can show a spinner rather than a
  // stale age while the workflow is running.
  let pending = new Set();
  // A copy of cardmarket.json read through the API right after a run, ahead of the CDN.
  let cmFresh = null;
  // Every Cardmarket-watched card name, from data.json's meta. Used by "Select all" so
  // it covers the configured list, not just the cards currently drawing a table.
  let allCards = [];

  const getToken = () => (localStorage.getItem(TOKEN_KEY) || "").trim();

  // Inline feedback beats alert() here: on a phone the modal covers the field you need
  // to fix, and the message vanishes the moment you dismiss it.
  function notice(html, isError) {
    const el = $("notice");
    if (!el) return;
    el.innerHTML = html;
    el.className = "notice" + (isError ? " err" : "");
    el.hidden = !html;
  }

  // The field is only in the way once a token is stored, so it hides itself then and
  // the ⚿ button brings it back to change or clear it.
  function showTokenField(show, prefill) {
    if (!tokenInput) return;
    tokenInput.hidden = !show;
    if (show) {
      tokenInput.value = prefill ? getToken() : "";
      tokenInput.focus();
    }
  }

  function saveToken() {
    if (!tokenInput) return;
    const v = tokenInput.value.trim();
    // The two keys this project uses look nothing alike, and pasting the wrong one here
    // costs a confusing round-trip to GitHub for a 401. Catch it before that.
    if (/^fc-/i.test(v)) {
      notice(
        "That looks like the <b>Firecrawl</b> key (<code>fc-…</code>). It belongs in the repo's " +
          "GitHub secrets, not here — this field wants a <b>GitHub token</b> " +
          "(<code>github_pat_…</code> or <code>ghp_…</code>) so the page can start the workflow.",
        true,
      );
      return; // leave the field open with the text in it
    }
    if (v) localStorage.setItem(TOKEN_KEY, v);
    else localStorage.removeItem(TOKEN_KEY); // clearing the field forgets the token
    notice("");
    showTokenField(!v, false);
    syncButton();
  }

  const setBtn = (label, disabled, title) => {
    if (!btn) return;
    btn.textContent = label;
    btn.disabled = !!disabled;
    btn.title = title || "";
  };

  // Reflect the published credit ledger: a run with no allowance left would defer every
  // card, so say that instead of letting the button pretend otherwise. `meta` here is
  // always the day-scoped ledger (see dayLedger) — spend from a previous UTC day reads
  // as 0, so a new morning arms the button even though nothing has rewritten the file
  // yet. Doing otherwise disabled the only control that *could* rewrite it.
  function budgetState(meta) {
    if (!meta || meta.allowance == null) return { spent: false, note: "" };
    const used = meta.credits || 0;
    const left = Math.max(0, meta.allowance - used);
    return {
      spent: left < (meta.costPerScrape || 1),
      note: meta.stale
        ? `no credits used today — the last run was ${meta.day}`
        : `${used} of ${Math.round(meta.allowance)} credits used today`,
    };
  }

  // ---- Control strip ----------------------------------------------------------------
  // Source filter (free, client-side) and the selection buttons that used to be a link
  // inside the legend sentence, where they read as prose rather than as controls.

  function syncSource() {
    if (srcFilter) {
      for (const b of srcFilter.querySelectorAll("button[data-src]")) {
        b.setAttribute("aria-pressed", String(b.dataset.src === source));
      }
    }
    document.body.classList.toggle("one-source", source !== "all");
  }

  function setSource(next) {
    if (!SOURCES.includes(next) || next === source) return;
    source = next;
    localStorage.setItem(SOURCE_KEY, source);
    syncSource();
    if (lastCt || lastCm) paint(); // a click before the first fetch has nothing to draw
  }

  // What the selection costs, stated next to the buttons that change it. The estimate
  // matters more than the count: pressing ↻ CM with everything ticked is the most
  // expensive thing this page can do, and it asks for no confirmation.
  function syncPicks() {
    const n = picks.size;
    const total = allCards.length;
    if (pickCount) {
      const cost = lastMeta && lastMeta.costPerScrape;
      // .ctl-more is dropped on phones (ui.css): the words are worth their width on a
      // desktop, but keeping them costs the strip a whole third row on a small screen.
      pickCount.innerHTML = !total
        ? ""
        : n
          ? `<b>${n}</b> of ${total}<span class="ctl-more"> selected</span>` +
            (cost ? ` · ~${Math.round(n * cost)} credits` : "")
          : '<span class="ctl-more">none ticked · </span>stalest first';
    }
    if (allBtn) allBtn.disabled = !total || n >= total;
    if (noneBtn) noneBtn.disabled = !n;
  }

  function setPicks(names) {
    picks.clear();
    for (const g of names) picks.add(g);
    savePicks();
    if (lastCt || lastCm) paint(); // repaints the tick boxes, the count and the button
    else syncPicks();
  }

  // Single place that decides what the button says: mid-run > no token > no budget > ready.
  function syncButton() {
    if (!btn || polling) return;
    const label = picks.size ? `↻ CM (${picks.size})` : "↻ CM";
    if (!getToken()) return setBtn(label, true, "Enter a GitHub token (⚿) to refresh on demand");
    // Ahead of the budget check: inside the window the workflow scrapes nothing whatever
    // the budget says, so offering the button would spend a dispatch on a no-op run.
    if (inQuietHours()) {
      return setBtn(
        "CM quiet hours",
        true,
        `Cardmarket refreshes are off between ${hh(QUIET_START_HOUR)} and ${hh(QUIET_END_HOUR)} UTC` +
          ` — a run started now would scrape nothing. The free balance check still works.`,
      );
    }
    const b = budgetState(lastMeta);
    const scope = picks.size
      ? `Scrape the ${picks.size} ticked card(s)`
      : "Scrape Cardmarket — no cards ticked, so the stalest go first";
    setBtn(
      b.spent ? "CM budget spent" : label,
      b.spent,
      b.spent ? b.note + " — next allowance at 00:00 UTC" : scope + (b.note ? " · " + b.note : ""),
    );
  }

  async function dispatch(inputs) {
    const d = cfg.dispatch;
    const token = getToken();
    if (!token) {
      showTokenField(true, false);
      throw new Error("enter a GitHub token first");
    }
    const res = await fetch(
      `https://api.github.com/repos/${d.repo}/actions/workflows/${d.workflow}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: d.ref || "main", inputs }),
      },
    );
    // 401/403 = the PAT is wrong or expired (they last a year). Drop it so the next
    // click asks again instead of failing forever.
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem(TOKEN_KEY);
      showTokenField(true, false);
      throw new Error(
        "GitHub rejected that token (" + res.status + "). It has been cleared. It needs to be a " +
          "GitHub token with <b>Actions: read and write</b> on this repo — not the Firecrawl key.",
      );
    }
    if (res.status !== 204) throw new Error("dispatch failed: HTTP " + res.status);
  }

  // ---- Watching the actual workflow run --------------------------------------------
  // Polling cardmarket.json alone can only ever say "nothing yet": a crashed run and a
  // slow run look identical for three minutes, then both report a timeout. The token
  // already has Actions read access, so ask GitHub what the run is really doing.
  const gh = async (path) => {
    const d = cfg.dispatch;
    const res = await fetch(`https://api.github.com/repos/${d.repo}${path}`, {
      headers: { Authorization: "Bearer " + getToken(), Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error("GitHub API " + res.status);
    return res.json();
  };

  // A dispatch returns 204 with no run id, so the run has to be found by time. Anything
  // older than the moment we pressed is somebody else's run.
  async function findRun(since, deadline) {
    const d = cfg.dispatch;
    while (Date.now() < deadline) {
      try {
        const j = await gh(`/actions/workflows/${d.workflow}/runs?event=workflow_dispatch&per_page=5`);
        const run = (j.workflow_runs || []).find((r) => Date.parse(r.created_at) >= since - 15000);
        if (run) return run;
      } catch {
        /* transient — keep looking */
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return null;
  }

  const STEP_LABEL = {
    "Set up job": "starting up",
    "Pull the previous cardmarket.json (offers + credit ledger)": "loading the last snapshot",
    "Scrape Cardmarket -> cloud/web/cardmarket.json": "scraping Cardmarket",
    "Publish cardmarket.json to the data-cm branch": "publishing results",
  };

  // Follow the run to completion, reporting each step as it starts. Returns the run.
  async function followRun(run, deadline, onStep) {
    let lastLabel = null;
    while (Date.now() < deadline) {
      let jobs = null;
      try {
        jobs = await gh(`/actions/runs/${run.id}/jobs`);
      } catch {
        /* transient */
      }
      const job = jobs && jobs.jobs && jobs.jobs[0];
      if (job) {
        const running = (job.steps || []).find((st) => st.status === "in_progress");
        const done = (job.steps || []).filter((st) => st.conclusion === "success").length;
        const total = (job.steps || []).length || 1;
        const label = running ? STEP_LABEL[running.name] || running.name : null;
        if (label && label !== lastLabel) {
          lastLabel = label;
          onStep(label, done, total);
        }
        if (job.status === "completed") {
          const failed = (job.steps || []).find((st) => st.conclusion === "failure");
          return { conclusion: job.conclusion, failedStep: failed && failed.name, url: run.html_url };
        }
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return { conclusion: "timed_out", url: run.html_url };
  }

  // Read the published file from the branch itself. The Contents API is authenticated
  // and uncached, unlike raw.githubusercontent, whose 5-minute cache is why a finished
  // run used to report "timed out" — the data was there, the CDN just hadn't caught up.
  async function readPublished() {
    const d = cfg.dispatch;
    if (!d.dataBranch || !d.dataFile) return null;
    const j = await gh(`/contents/${d.dataFile}?ref=${d.dataBranch}`);
    const bytes = Uint8Array.from(atob(String(j.content || "").replace(/\s/g, "")), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)); // card names and € are not ASCII
  }

  async function waitForNewData(before, deadline) {
    while (Date.now() < deadline) {
      try {
        const cm = await readPublished();
        if (cm && cm.updatedAt && cm.updatedAt !== before) return cm;
      } catch {
        /* fall back to the CDN copy below */
      }
      const cdn = await load(cfg.cmUrl).catch(() => null);
      if (cdn && cdn.updatedAt && cdn.updatedAt !== before) return cdn;
      await new Promise((r) => setTimeout(r, 3000));
    }
    return null;
  }

  const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

  // Both buttons drive the same workflow and differ only in inputs and wording, so
  // they share the run-following: dispatch, find the run, narrate its steps, read the
  // result. `balance` scrapes nothing and costs nothing.
  async function onRefresh(mode) {
    if (polling) return;
    polling = true;
    const balance = mode === "balance";
    const before = window.__cmUpdatedAt || null;
    const startedAt = Date.now();
    const deadline = startedAt + 300000; // 5 min: a queued runner can sit a while
    const wanted = picks.size ? plural(picks.size, "card") : "the stalest cards";
    try {
      notice(
        balance
          ? "<b>1/4</b> Asking GitHub to read the Firecrawl balance… <span class=\"muted\">(no scraping, no credits)</span>"
          : `<b>1/4</b> Asking GitHub to start a scrape of ${wanted}…`,
      );
      setBtn(balance ? "↻ CM" : "dispatching…", true);
      await dispatch(
        balance
          ? { force: "false", cards: "", balance_only: "true" }
          : { force: "true", cards: [...picks].join(","), balance_only: "false" },
      );

      pending = balance ? new Set() : new Set(picks);
      await refresh();
      setBtn("queued…", true);
      notice(`<b>2/4</b> Request accepted. Waiting for a runner to pick it up…`);

      const run = await findRun(startedAt, Math.min(deadline, Date.now() + 60000));
      if (!run) {
        throw new Error(
          "GitHub accepted the request but no run appeared within a minute. " +
            "Check the <a href=\"https://github.com/" + cfg.dispatch.repo + "/actions\" target=\"_blank\">Actions tab</a>.",
        );
      }

      const link = `<a href="${run.html_url}" target="_blank">run #${run.run_number}</a>`;
      if (!balance) setBtn("scraping…", true, "Cardmarket scrape running");
      const result = await followRun(run, deadline, (label, done, total) => {
        notice(`<b>3/4</b> ${link} is running — ${label} <span class="muted">(step ${done + 1} of ${total})</span>`);
      });

      if (result.conclusion !== "success") {
        const why = result.conclusion === "timed_out"
          ? "is still going after 5 minutes"
          : `failed at <b>${result.failedStep || "an unknown step"}</b>`;
        throw new Error(`The ${balance ? "balance check" : "scrape"} ${why}. Open ${link} for the log.`);
      }

      notice(`<b>4/4</b> ${balance ? "Balance read" : "Scrape finished"}. Fetching the result…`);
      const cm = await waitForNewData(before, Date.now() + 90000);
      cmFresh = cm; // show it now; the CDN may still be serving the old copy
      pending = new Set();
      polling = false;
      await refresh();

      if (!cm) {
        notice(
          `${link} succeeded, but the new snapshot has not reached the CDN yet. ` +
            "It should appear within a minute or two — the page keeps checking.",
        );
      } else if (balance) {
        const m = dayLedger(cm.meta) || {};
        notice(
          `<b>${m.remaining != null ? m.remaining : "?"} credits left</b> on the Firecrawl plan · ` +
            `${m.credits || 0} spent today of an allowance of ${Math.round(m.allowance || 0)}` +
            (m.costPerScrape ? ` · about ${m.costPerScrape} credit per card` : "") +
            ". <span class=\"muted\">Nothing was scraped.</span>",
        );
      } else {
        const m = dayLedger(cm.meta) || {};
        const scraped = cm.results.filter((r) => r.fetchedAt && Date.parse(r.fetchedAt) >= startedAt - 60000);
        const offers = scraped.reduce((a, r) => a + (r.offers || []).length, 0);
        const empty = scraped.filter((r) => !(r.offers || []).length).map((r) => r.group);
        notice(
          `<b>Done.</b> Refreshed ${plural(scraped.length, "card")} in ` +
            `${Math.round((Date.now() - startedAt) / 1000)}s, ${plural(offers, "offer")} found` +
            (m.credits != null ? ` · spent ${plural(m.credits, "credit")} today` : "") +
            (m.remaining != null ? `, ${m.remaining} left on the plan` : "") +
            (empty.length ? `<br><span class="muted">No Japanese listings right now: ${empty.join(", ")}</span>` : ""),
        );
      }
    } catch (e) {
      pending = new Set();
      polling = false;
      syncButton();
      notice(String(e.message || e), true);
    } finally {
      pending = new Set();
      polling = false;
    }
  }

  // The filter works with or without a token: looking at one source costs nothing.
  if (srcFilter) {
    srcFilter.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-src]");
      if (b) setSource(b.dataset.src);
    });
  }
  syncSource();

  if (btn && cfg.dispatch) {
    btn.addEventListener("click", () => onRefresh("scrape"));
    if (allBtn) allBtn.addEventListener("click", () => setPicks(allCards));
    if (noneBtn) noneBtn.addEventListener("click", () => setPicks([]));
    // Delegated: renderLegend rewrites that element on every poll, so a handler bound
    // to the link itself would be thrown away a minute later.
    const legendEl = $("legend");
    if (legendEl) {
      legendEl.addEventListener("click", (e) => {
        if (e.target && e.target.id === "cm-balance") {
          e.preventDefault();
          onRefresh("balance");
        }
      });
    }
    if (tokenToggle) {
      tokenToggle.addEventListener("click", () => showTokenField(tokenInput.hidden, true));
    }
    if (tokenInput) {
      // Enter commits; blur commits too, so a click straight onto ↻ CM still works.
      tokenInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); saveToken(); }
        if (e.key === "Escape") showTokenField(false, false);
      });
      tokenInput.addEventListener("blur", saveToken);
      // No token yet? Lead with the field rather than a disabled button and no clue why.
      if (!getToken()) tokenInput.hidden = false;
    }
    syncButton();
    syncPicks();
  } else {
    // No dispatch target configured: nothing here can spend credits, so the whole
    // right-hand half of the strip goes. The source filter stays — it is free.
    const group = $("cm-group");
    if (group) group.hidden = true;
  }

  refresh();
  setInterval(refresh, cfg.intervalMs || 60000);
})();
