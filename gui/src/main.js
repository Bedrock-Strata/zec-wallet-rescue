function invoke(...args) {
  return window.__TAURI__.core.invoke(...args);
}
function listen(...args) {
  return window.__TAURI__.event.listen(...args);
}

document.addEventListener("DOMContentLoaded", () => {

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  scanHandle: null,
  lastProgress: null,
  sweepProposal: null,
  destination: null,
  memo: null,
  maxFeeZec: null,
  unlistenProgress: null,
  unlistenComplete: null,
  unlistenDiscovered: null,
  // Multi-seed scan tracking
  seedLabels: new Map(), // seed_index -> label string for discovery feed grouping
  seedDiscoveryCounts: new Map(), // seed_index -> count
  scanTerminalHandled: false,
  notifiedTerminal: false,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const fmt = (n) => (Number(n) / 1e8).toFixed(8) + " ZEC";

function phaseLabel(phase) {
  const labels = {
    idle: "Idle",
    validating_seed: "Validating seed…",
    deriving_keys: "Deriving keys…",
    probing_lightwalletd: "Probing lightwalletd…",
    scanning_transparent: "Scanning transparent…",
    scanning_shielded: "Scanning shielded…",
    complete: "Complete ✓",
    cancelled: "Cancelled",
    error: "Error",
  };
  return labels[phase] ?? phase;
}

function setStatus(id, msg, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.className = "status-line" + (kind ? ` ${kind}` : "");
}

function fmtSeconds(s) {
  if (s == null) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

// Friendly, deliberately imprecise ETA banding. Mirrors `format_eta_range` in
// zeck-cli; if you change one, change both.
function formatEtaRange(secs) {
  if (secs == null || !Number.isFinite(secs) || secs < 0) return null;
  if (secs < 60) return "less than a minute remaining";
  if (secs < 5 * 60) return "less than 5 minutes remaining";
  if (secs < 30 * 60) {
    const mins = Math.round(secs / 60 / 5) * 5;
    return `about ${mins} minutes remaining`;
  }
  if (secs < 60 * 60) return "less than an hour remaining";
  const hours = secs / 3600;
  if (hours < 2) return "about 1-2 hours remaining";
  const lo = Math.floor(hours);
  return `about ${lo}-${lo + 1} hours remaining`;
}

// Map a block height to its approximate calendar year on mainnet so users can
// feel the scan moving through time. Mirrors `era_hint` in zeck-cli.
function eraHint(height) {
  if (!height) return null;
  const SAPLING_HEIGHT = 419_200;
  const SAPLING_YEAR = 2018;
  const SECONDS_PER_BLOCK = 82;
  if (height < SAPLING_HEIGHT) return "pre-Sapling era";
  const elapsedSecs = (height - SAPLING_HEIGHT) * SECONDS_PER_BLOCK;
  const elapsedYears = elapsedSecs / (365.25 * 86400);
  return String(SAPLING_YEAR + Math.floor(elapsedYears + 0.18));
}

// Sliding-window ETA tracker — see `EtaTracker` in zeck-cli.
const eta = (() => {
  const WINDOW_MS = 45_000;
  const WARMUP_MS = 15_000;
  let samples = [];
  let lastTotal = 0;
  let startedAt = null;

  return {
    reset() {
      samples = [];
      lastTotal = 0;
      startedAt = performance.now();
    },
    observe(scanned, total) {
      if (!total) return;
      lastTotal = total;
      const now = performance.now();
      samples.push([now, scanned]);
      const cutoff = now - WINDOW_MS;
      while (samples.length > 2 && samples[0][0] < cutoff) samples.shift();
    },
    estimate() {
      if (startedAt == null || samples.length < 2 || !lastTotal) return { kind: "warmup" };
      const elapsed = performance.now() - startedAt;
      const [tFirst, blocksFirst] = samples[0];
      const [tLast, blocksLast] = samples[samples.length - 1];
      const remaining = lastTotal - blocksLast;
      if (remaining <= 0) return { kind: "done" };
      const windowMs = tLast - tFirst;
      const scannedInWindow = blocksLast - blocksFirst;
      if (elapsed < WARMUP_MS || windowMs < 5_000 || scannedInWindow < 50) {
        return { kind: "warmup" };
      }
      const rate = scannedInWindow / (windowMs / 1000);
      if (rate <= 0) return { kind: "warmup" };
      const secs = Math.round(remaining / rate);
      return { kind: "range", text: formatEtaRange(secs) };
    },
  };
})();

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── Navigation ───────────────────────────────────────────────────────────────

const steps = ["welcome", "seed", "config", "scan", "sweep", "complete"];
let furthestStep = 0; // tracks how far the user has reached

function goTo(step) {
  const stepIdx = steps.indexOf(step);
  if (stepIdx > furthestStep) furthestStep = stepIdx;

  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.querySelectorAll(".step-list li").forEach((li) => {
    const s = li.dataset.stepIndicator;
    const liIdx = steps.indexOf(s);
    li.classList.remove("active", "complete", "reachable");
    if (liIdx < stepIdx) li.classList.add("complete");
    if (liIdx === stepIdx) li.classList.add("active");
    if (liIdx <= furthestStep) li.classList.add("reachable");
  });
  const screen = document.querySelector(`.screen[data-step="${step}"]`);
  if (screen) screen.classList.add("active");
}

// Make sidebar steps clickable — only allow jumping to already-reached steps
document.querySelectorAll(".step-list li").forEach((li) => {
  li.style.cursor = "pointer";
  li.addEventListener("click", () => {
    const target = li.dataset.stepIndicator;
    const targetIdx = steps.indexOf(target);
    if (targetIdx <= furthestStep) {
      if (target === "config") {
        updateUI();
        setStatus("config-status", "", "");
      }
      goTo(target);
    } else {
      // Show a brief tooltip on the step that can't be reached yet
      const prev = steps[targetIdx - 1];
      const prevLabel = li.parentElement.querySelector(`[data-step-indicator="${prev}"]`);
      const originalText = li.textContent;
      li.textContent = "Complete previous steps first";
      setTimeout(() => { li.textContent = originalText; }, 1800);
    }
  });
});

document.querySelectorAll("[data-next]").forEach((btn) => {
  btn.addEventListener("click", () => goTo(btn.dataset.next));
});

document.querySelectorAll("[data-prev]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.prev === "config") {
      updateUI();
      setStatus("config-status", "", "");
    }
    goTo(btn.dataset.prev);
  });
});

// ─── Step 2: Seed Entry (multi-row) ───────────────────────────────────────────

const seedVisibility = $("seed-visibility");
const seedNextBtn = $("seed-next");
const seedRowsContainer = $("seed-rows");

// Per-row validation state keyed by row id. A row is "ready" when its phrase
// has been validated successfully. The seedNext / start-scan buttons enable
// only when at least one row is ready and no row holds invalid input.
const rowState = new Map(); // id -> { valid: bool, validating: bool }
let rowSeq = 0;

function rowsAll() {
  return Array.from(seedRowsContainer.querySelectorAll(".seed-row"));
}

function rowById(id) {
  return seedRowsContainer.querySelector(`.seed-row[data-row-id="${id}"]`);
}

function setRowStatus(row, msg, kind) {
  const el = row.querySelector(".seed-row-status");
  if (!el) return;
  el.textContent = msg;
  el.className = "seed-row-status status-line" + (kind ? ` ${kind}` : "");
}

function applyMaskingToRow(row) {
  row.querySelector(".seed-row-phrase").classList.toggle("masked", !seedVisibility.checked);
}

function updateUI() {
  const rows = rowsAll();
  rows.forEach((row, idx) => {
    row.querySelector(".seed-row-index").textContent = `Seed #${idx + 1}`;
    const removeBtn = row.querySelector(".seed-row-remove");
    removeBtn.style.visibility = rows.length > 1 ? "visible" : "hidden";
  });
  seedRowsContainer.dataset.rowCount = String(rows.length);

  // Enable Continue / Start scan only when at least one row is valid and
  // none are mid-validation. Empty rows are ignored.
  let anyValid = false;
  let anyInvalidNonEmpty = false;
  for (const row of rows) {
    const id = row.dataset.rowId;
    const st = rowState.get(id);
    const phrase = row.querySelector(".seed-row-phrase").value.trim();
    if (!phrase) continue;
    if (st?.valid) anyValid = true;
    else anyInvalidNonEmpty = true;
  }
  const canProceed = anyValid && !anyInvalidNonEmpty;
  seedNextBtn.disabled = !canProceed;
  const startBtn = $("start-scan");
  if (startBtn) startBtn.disabled = !canProceed;
}

async function validateRow(id) {
  const row = rowById(id);
  if (!row) return;
  const phrase = row.querySelector(".seed-row-phrase").value.trim();
  if (!phrase) {
    rowState.set(id, { valid: false, validating: false });
    setRowStatus(row, "", "");
    updateUI();
    return;
  }
  const words = phrase.toLowerCase().split(/\s+/);
  rowState.set(id, { valid: false, validating: true });
  setRowStatus(row, "Validating…", "");
  updateUI();
  try {
    await invoke("validate_seed", { words });
    rowState.set(id, { valid: true, validating: false });
    setRowStatus(row, "✓ Seed phrase is valid.", "success");
  } catch (err) {
    rowState.set(id, { valid: false, validating: false });
    setRowStatus(row, `✗ ${err}`, "error");
  }
  updateUI();
}

async function detectBirthdayForRow(id) {
  const row = rowById(id);
  if (!row) return;
  const phrase = row.querySelector(".seed-row-phrase").value.trim();
  if (!phrase) {
    setRowStatus(row, "Enter a seed phrase first.", "error");
    return;
  }
  const detectBtn = row.querySelector(".seed-row-birthday-detect");
  detectBtn.disabled = true;
  setRowStatus(row, "Probing for birthday…", "");

  const unlistenProbe = await listen("birthday-probe-progress", (event) => {
    setRowStatus(row, String(event.payload), "");
  });

  try {
    const result = await invoke("detect_birthday", {
      seed: phrase.toLowerCase(),
      lightwalletdUrl: $("lightwalletd-url").value.trim(),
      network: $("network-select").value,
    });
    row.querySelector(".seed-row-birthday-input").value = result.birthday;
    setRowStatus(row, `✓ ${result.message}`, "success");
  } catch (err) {
    setRowStatus(row, `✗ Birthday detection failed: ${err}`, "error");
  } finally {
    detectBtn.disabled = false;
    unlistenProbe();
  }
}

function addSeedRow(initial = {}) {
  const tmpl = $("seed-row-template");
  const row = tmpl.content.firstElementChild.cloneNode(true);
  const id = `seed-${++rowSeq}`;
  row.dataset.rowId = id;
  rowState.set(id, { valid: false, validating: false });

  const phraseEl = row.querySelector(".seed-row-phrase");
  phraseEl.value = initial.phrase || "";
  row.querySelector(".seed-row-label").value = initial.label || "";
  if (initial.birthday) {
    row.querySelector(".seed-row-birthday-input").value = initial.birthday;
  }

  row.querySelector(".seed-row-remove").addEventListener("click", () => removeSeedRow(id));
  row.querySelector(".seed-row-validate").addEventListener("click", () => validateRow(id));
  row.querySelector(".seed-row-birthday-detect").addEventListener("click", () => detectBirthdayForRow(id));
  phraseEl.addEventListener("blur", () => {
    // Only auto-validate when the user has typed something.
    if (phraseEl.value.trim()) validateRow(id);
    else {
      rowState.set(id, { valid: false, validating: false });
      setRowStatus(row, "", "");
      updateUI();
    }
  });
  phraseEl.addEventListener("input", () => {
    // Mark stale on edit so user re-validates.
    const st = rowState.get(id);
    if (st?.valid) {
      rowState.set(id, { valid: false, validating: false });
      setRowStatus(row, "", "");
      updateUI();
    }
  });

  seedRowsContainer.appendChild(row);
  applyMaskingToRow(row);
  updateUI();
  return id;
}

function removeSeedRow(id) {
  const row = rowById(id);
  if (row) row.remove();
  rowState.delete(id);
  // Always keep at least one row visible.
  if (rowsAll().length === 0) addSeedRow();
  updateUI();
}

function gatherSeedEntries() {
  return rowsAll()
    .map((row) => {
      const phrase = row.querySelector(".seed-row-phrase").value.trim();
      if (!phrase) return null;
      const birthdayRaw = row.querySelector(".seed-row-birthday-input").value.trim();
      const birthday = birthdayRaw ? parseInt(birthdayRaw, 10) : null;
      const label = row.querySelector(".seed-row-label").value.trim() || null;
      return {
        phrase: phrase.toLowerCase(),
        birthday: Number.isFinite(birthday) && birthday > 0 ? birthday : null,
        label,
      };
    })
    .filter(Boolean);
}

seedVisibility.addEventListener("change", () => {
  rowsAll().forEach(applyMaskingToRow);
});

$("add-seed-row").addEventListener("click", () => {
  const id = addSeedRow();
  const row = rowById(id);
  row?.querySelector(".seed-row-phrase").focus();
});

// Seed at least one row up front.
addSeedRow();

// ─── Step 3: Configuration ────────────────────────────────────────────────────

const SERVER_PRESETS = {
  mainnet: "https://zec.rocks:443,https://na.zec.rocks:443",
  testnet: "https://lightwalletd.testnet.electriccoin.co:9067",
};

$("network-select").addEventListener("change", () => {
  if ($("server-preset").value === "recommended") {
    $("lightwalletd-url").value = SERVER_PRESETS[$("network-select").value] ?? SERVER_PRESETS.mainnet;
  }
});

$("server-preset").addEventListener("change", () => {
  const preset = $("server-preset").value;
  if (preset === "custom") return;
  const key = preset === "recommended" ? $("network-select").value : preset;
  $("lightwalletd-url").value = SERVER_PRESETS[key] ?? SERVER_PRESETS.mainnet;
});

$("accounts-range").addEventListener("input", () => {
  $("accounts-range-value").textContent = $("accounts-range").value;
});

$("sweep-memo").addEventListener("input", () => {
  const bytes = new TextEncoder().encode($("sweep-memo").value).length;
  const counter = $("memo-byte-count");
  counter.textContent = `${bytes} / 512 bytes`;
  counter.style.color = bytes > 512 ? "var(--color-error, #c0392b)" : "";
});

$("auto-gap-limit").addEventListener("change", () => {
  const auto = $("auto-gap-limit").checked;
  $("gap-limit-row").style.display = auto ? "none" : "block";
  $("accounts-range").disabled = !auto;
  $("accounts-range-value").style.opacity = auto ? "0.4" : "1";
});

async function validateDestination() {
  const address = $("destination-input").value.trim();
  if (!address) {
    setStatus("config-status", "Enter a destination address first.", "error");
    return;
  }
  try {
    const info = await invoke("validate_address", { address });
    if (!info.destination_ok) {
      setStatus("config-status", "✗ Address must have an Orchard or Sapling receiver.", "error");
    } else {
      const pools = [info.has_orchard && "Orchard", info.has_sapling && "Sapling"]
        .filter(Boolean)
        .join(" + ");
      setStatus("config-status", `✓ Valid Unified Address — receivers: ${pools}`, "success");
    }
  } catch (err) {
    setStatus("config-status", `✗ ${err}`, "error");
  }
}

$("destination-validate").addEventListener("click", validateDestination);
$("destination-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); validateDestination(); }
});

$("start-scan").addEventListener("click", async () => {
  const seeds = gatherSeedEntries();
  if (seeds.length === 0) {
    setStatus("config-status", "Enter at least one seed phrase on step 2.", "error");
    return;
  }

  const address = $("destination-input").value.trim();
  if (!address) {
    setStatus("config-status", "A destination Unified Address is required.", "error");
    return;
  }

  try {
    const info = await invoke("validate_address", { address });
    if (!info.destination_ok) {
      setStatus("config-status", "✗ Address must have an Orchard or Sapling receiver.", "error");
      return;
    }
  } catch (err) {
    setStatus("config-status", `✗ ${err}`, "error");
    return;
  }

  state.destination = address;
  state.memo = $("sweep-memo").value.trim() || null;
  const maxFeeRaw = $("max-fee-zec").value.trim();
  if (maxFeeRaw && !/^\d*\.?\d{0,8}$/.test(maxFeeRaw)) {
    setStatus("config-status", "✗ Max fee must be a valid ZEC amount (e.g. 0.0002)", "error");
    $("start-scan").disabled = false;
    return;
  }
  state.maxFeeZec = maxFeeRaw || null;

  let dataDirVal = $("data-dir").value.trim();
  if (!dataDirVal) {
    try {
      dataDirVal = await invoke("default_data_dir");
      $("data-dir").value = dataDirVal;
    } catch (_) {
      setStatus("config-status", "✗ Could not determine a data directory. Please enter one manually.", "error");
      $("start-scan").disabled = false;
      return;
    }
  }

  const autoGap = $("auto-gap-limit").checked;
  const config = {
    network: $("network-select").value,
    lightwalletd_url: $("lightwalletd-url").value.trim(),
    data_dir: dataDirVal,
    gap_limit: autoGap ? parseInt($("gap-limit").value, 10) : 20,
    num_accounts: autoGap ? null : parseInt($("accounts-range").value, 10),
  };

  setStatus("config-status", "Starting scan…", "");
  $("start-scan").disabled = true;

  // Capture seed labels (for the discovery feed) before starting the scan.
  state.seedLabels.clear();
  state.seedDiscoveryCounts.clear();
  seeds.forEach((s, idx) => {
    state.seedLabels.set(idx, s.label || `Seed #${idx + 1}`);
  });

  try {
    resetMultiScanUI();
    await attachMultiScanListeners();
    const handle = await invoke("start_multi_scan", { seeds, config });
    state.scanHandle = handle;
    setStatus("config-status", `Scan started`, "success");
    goTo("scan");
    setStatus("scan-message", "", "");
  } catch (err) {
    cleanupListeners();
    setStatus("config-status", `✗ ${err}`, "error");
    $("start-scan").disabled = false;
  }
});

// ─── Step 4: Multi-seed Scan Progress ────────────────────────────────────────

function formatNumber(n) {
  return Number(n ?? 0).toLocaleString();
}

function renderMultiPhase(phase) {
  if (typeof phase === "string") return phase;
  if (phase && typeof phase === "object") {
    if ("Failed" in phase) return `Failed: ${phase.Failed}`;
    return JSON.stringify(phase);
  }
  return "—";
}

function isTerminalMultiPhase(phase) {
  if (typeof phase === "string") {
    return phase === "Completed" || phase === "Cancelled";
  }
  if (phase && typeof phase === "object" && "Failed" in phase) return true;
  return false;
}

function seedStatusLabel(status) {
  if (typeof status === "string") return status;
  if (status && typeof status === "object" && "Failed" in status) {
    return `Failed: ${status.Failed}`;
  }
  return "—";
}

function seedStatusKind(status) {
  if (typeof status === "string") {
    if (status === "Done") return "done";
    if (status === "Scanning") return "scanning";
    if (status === "Cancelled") return "cancelled";
    if (status === "Pending") return "pending";
  }
  if (status && typeof status === "object" && "Failed" in status) return "failed";
  return "";
}

function resetMultiScanUI() {
  $("agg-phase").textContent = "Starting…";
  $("agg-downloaded").textContent = "—";
  $("agg-target").textContent = "—";
  $("agg-retries").textContent = "0";
  $("agg-retries").classList.remove("retry-warning");
  $("agg-blocks").textContent = "0";
  $("agg-eta").textContent = "Estimating remaining time…";
  $("multi-scan-warnings").innerHTML = "";
  $("multi-scan-seeds").innerHTML = "";
  const feed = $("multi-scan-discoveries");
  feed.innerHTML =
    `<p class="status-line muted" id="multi-scan-discoveries-empty">` +
    `No funds discovered yet — discoveries will appear here as the scan finds them.</p>`;
  setStatus("scan-message", "", "");
  $("review-sweep").disabled = true;
  $("back-to-config").style.display = "none";
  $("cancel-scan").style.display = "";
  $("cancel-scan").disabled = false;
  state.scanTerminalHandled = false;
  state.notifiedTerminal = false;
  state.seedDiscoveryCounts.clear();
  eta.reset();
}

async function attachMultiScanListeners() {
  cleanupListeners();
  const [unlistenProgress, unlistenComplete, unlistenDiscovered] = await Promise.all([
    listen("multi-scan-progress", (event) => renderMultiProgress(event.payload)),
    listen("multi-scan-complete", (event) => {
      renderMultiProgress(event.payload);
      notifyMultiScanComplete(event.payload);
      cleanupListeners();
    }),
    listen("multi-scan-discovery", (event) => appendDiscovery(event.payload)),
  ]);
  state.unlistenProgress = unlistenProgress;
  state.unlistenComplete = unlistenComplete;
  state.unlistenDiscovered = unlistenDiscovered;
}

function cleanupListeners() {
  state.unlistenProgress?.();
  state.unlistenComplete?.();
  state.unlistenDiscovered?.();
  state.unlistenProgress = null;
  state.unlistenComplete = null;
  state.unlistenDiscovered = null;
}

function renderMultiProgress(progress) {
  state.lastProgress = progress;

  // Aggregate header
  $("agg-phase").textContent = renderMultiPhase(progress.phase);
  const dl = progress.fetcher?.downloaded_to_height;
  const tip = progress.fetcher?.target_tip;
  $("agg-downloaded").textContent = dl != null ? formatNumber(dl) : "—";
  $("agg-target").textContent = tip != null ? formatNumber(tip) : "—";
  const retries = Number(progress.fetcher?.retry_count ?? 0);
  $("agg-retries").textContent = String(retries);
  $("agg-retries").classList.toggle("retry-warning", retries > 0);
  $("agg-blocks").textContent = formatNumber(progress.blocks_scanned ?? 0);

  // ETA: feed observed = downloaded delta, total = chain tip - first downloaded.
  // We simply use blocks_scanned as the "scanned" axis and target_tip - earliest
  // downloaded_to_height as total. If we can't compute total reliably, we use
  // (downloaded_to + (tip - downloaded_to)) which is just `tip` — pass blocks
  // remaining instead via a synthesized total = scanned + remaining.
  let etaText = "Estimating remaining time…";
  if (dl != null && tip != null && tip > dl) {
    const remaining = Number(tip) - Number(dl);
    const scanned = Number(progress.blocks_scanned ?? 0);
    eta.observe(scanned, scanned + remaining);
    const est = eta.estimate();
    if (est.kind === "range") etaText = est.text;
    else if (est.kind === "done") etaText = "";
  }
  const synced = progress.synced_to_height;
  const era = synced ? eraHint(Number(synced)) : null;
  if (era) etaText = etaText ? `${etaText} · scanning ~${era}` : `scanning ~${era}`;
  $("agg-eta").textContent = etaText;

  // Warnings
  renderResolveWarnings(progress.warnings || []);

  // Per-seed cards (render-once + mutate by seed_index)
  const container = $("multi-scan-seeds");
  (progress.per_seed || []).forEach((seed) => {
    let card = container.querySelector(
      `.seed-card[data-seed-index="${seed.seed_index}"]`
    );
    if (!card) {
      const tmpl = $("seed-card-template");
      card = tmpl.content.firstElementChild.cloneNode(true);
      card.dataset.seedIndex = String(seed.seed_index);
      container.appendChild(card);
      // Capture label fallback if not already known.
      if (!state.seedLabels.has(seed.seed_index)) {
        state.seedLabels.set(
          seed.seed_index,
          seed.label || `Seed #${seed.seed_index + 1}`
        );
      }
    }
    updateSeedCard(card, seed);
  });

  // Terminal handling
  if (isTerminalMultiPhase(progress.phase) && !state.scanTerminalHandled) {
    state.scanTerminalHandled = true;
    onMultiScanTerminal(progress);
  }
}

function updateSeedCard(card, seed) {
  const label =
    seed.label || state.seedLabels.get(seed.seed_index) || `Seed #${seed.seed_index + 1}`;
  card.querySelector(".seed-card-label").textContent = label;
  const fp = seed.seed_fingerprint || "";
  card.querySelector(".seed-card-fingerprint").textContent = fp ? fp.slice(0, 12) + "…" : "";
  card.querySelector(".seed-card-fingerprint").title = fp;

  const statusEl = card.querySelector(".seed-card-status");
  statusEl.textContent = seedStatusLabel(seed.status);
  statusEl.dataset.kind = seedStatusKind(seed.status);

  card.querySelector(".seed-card-birthday").textContent =
    seed.birthday != null ? formatNumber(seed.birthday) : "—";
  card.querySelector(".seed-card-scanned").textContent =
    seed.fully_scanned_height != null ? formatNumber(seed.fully_scanned_height) : "—";

  const count = state.seedDiscoveryCounts.get(seed.seed_index) ?? 0;
  card.querySelector(".seed-card-discoveries").textContent = String(count);
}

function renderResolveWarnings(warnings) {
  const container = $("multi-scan-warnings");
  if (!warnings || warnings.length === 0) {
    container.innerHTML = "";
    return;
  }
  const html = warnings
    .map((w) => {
      if ("BirthdayDetectionFellBack" in w) {
        const { index, fallback_height, reason } = w.BirthdayDetectionFellBack;
        const label = state.seedLabels.get(index) || `Seed #${index + 1}`;
        return `<div class="banner warning">${escapeHtml(label)}: birthday detection fell back to height ${formatNumber(fallback_height)} — ${escapeHtml(reason)}</div>`;
      }
      if ("ResumingExisting" in w) {
        const { index, height } = w.ResumingExisting;
        const label = state.seedLabels.get(index) || `Seed #${index + 1}`;
        return `<div class="banner info">${escapeHtml(label)}: resuming existing workspace at height ${formatNumber(height)}.</div>`;
      }
      return "";
    })
    .join("");
  container.innerHTML = html;
}

function appendDiscovery(d) {
  if (!d) return;
  const seedIdx = d.seed_index ?? 0;
  state.seedDiscoveryCounts.set(
    seedIdx,
    (state.seedDiscoveryCounts.get(seedIdx) ?? 0) + 1
  );

  // Update card count if the card already exists.
  const card = $("multi-scan-seeds").querySelector(
    `.seed-card[data-seed-index="${seedIdx}"]`
  );
  if (card) {
    card.querySelector(".seed-card-discoveries").textContent = String(
      state.seedDiscoveryCounts.get(seedIdx)
    );
  }

  const feed = $("multi-scan-discoveries");
  const placeholder = $("multi-scan-discoveries-empty");
  if (placeholder) placeholder.remove();

  let group = feed.querySelector(`.discovery-group[data-seed-index="${seedIdx}"]`);
  if (!group) {
    const tmpl = $("seed-discovery-group-template");
    group = tmpl.content.firstElementChild.cloneNode(true);
    group.dataset.seedIndex = String(seedIdx);
    const label =
      state.seedLabels.get(seedIdx) ||
      (d.seed_fingerprint ? `Seed ${d.seed_fingerprint.slice(0, 8)}…` : `Seed #${seedIdx + 1}`);
    group.querySelector(".discovery-group-label").textContent = label;
    feed.appendChild(group);
  }
  const count = state.seedDiscoveryCounts.get(seedIdx) ?? 0;
  group.querySelector(".discovery-group-count").textContent =
    count === 1 ? "1 discovery" : `${count} discoveries`;

  const row = document.createElement("div");
  row.className = "discovery-toast";
  const heightHint = d.at_block_height
    ? ` (scanned through block ${Number(d.at_block_height).toLocaleString()})`
    : "";
  row.textContent =
    `Found ${fmt(d.zatoshis)} on account ${d.account_index} — ${d.pool}${heightHint}`;
  group.querySelector(".discovery-group-rows").appendChild(row);
}

function multiScanCompletionSummary(progress) {
  const total = (progress.discoveries || []).reduce(
    (sum, d) => sum + Number(d.zatoshis ?? 0),
    0
  );
  const phase = progress.phase;
  if (typeof phase === "object" && "Failed" in phase) {
    return `Scan failed: ${phase.Failed}`;
  }
  if (phase === "Cancelled") {
    return "Scan stopped before completion. Re-run with the same flags to resume.";
  }
  if (total === 0) {
    return "No funds were discovered across the scanned seeds.";
  }
  const seeds = (progress.per_seed || []).length;
  return `Found ${fmt(total)} across ${seeds} seed${seeds === 1 ? "" : "s"}.`;
}

function notifyMultiScanComplete(progress) {
  if (state.notifiedTerminal) return;
  state.notifiedTerminal = true;
  const phase = progress.phase;
  let title;
  if (phase === "Completed") title = "ZECK scan complete";
  else if (phase === "Cancelled") title = "ZECK scan cancelled";
  else if (typeof phase === "object" && "Failed" in phase) title = "ZECK scan failed";
  else return;
  invoke("notify_user", { title, body: multiScanCompletionSummary(progress) }).catch(() => {});
}

function onMultiScanTerminal(progress) {
  $("cancel-scan").style.display = "none";
  const phase = progress.phase;
  if (phase === "Completed") {
    $("review-sweep").disabled = false;
    setStatus("scan-message", "Scan complete — review the sweep proposal.", "success");
  } else if (phase === "Cancelled") {
    $("back-to-config").style.display = "";
    $("start-scan").disabled = false;
    setStatus("scan-message", "Scan cancelled. Workspace state preserved on disk.", "");
  } else if (typeof phase === "object" && "Failed" in phase) {
    $("back-to-config").style.display = "";
    $("start-scan").disabled = false;
    setStatus("scan-message", `Scan failed: ${phase.Failed}`, "error");
  }
}

$("back-to-config").addEventListener("click", () => {
  cleanupListeners();
  state.scanHandle = null;
  $("back-to-config").style.display = "none";
  $("start-scan").disabled = false;
  goTo("config");
});

$("cancel-scan").addEventListener("click", async () => {
  if (!state.scanHandle) return;
  $("cancel-scan").disabled = true;
  try {
    await invoke("cancel_multi_scan", { handle: state.scanHandle });
    setStatus("scan-message", "Cancelling scan…", "");
  } catch (err) {
    setStatus("scan-message", `Cancel failed: ${err}`, "error");
    $("cancel-scan").disabled = false;
  }
});

$("review-sweep").addEventListener("click", async () => {
  setStatus("scan-message", "Fetching sweep proposal…", "");
  $("review-sweep").disabled = true;

  try {
    const proposal = await invoke("propose_sweep", {
      handle: state.scanHandle,
      destination: state.destination,
      memo: state.memo,
      maxFeeZec: state.maxFeeZec,
    });
    state.sweepProposal = proposal;
    renderSweepProposal(proposal);
    goTo("sweep");
  } catch (err) {
    setStatus("scan-message", `✗ ${err}`, "error");
    $("review-sweep").disabled = false;
  }
});

// ─── Step 5: Sweep Review ─────────────────────────────────────────────────────

function renderSweepProposal(proposal) {
  const tbody = $("sweep-rows");
  tbody.innerHTML = "";

  proposal.transactions.forEach((tx) => {
    const kindLabel = tx.kind === "shield_transparent" ? "Shield" : "Sweep";
    const dest = tx.destination;
    const shortDest =
      dest.length > 26 ? dest.slice(0, 12) + "…" + dest.slice(-10) : dest;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${tx.source_account}</td>
      <td>${kindLabel}</td>
      <td title="${escapeHtml(dest)}" style="cursor:pointer" data-copy="${escapeHtml(dest)}">${escapeHtml(shortDest)} <small>📋</small></td>
      <td>${fmt(tx.gross_zatoshis)}</td>
      <td>${fmt(tx.fee_zatoshis)}</td>
      <td>${fmt(tx.net_zatoshis)}</td>
      <td>${escapeHtml(tx.memo ?? "—")}</td>
    `;
    tbody.appendChild(tr);
  });

  $("sweep-summary").textContent =
    `Net received: ${fmt(proposal.net_received_zatoshis)} after ${fmt(proposal.total_fee_zatoshis)} in fees.` +
    (proposal.warning ? `  ⚠ ${proposal.warning}` : "");

  const skippedEl = $("sweep-skipped");
  if (proposal.skipped_accounts.length > 0) {
    const items = proposal.skipped_accounts
      .map(
        (s) =>
          `<li>Account ${s.account_index}: ${escapeHtml(s.reason)} (${fmt(s.gross_zatoshis)})</li>`
      )
      .join("");
    skippedEl.innerHTML = `<p style="margin:6px 0 4px;font-weight:700;color:var(--muted)">Skipped accounts</p><ul class="discovery-list">${items}</ul>`;
  } else {
    skippedEl.innerHTML = "";
  }

  $("irreversible-check").checked = false;
  $("execute-sweep").disabled = true;
}

// Copy-address click handler for sweep table — wired once here so it doesn't
// accumulate duplicates if renderSweepProposal is called more than once.
$("sweep-rows").addEventListener("click", (e) => {
  const cell = e.target.closest("[data-copy]");
  if (!cell) return;
  navigator.clipboard.writeText(cell.dataset.copy).then(() => {
    const orig = cell.innerHTML;
    cell.innerHTML = "Copied!";
    setTimeout(() => { cell.innerHTML = orig; }, 1200);
  });
});

$("irreversible-check").addEventListener("change", () => {
  $("execute-sweep").disabled = !$("irreversible-check").checked;
});

$("execute-sweep").addEventListener("click", async () => {
  $("execute-sweep").disabled = true;
  $("irreversible-check").disabled = true;

  try {
    const results = await invoke("execute_sweep", {
      handle: state.scanHandle,
      destination: state.destination,
      memo: state.memo,
      maxFeeZec: state.maxFeeZec,
    });
    renderCompleteScreen(results);
    goTo("complete");
  } catch (err) {
    $("execute-sweep").disabled = false;
    $("irreversible-check").disabled = false;
    $("sweep-skipped").innerHTML =
      `<p class="status-line error">✗ Sweep failed: ${escapeHtml(String(err))}</p>`;
  }
});

// ─── Step 6: Complete ─────────────────────────────────────────────────────────

function renderCompleteScreen(results) {
  const confirmed = results.filter((r) => r.status === "confirmed").length;
  const pending = results.filter((r) => r.status === "pending").length;
  const failed = results.filter((r) => r.status === "failed").length;

  $("complete-summary").textContent =
    `Sweep finished — ${confirmed} confirmed, ${pending} pending, ${failed} failed.`;

  const rows = results
    .map((r) => {
      let line = `Account ${r.source_account}: ${r.status.toUpperCase()}`;
      if (r.txid) line += `\n  txid: ${r.txid}`;
      if (r.confirmed_height) line += `\n  confirmed at block ${r.confirmed_height}`;
      if (r.detail) line += `\n  ${r.detail}`;
      return line;
    })
    .join("\n\n");

  $("complete-report").innerHTML = `<pre>${escapeHtml(rows)}</pre>`;

  const report = buildReport(results);
  $("save-report").dataset.report = report;
  $("report-path").value = buildDefaultReportPath();
}

function buildReport(results) {
  return [
    "ZECK Recovery Report",
    `Date: ${new Date().toISOString()}`,
    "",
    "Transaction Results",
    "──────────────────",
    ...results.map((r) => {
      let line = `Account ${r.source_account}: ${r.status}`;
      if (r.txid) line += `\n  txid: ${r.txid}`;
      if (r.confirmed_height) line += `\n  confirmed at block ${r.confirmed_height}`;
      if (r.detail) line += `\n  detail: ${r.detail}`;
      return line;
    }),
  ].join("\n");
}

function buildDefaultReportPath() {
  const dir = ($("data-dir")?.value ?? "").trim();
  if (!dir) return "zeck-recovery-report.txt";
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir}${sep}zeck-recovery-report.txt`;
}

$("save-report").addEventListener("click", async () => {
  const path = $("report-path").value.trim();
  const report = $("save-report").dataset.report ?? "";
  if (!report) {
    setStatus("save-report-status", "Nothing to save yet.", "error");
    return;
  }
  try {
    const saved = await invoke("save_recovery_report", { path, report });
    setStatus("save-report-status", `✓ Saved to ${saved}`, "success");
  } catch (err) {
    setStatus("save-report-status", `✗ ${err}`, "error");
  }
});

$("restart-flow").addEventListener("click", () => {
  cleanupListeners();
  furthestStep = 0;
  Object.assign(state, {
    scanHandle: null,
    lastProgress: null,
    sweepProposal: null,
    destination: null,
    memo: null,
    maxFeeZec: null,
  });

  // Reset seed rows: drop all and seed a fresh empty row.
  seedRowsContainer.innerHTML = "";
  rowState.clear();
  rowSeq = 0;
  seedVisibility.checked = false;
  addSeedRow();
  seedNextBtn.disabled = true;
  setStatus("seed-status", "", "");
  setStatus("config-status", "", "");
  $("destination-input").value = "";
  $("max-fee-zec").value = "";
  $("sweep-memo").value = "";
  $("start-scan").disabled = false;

  // Reset scan screen to blank state so stale results aren't visible if the
  // user navigates forward via the sidebar before starting a new scan.
  resetMultiScanUI();
  state.seedLabels.clear();
  $("cancel-scan").disabled = false;

  goTo("welcome");
});

// ─── Init ─────────────────────────────────────────────────────────────────────

$("lightwalletd-url").value = SERVER_PRESETS.mainnet;
$("gap-limit-row").style.display = $("auto-gap-limit").checked ? "none" : "block";
$("accounts-range").disabled = !$("auto-gap-limit").checked;
goTo("welcome");

invoke("default_data_dir")
  .then((dir) => {
    if (dir && !$("data-dir").value.trim()) $("data-dir").value = dir;
  })
  .catch(() => {
    // Non-fatal: user can always type a path manually.
  });

}); // end DOMContentLoaded
