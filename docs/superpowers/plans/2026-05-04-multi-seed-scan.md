# Multi-Seed Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-seed recovery mode where N user-supplied seeds share a single block-download stream, with the lowest-birthday seed producing discoveries first.

**Architecture:** Split today's `run_wallet_sync` (download + scan + retry, all coupled) into a single block fetcher and N per-seed scanners that consume from a network-scoped shared `SqliteBlockCache`. Single-seed runs become a degenerate N=1 multi-seed run, transparently benefiting from the shared cache.

**Tech Stack:** Rust (zcash_client_backend, zcash_client_sqlite, tokio, rusqlite WAL, tracing), Tauri v2, vanilla HTML/JS (withGlobalTauri), clap for CLI.

**Spec:** [docs/superpowers/specs/2026-05-04-multi-seed-scan-design.md](../specs/2026-05-04-multi-seed-scan-design.md)

---

## File Structure

### New files
- `crates/zeck-core/src/cache.rs` — extracted `SqliteBlockCache` (was inline in `scan.rs`), with WAL + advisory-lock helpers and lazy migration from per-workspace cache.
- `crates/zeck-core/src/fetcher.rs` — block fetcher actor: owns lightwalletd client + cache writer, broadcasts `available_height` watch channel.
- `crates/zeck-core/src/scanner.rs` — per-seed scanner actor: owns `WalletDb`, subscribes to fetcher, drives `scan_cached_blocks` against shared cache.
- `crates/zeck-core/src/multi_seed.rs` — `MultiSeedRun` orchestrator + types (`MultiSeedProgress`, `SeedProgress`, `SeedStatus`, `FetcherProgress`).
- `crates/zeck-core/tests/multi_seed_integration.rs` — testnet-style integration test (mock client + mock cache).

### Modified files
- `crates/zeck-core/src/scan.rs` — keep public single-seed entry points; replace inline cache + `run_wallet_sync` with calls into `fetcher::run_fetcher` + `scanner::run_scanner`.
- `crates/zeck-core/src/workspace.rs` — add `network_cache_dir(data_dir, network)` and `network_cache_lock_path` helpers; `cache_db_path` is deprecated for new code (kept for migration).
- `crates/zeck-core/src/models.rs` — add `seed_index` and `seed_fingerprint` fields to `ScanDiscovery`; add multi-seed types if not in `multi_seed.rs`.
- `crates/zeck-core/src/lib.rs` — re-export new public types.
- `crates/zeck-core/src/service.rs` — add `start_multi_scan`, `get_multi_scan_progress`, `cancel_multi_scan`.
- `gui/src-tauri/src/commands.rs` — add `start_multi_scan`, `get_multi_scan_progress`, `cancel_multi_scan` + pump loop.
- `gui/src-tauri/src/main.rs` — register new commands.
- `gui/src/index.html`, `gui/src/main.js`, `gui/src/styles.css` — add/remove seed rows, per-seed progress cards, multi-seed sweep view.
- `crates/zeck-cli/src/main.rs` — accept repeated `--seed`/`--birthday`, add `--seeds-file`, per-seed progress table, multi-seed sweep prompt.
- `TESTING.md` — multi-seed test checklist.

### Deleted code
- The inline `SqliteBlockCache` in `scan.rs` (lines ~30–280) moves to `cache.rs`.
- `run_wallet_sync` and `run_wallet_sync_with_retry` become thin shims around the new fetcher/scanner split, or are removed if all callers migrate cleanly.

---

## Phase 1 — Shared Cache Pool

Goal: relocate `SqliteBlockCache` to `data_dir/cache/<network>.sqlite`, add WAL + cross-process advisory lock, and migrate per-workspace caches lazily. Single-seed scans must continue passing all existing tests with no behavior change other than cache location.

### Task 1: Extract `SqliteBlockCache` to its own module

**Files:**
- Create: `crates/zeck-core/src/cache.rs`
- Modify: `crates/zeck-core/src/scan.rs` (remove inline cache, add `use crate::cache::SqliteBlockCache;`)
- Modify: `crates/zeck-core/src/lib.rs` (`pub mod cache;`)

- [ ] **Step 1: Move `CacheError`, `SqliteBlockCache`, and the `BlockSource`/`BlockCache` impls verbatim**

Cut `scan.rs` lines 30–280 (the cache types and impls; verify exact range with `grep -n "struct SqliteBlockCache\|impl BlockCache for"`) and paste into `crates/zeck-core/src/cache.rs`. Preserve `pub(crate)` visibility on `SqliteBlockCache::for_path`.

- [ ] **Step 2: Add `pub mod cache;` to lib.rs and `use crate::cache::SqliteBlockCache;` to scan.rs**

- [ ] **Step 3: Build and run all existing tests**

Run: `cargo test -p zeck-core`
Expected: PASS (refactor only).

- [ ] **Step 4: Commit**

```bash
git add crates/zeck-core/src/cache.rs crates/zeck-core/src/scan.rs crates/zeck-core/src/lib.rs
git commit -m "refactor: extract SqliteBlockCache to its own module"
```

### Task 2: Add network-scoped cache path helpers

**Files:**
- Modify: `crates/zeck-core/src/workspace.rs`
- Test: `crates/zeck-core/src/workspace.rs` (inline `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write failing test**

Append to a `#[cfg(test)] mod path_tests { ... }` in `workspace.rs`:

```rust
#[test]
fn network_cache_dir_is_scoped_by_network() {
    use std::path::PathBuf;
    let root = PathBuf::from("/tmp/zeck-data");
    let mainnet = network_cache_dir(&root, ZeckNetwork::Mainnet);
    let testnet = network_cache_dir(&root, ZeckNetwork::Testnet);
    assert_eq!(mainnet, root.join("cache").join("mainnet"));
    assert_eq!(testnet, root.join("cache").join("testnet"));
    assert_ne!(mainnet, testnet);
}

#[test]
fn network_cache_db_and_lock_paths_are_under_cache_dir() {
    use std::path::PathBuf;
    let root = PathBuf::from("/tmp/zeck-data");
    let dir = network_cache_dir(&root, ZeckNetwork::Mainnet);
    assert_eq!(network_cache_db_path(&root, ZeckNetwork::Mainnet), dir.join("blocks.sqlite"));
    assert_eq!(network_cache_lock_path(&root, ZeckNetwork::Mainnet), dir.join("blocks.lock"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p zeck-core network_cache`
Expected: FAIL — `cannot find function network_cache_dir`.

- [ ] **Step 3: Implement helpers**

Add to `workspace.rs`:

```rust
pub fn network_cache_dir(data_dir: &Path, network: ZeckNetwork) -> PathBuf {
    data_dir.join("cache").join(network.label())
}

pub fn network_cache_db_path(data_dir: &Path, network: ZeckNetwork) -> PathBuf {
    network_cache_dir(data_dir, network).join("blocks.sqlite")
}

pub fn network_cache_lock_path(data_dir: &Path, network: ZeckNetwork) -> PathBuf {
    network_cache_dir(data_dir, network).join("blocks.lock")
}
```

Confirm `ZeckNetwork::label` returns the strings you want (it returns `"mainnet"`/`"testnet"` per `models.rs:23`). If not, adjust.

- [ ] **Step 4: Run tests to verify pass**

Run: `cargo test -p zeck-core network_cache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/zeck-core/src/workspace.rs
git commit -m "feat: add network-scoped cache path helpers"
```

### Task 3: Open shared cache with WAL + advisory lock

**Files:**
- Modify: `crates/zeck-core/src/cache.rs`
- Modify: `crates/zeck-core/Cargo.toml` (add `fs2 = "0.4"` for `FileExt::try_lock_exclusive`)
- Test: `crates/zeck-core/src/cache.rs`

Dependency note: `fs2` is widely used (downloads >10M, MIT/Apache, 0 transitive deps beyond `libc`/`winapi`). If you prefer to skip a new dep, replace with hand-rolled `flock(2)` on unix + `LockFileEx` on Windows. Default to `fs2` for simplicity.

- [ ] **Step 1: Add `fs2` to Cargo.toml dev/runtime deps**

```toml
[dependencies]
fs2 = "0.4"
```

- [ ] **Step 2: Write failing test**

Add to `cache.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn open_shared_cache_creates_dir_and_db() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("cache").join("mainnet").join("blocks.sqlite");
        let lock = dir.path().join("cache").join("mainnet").join("blocks.lock");
        let _writer = SharedCacheWriter::open(&db, &lock).unwrap();
        assert!(db.exists());
        assert!(lock.exists());
    }

    #[test]
    fn second_writer_fails_while_first_held() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("blocks.sqlite");
        let lock = dir.path().join("blocks.lock");
        let _w1 = SharedCacheWriter::open(&db, &lock).unwrap();
        let err = SharedCacheWriter::open(&db, &lock).unwrap_err();
        assert!(matches!(err, CacheOpenError::Locked));
    }

    #[test]
    fn second_writer_succeeds_after_first_dropped() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("blocks.sqlite");
        let lock = dir.path().join("blocks.lock");
        {
            let _w1 = SharedCacheWriter::open(&db, &lock).unwrap();
        }
        let _w2 = SharedCacheWriter::open(&db, &lock).unwrap();
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test -p zeck-core cache::tests`
Expected: FAIL — `SharedCacheWriter` does not exist.

- [ ] **Step 4: Implement**

```rust
use fs2::FileExt;
use std::fs::{self, File, OpenOptions};

pub enum CacheOpenError {
    Locked,
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
}
// + From impls + Display + Error

pub struct SharedCacheWriter {
    cache: SqliteBlockCache,
    _lock_file: File,
}

impl SharedCacheWriter {
    pub fn open(db_path: &Path, lock_path: &Path) -> Result<Self, CacheOpenError> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).map_err(CacheOpenError::Io)?;
        }
        let lock_file = OpenOptions::new()
            .read(true).write(true).create(true)
            .open(lock_path)
            .map_err(CacheOpenError::Io)?;
        lock_file.try_lock_exclusive().map_err(|e| {
            if e.kind() == std::io::ErrorKind::WouldBlock { CacheOpenError::Locked }
            else { CacheOpenError::Io(e) }
        })?;
        let cache = SqliteBlockCache::for_path(db_path).map_err(/* CacheError -> CacheOpenError */)?;
        cache.set_journal_mode_wal()?; // see Step 5
        Ok(Self { cache, _lock_file: lock_file })
    }

    pub fn cache(&self) -> &SqliteBlockCache { &self.cache }
}
```

Reader-only path:

```rust
pub struct SharedCacheReader { cache: SqliteBlockCache }
impl SharedCacheReader {
    pub fn open(db_path: &Path) -> Result<Self, CacheOpenError> {
        // open existing only; no lock; WAL allows concurrent readers
        let cache = SqliteBlockCache::for_path(db_path)?;
        Ok(Self { cache })
    }
    pub fn cache(&self) -> &SqliteBlockCache { &self.cache }
}
```

- [ ] **Step 5: Add `set_journal_mode_wal` on `SqliteBlockCache`**

In `cache.rs`:

```rust
impl SqliteBlockCache {
    pub(crate) fn set_journal_mode_wal(&self) -> Result<(), CacheError> {
        let conn = self.0.lock().expect("cache mutex poisoned");
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(())
    }
}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `cargo test -p zeck-core cache::tests`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/zeck-core/Cargo.toml crates/zeck-core/src/cache.rs
git commit -m "feat: shared cache with WAL and cross-process advisory lock"
```

### Task 4: Lazy migration from per-workspace cache

**Files:**
- Modify: `crates/zeck-core/src/cache.rs`
- Test: `crates/zeck-core/src/cache.rs`

- [ ] **Step 1: Write failing test**

```rust
#[test]
fn migrate_old_cache_merges_blocks_and_deletes_source() {
    use tempfile::tempdir;
    let dir = tempdir().unwrap();
    let old = dir.path().join("old.sqlite");
    let new = dir.path().join("new.sqlite");
    let lock = dir.path().join("new.lock");

    // Seed old cache with one fake block.
    {
        let cache = SqliteBlockCache::for_path(&old).unwrap();
        cache.insert_test_block(100, b"fakeblock").unwrap(); // helper, see Step 2
    }

    let writer = SharedCacheWriter::open(&new, &lock).unwrap();
    writer.migrate_from(&old).unwrap();

    assert!(!old.exists(), "old cache should be deleted on success");
    assert_eq!(writer.cache().count_blocks().unwrap(), 1);
}

#[test]
fn migrate_missing_old_cache_is_a_noop() {
    use tempfile::tempdir;
    let dir = tempdir().unwrap();
    let new = dir.path().join("new.sqlite");
    let lock = dir.path().join("new.lock");
    let writer = SharedCacheWriter::open(&new, &lock).unwrap();
    writer.migrate_from(&dir.path().join("does-not-exist.sqlite")).unwrap();
}
```

- [ ] **Step 2: Add test helpers `insert_test_block` and `count_blocks` to `SqliteBlockCache` under `#[cfg(test)]`**

Match the existing `compactblocks` table schema in `SqliteBlockCache::for_path` (verify with the existing `INSERT` in the cache `insert` method).

- [ ] **Step 3: Run tests to verify failure**

Run: `cargo test -p zeck-core cache::tests::migrate`
Expected: FAIL — `migrate_from` does not exist.

- [ ] **Step 4: Implement**

```rust
impl SharedCacheWriter {
    pub fn migrate_from(&self, old_db: &Path) -> Result<(), CacheError> {
        if !old_db.exists() { return Ok(()); }
        let old = SqliteBlockCache::for_path(old_db)?;
        // Stream blocks from old into self.cache. ATTACH DATABASE + INSERT-SELECT
        // is the simplest approach.
        let conn = self.cache.0.lock().expect("cache mutex poisoned");
        conn.execute("ATTACH DATABASE ?1 AS old", [old_db.to_string_lossy().as_ref()])?;
        conn.execute(
            "INSERT OR IGNORE INTO compactblocks (height, data) \
             SELECT height, data FROM old.compactblocks",
            [],
        )?;
        conn.execute("DETACH DATABASE old", [])?;
        drop(conn);
        drop(old);
        std::fs::remove_file(old_db).ok();
        Ok(())
    }
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cargo test -p zeck-core cache::tests::migrate`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/zeck-core/src/cache.rs
git commit -m "feat: lazy migration from per-workspace cache to shared cache"
```

### Task 5: Wire single-seed `run_wallet_sync` to use `SharedCacheWriter`

**Files:**
- Modify: `crates/zeck-core/src/scan.rs`
- Modify: `crates/zeck-core/src/workspace.rs` (deprecate `cache_db_path` for new callers; keep helper)

- [ ] **Step 1: Update `run_wallet_sync` (scan.rs:821) to open the shared cache**

Replace the existing `SqliteBlockCache::for_path(workspace.cache_db_path())` with:

```rust
let data_dir = workspace.root().parent().unwrap_or(workspace.root()); // see note below
let db = workspace::network_cache_db_path(data_dir, network);
let lock = workspace::network_cache_lock_path(data_dir, network);
let writer = SharedCacheWriter::open(&db, &lock).map_err(scan_open_err)?;
writer.migrate_from(workspace.cache_db_path())?;
let cache_db = writer.cache(); // borrow for sync::run
sync::run(client, network, cache_db, &mut wallet_db, SYNC_BATCH_SIZE).await...
```

Note: derive `data_dir` from the workspace root by walking up the seed-fingerprint subdirectory layers, or — cleaner — store `data_dir` on `RecoveryWorkspace` at construction time. Check `RecoveryWorkspace::from_runtime` (workspace.rs:45) to confirm the structure and add a `pub fn data_dir(&self) -> &Path` if needed.

- [ ] **Step 2: Run all existing scan tests**

Run: `cargo test -p zeck-core`
Expected: PASS — single-seed flow now uses shared cache transparently.

- [ ] **Step 3: Manual smoke against testnet**

Run a single-seed CLI scan with the test seed against testnet (use a low birthday for a short scan; pre-existing pattern in TESTING.md). Verify `data_dir/cache/testnet/blocks.sqlite` is created and `data_dir/<workspace>/cache.sqlite` is migrated and removed.

```bash
cargo run -p zeck-cli -- scan --seed-file ./test-seed.txt --birthday 2800000 --network testnet
ls "$ZECK_DATA_DIR/cache/testnet/"
```

- [ ] **Step 4: Commit**

```bash
git add crates/zeck-core/src/scan.rs crates/zeck-core/src/workspace.rs
git commit -m "feat: single-seed scan uses shared cache pool"
```

---

## Phase 2 — Fetcher / Scanner Split

Goal: factor `run_wallet_sync` into a fetcher actor (lightwalletd → cache) and a scanner actor (cache → wallet DB), connected by a `tokio::sync::watch::Sender<BlockHeight>`. Single-seed `run_wallet_sync` becomes a degenerate two-actor run with N=1 scanner.

### Task 6: Define fetcher actor

**Files:**
- Create: `crates/zeck-core/src/fetcher.rs`
- Modify: `crates/zeck-core/src/lib.rs` (`pub(crate) mod fetcher;`)

- [ ] **Step 1: Define the public surface**

```rust
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use zcash_protocol::consensus::{BlockHeight, Network};

pub struct FetcherHandle {
    pub available_height: watch::Receiver<Option<BlockHeight>>,
    pub task: tokio::task::JoinHandle<Result<FetcherSummary, FetcherError>>,
    pub cancel: CancellationToken,
}

pub struct FetcherProgress {
    pub downloaded_to_height: Option<BlockHeight>,
    pub target_tip: Option<BlockHeight>,
    pub retry_count: u32,
}

pub struct FetcherSummary { pub final_tip: BlockHeight, pub retry_count: u32 }

pub enum FetcherError { /* transport-after-retries, cache-write, cancelled */ }
```

- [ ] **Step 2: Write failing test with mocked client + cache**

```rust
#[tokio::test]
async fn fetcher_downloads_from_min_height_and_broadcasts_progress() {
    let cache = MockCache::new();
    let client = MockClient::with_tip(BlockHeight::from(150));
    let cancel = CancellationToken::new();
    let handle = run_fetcher(start_height(100), client, cache.clone(), Network::TestNetwork, cancel.clone()).await;
    let final_tip = handle.task.await.unwrap().unwrap().final_tip;
    assert_eq!(u32::from(final_tip), 150);
    assert!(cache.contains_range(100..=150));
}
```

- [ ] **Step 3: Implement using existing retry loop pattern**

Port the body of `run_wallet_sync_with_retry` (scan.rs:761) into `run_fetcher`, but stop calling `sync::run` and instead drive only the *download* portion: use the `client.get_block_range` streaming RPC (or whatever `zcash_client_backend::sync::run` invokes internally) to pull `CompactBlock` batches, write to cache via `BlockCache::insert`, and update the `watch` sender after each successful batch. Reuse the GoAway/transport-error classification from the existing retry function — extract it into a free function `is_transient_transport_error(err: &E) -> bool` if needed.

The simplest path that minimizes risk: drive the existing `sync::run` against a no-op `WalletDb` (just a block cache writer) — but `sync::run` requires a real `WalletDb`. Instead, replicate just its download loop. Read the relevant `zcash_client_backend::sync` source (it's small) and copy the download portion only.

- [ ] **Step 4: Run test to verify pass**

Run: `cargo test -p zeck-core fetcher::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/zeck-core/src/fetcher.rs crates/zeck-core/src/lib.rs
git commit -m "feat: standalone block fetcher actor with progress channel"
```

### Task 7: Define scanner actor

**Files:**
- Create: `crates/zeck-core/src/scanner.rs`
- Modify: `crates/zeck-core/src/lib.rs`

- [ ] **Step 1: Define the public surface**

```rust
pub struct ScannerSpec {
    pub seed_index: usize,
    pub seed_fingerprint: String,
    pub birthday: BlockHeight,
    pub workspace: RecoveryWorkspace,
    pub seed_bytes: SecretVec<u8>,
    pub accounts: Vec<DerivedAccount>,
    pub gap_limit: u32,
}

pub struct ScannerHandle {
    pub progress: Arc<Mutex<SeedProgress>>,
    pub task: JoinHandle<Result<(), ScannerError>>,
    pub cancel: CancellationToken,
}

pub enum SeedStatus { Pending, Scanning, Done, Failed(String) }
```

- [ ] **Step 2: Write failing test**

Two scanners against a shared mock cache, both scanning to the same tip; assert each `WalletDb` reaches its target `fully_scanned_height`.

- [ ] **Step 3: Implement**

The scanner subscribes to `available_height: watch::Receiver<Option<BlockHeight>>`. On each change, if `available >= max(birthday, fully_scanned_height + 1)`, call `zcash_client_backend::data_api::scanning::scan_cached_blocks(...)` against the shared `BlockCache` reader. Update its own `SeedProgress`. Loop until `available == final_tip` and the wallet DB is fully scanned, then mark `Done`.

- [ ] **Step 4: Run test to verify pass**

Run: `cargo test -p zeck-core scanner::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/zeck-core/src/scanner.rs crates/zeck-core/src/lib.rs
git commit -m "feat: per-seed scanner actor consuming shared cache"
```

### Task 8: Re-implement single-seed `run_wallet_sync` on the new split

**Files:**
- Modify: `crates/zeck-core/src/scan.rs`

- [ ] **Step 1: Replace body of `run_wallet_sync_with_retry`**

```rust
async fn run_wallet_sync_with_retry(...) -> ZeckResult<()> {
    let cancel = CancellationToken::new();
    let fetcher = run_fetcher(start, client, shared_cache_writer, network, cancel.clone()).await;
    let scanner = run_scanner(scanner_spec, fetcher.available_height.clone(), shared_cache_reader, cancel.clone()).await;
    let (fr, sr) = tokio::join!(fetcher.task, scanner.task);
    fr??; sr??;
    Ok(())
}
```

- [ ] **Step 2: Verify all existing scan tests still pass**

Run: `cargo test -p zeck-core`
Expected: PASS.

- [ ] **Step 3: Manual testnet smoke (single seed)**

Same as Task 5 step 3. Confirm timing is comparable.

- [ ] **Step 4: Commit**

```bash
git add crates/zeck-core/src/scan.rs
git commit -m "refactor: single-seed sync uses fetcher/scanner split"
```

---

## Phase 3 — MultiSeedRun Orchestrator

### Task 9: Resolver — derive, dedup, sort, auto-detect birthday

**Files:**
- Create: `crates/zeck-core/src/multi_seed.rs` (`mod resolver`)
- Modify: `crates/zeck-core/src/lib.rs`

- [ ] **Step 1: Define types**

```rust
pub struct SeedEntry { pub phrase: SecretString, pub birthday: Option<u32>, pub label: Option<String> }
pub struct ResolvedSeed { pub index: usize, pub fingerprint: String, pub birthday: u32, pub label: Option<String>, pub seed_bytes: SecretVec<u8>, pub accounts: Vec<DerivedAccount> }
pub enum ResolveError { InvalidPhrase { index: usize, msg: String }, DuplicateFingerprint { indexes: Vec<usize>, fingerprint: String }, BirthdayDetectionFailed { index: usize, msg: String } }
```

- [ ] **Step 2: Write failing tests**

```rust
#[tokio::test]
async fn resolver_rejects_duplicate_fingerprints() { /* two entries with same phrase */ }

#[tokio::test]
async fn resolver_sorts_by_birthday_ascending() { /* three entries, birthdays 200, 100, 150 */ }

#[tokio::test]
async fn resolver_falls_back_to_sapling_activation_on_detection_failure() { /* mock detect_birthday to fail */ }
```

- [ ] **Step 3: Implement**

`resolve_seeds(entries, network, lightwalletd_url) -> Result<Vec<ResolvedSeed>, ResolveError>`:
1. For each: `validate_mnemonic_words` → derive seed bytes → `derive_accounts` → compute fingerprint (use `seed_fingerprint::SeedFingerprint`).
2. Detect duplicates by fingerprint → error.
3. For entries with `birthday: None`, call `detect_birthday`; on failure, fall back to Sapling activation height for the network and attach a warning (return alongside seeds, see Step 4).
4. Sort by birthday ascending.

- [ ] **Step 4: Add `ResolveWarning` to capture fallback events for UI surfacing**

Return `(Vec<ResolvedSeed>, Vec<ResolveWarning>)` from `resolve_seeds`.

- [ ] **Step 5: Run tests**

Run: `cargo test -p zeck-core multi_seed::resolver::tests`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/zeck-core/src/multi_seed.rs crates/zeck-core/src/lib.rs
git commit -m "feat: multi-seed resolver with dedup, sort, birthday detection"
```

### Task 10: Resolver — resume by `(data_dir, network, fingerprint)`

**Files:**
- Modify: `crates/zeck-core/src/multi_seed.rs`
- Modify: `crates/zeck-core/src/workspace.rs`

- [ ] **Step 1: Add `find_existing_workspace(data_dir, network, fingerprint) -> Option<RecoveryWorkspace>`**

Walk `data_dir` for any subdirectory whose `seed_fingerprint` matches; load its stored birthday/`num_accounts`/`gap_limit` from a `meta.json` (create one if it doesn't already exist — check current workspace structure first; `RecoveryWorkspace::initialize` likely already writes one).

- [ ] **Step 2: Write failing test**

Create a fake workspace under a tempdir, then call `find_existing_workspace` with its fingerprint and assert it returns the same path and birthday.

- [ ] **Step 3: Implement**

If `meta.json` doesn't exist today, also add Task 10a: write meta on `RecoveryWorkspace::initialize`. Inspect `workspace.rs:70` to confirm.

- [ ] **Step 4: Update resolver to use existing workspace's birthday when found**

If `find_existing_workspace` returns Some, override the user-supplied birthday with the stored one and emit a `ResolveWarning::ResumingExisting { index, height }`.

- [ ] **Step 5: Tests pass**

Run: `cargo test -p zeck-core multi_seed::resolver`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/zeck-core/
git commit -m "feat: resolver resumes by fingerprint, ignores user-entered birthday"
```

### Task 11: `MultiSeedRun` orchestrator

**Files:**
- Modify: `crates/zeck-core/src/multi_seed.rs`

- [ ] **Step 1: Define progress types**

```rust
pub struct MultiSeedProgress {
    pub blocks_scanned: u64,
    pub synced_to_height: Option<BlockHeight>,
    pub discoveries: Vec<ScanDiscovery>,
    pub per_seed: Vec<SeedProgress>,
    pub fetcher: FetcherProgress,
    pub phase: MultiSeedPhase, // Resolving | Scanning | Completed | Cancelled | Failed
    pub warnings: Vec<ResolveWarning>,
}
```

- [ ] **Step 2: Define `MultiSeedRun` and entry point**

```rust
pub struct MultiSeedRun { state: Arc<Mutex<MultiSeedProgress>>, cancel: CancellationToken, task: JoinHandle<()> }

pub async fn start_multi_seed_run(
    entries: Vec<SeedEntry>,
    config: MultiSeedConfig, // data_dir, network, lightwalletd_url, gap_limit, num_accounts
) -> ZeckResult<MultiSeedRun> { ... }
```

- [ ] **Step 3: Write failing integration-shaped test**

```rust
#[tokio::test]
async fn multi_seed_run_two_seeds_share_one_download() {
    // Two distinct fixture seeds (different fingerprints).
    // Mock client tracks how many distinct heights it served.
    // Assert each height was fetched at most once.
}
```

- [ ] **Step 4: Implement orchestrator**

Body:
1. Resolve seeds. Update phase = Resolving → on error, set Failed and return.
2. Open `SharedCacheWriter` (acquire lock). On `CacheOpenError::Locked`, return `ZeckError::CacheLocked`.
3. For each `ResolvedSeed`, open-or-init its `RecoveryWorkspace`, import accounts (reuse `import_accounts` from scan.rs — extract if needed). Migrate per-workspace cache via `writer.migrate_from(...)`.
4. Compute `start = min over seeds of max(seed.birthday, seed.fully_scanned_height + 1)`.
5. Spawn fetcher.
6. Spawn N scanners.
7. Spawn aggregator task: every 250ms, lock per-seed progress, recompute `blocks_scanned` and `synced_to_height` aggregates, drain new discoveries from each scanner's append-only log into the run-level `discoveries` (carrying `seed_index`).
8. On all scanner tasks completing, set phase = Completed.
9. On cancel, signal cancel token; wait for tasks to drain; phase = Cancelled.

- [ ] **Step 5: Run test to pass**

Run: `cargo test -p zeck-core multi_seed`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/zeck-core/src/multi_seed.rs
git commit -m "feat: MultiSeedRun orchestrator with shared fetcher and per-seed scanners"
```

### Task 12: Add `seed_index`, `seed_fingerprint` to `ScanDiscovery`

**Files:**
- Modify: `crates/zeck-core/src/models.rs`
- Modify: `crates/zeck-core/src/scan.rs` (call sites)

- [ ] **Step 1: Add fields with sensible defaults for single-seed**

```rust
pub struct ScanDiscovery {
    // existing fields...
    pub seed_index: usize,        // 0 for single-seed runs
    pub seed_fingerprint: String, // fingerprint hex
}
```

- [ ] **Step 2: Update construction sites in `scan.rs::append_new_discoveries` (line ~1191)**

Pass through the seed's index/fingerprint via the scanner spec.

- [ ] **Step 3: Update existing tests**

Any test that constructs a `ScanDiscovery` literal now needs the two new fields.

- [ ] **Step 4: Run all tests**

Run: `cargo test -p zeck-core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/zeck-core/src/models.rs crates/zeck-core/src/scan.rs
git commit -m "feat: ScanDiscovery carries seed_index and fingerprint"
```

---

## Phase 4 — Service + Tauri Commands

### Task 13: `RecoveryService` multi-seed methods

**Files:**
- Modify: `crates/zeck-core/src/service.rs`

- [ ] **Step 1: Add fields and methods**

```rust
impl RecoveryService {
    pub async fn start_multi_scan(&self, entries: Vec<SeedEntry>, config: MultiSeedConfig) -> ZeckResult<MultiScanHandle>;
    pub async fn get_multi_scan_progress(&self, handle: &MultiScanHandle) -> ZeckResult<MultiSeedProgress>;
    pub async fn cancel_multi_scan(&self, handle: &MultiScanHandle) -> ZeckResult<()>;
}
```

Mirror the existing single-seed handle/state pattern (service.rs:71). Store active runs in `Arc<Mutex<HashMap<MultiScanHandle, MultiSeedRun>>>`.

- [ ] **Step 2: Tests via existing service-level test pattern**

Run: `cargo test -p zeck-core service`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/zeck-core/src/service.rs
git commit -m "feat: RecoveryService multi-seed start/progress/cancel"
```

### Task 14: Tauri commands and pump loop

**Files:**
- Modify: `gui/src-tauri/src/commands.rs`
- Modify: `gui/src-tauri/src/main.rs`

- [ ] **Step 1: Add commands**

```rust
#[tauri::command]
pub async fn start_multi_scan(
    state: State<'_, AppState>,
    seeds: Vec<MultiSeedEntryDto>,
    config: MultiScanConfigDto,
    window: Window,
) -> Result<MultiScanHandle, String> { ... }

#[tauri::command]
pub async fn get_multi_scan_progress(state: State<'_, AppState>, handle: MultiScanHandle) -> Result<MultiSeedProgress, String> { ... }

#[tauri::command]
pub async fn cancel_multi_scan(state: State<'_, AppState>, handle: MultiScanHandle) -> Result<(), String> { ... }
```

`start_multi_scan` spawns a pump task that polls `get_multi_scan_progress` every 250ms and emits `multi-scan-progress` events to the window. Track per-scanner discovery cursors (`Vec<usize>`) so each `ScanDiscovery` is emitted exactly once.

- [ ] **Step 2: Register in `main.rs::invoke_handler`**

- [ ] **Step 3: `cargo check -p zeck-tauri` (or whatever the Tauri crate is named)**

Run: `cargo check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add gui/src-tauri/
git commit -m "feat: Tauri commands for multi-seed scan"
```

---

## Phase 5 — GUI

### Task 15: Seed entry list UI

**Files:**
- Modify: `gui/src/index.html`
- Modify: `gui/src/main.js`
- Modify: `gui/src/styles.css`

- [ ] **Step 1: HTML — make seed input a row template + container**

Add a hidden `<template id="seed-row-template">` with the existing single-seed inputs. Replace the single seed-input panel with `<div id="seed-rows"></div>` and a `<button id="add-seed">+ Add another seed</button>`.

- [ ] **Step 2: JS — `addSeedRow()`, `removeSeedRow(rowEl)`, validation per row**

Mirror current single-seed validation. Disable "Start scan" until at least one row validates and all birthdays are resolved.

- [ ] **Step 3: JS — wire "Start scan" to `invoke('start_multi_scan', { seeds, config })`**

Use the multi-seed command unconditionally (single-seed becomes N=1 multi-seed; remove the old `start_scan` invocation from the GUI; the backend command stays for any external callers).

- [ ] **Step 4: CSS — visual treatment for rows**

- [ ] **Step 5: Manual smoke**

Run `npm run tauri dev` from `gui/`. Add 2 rows, validate seeds, confirm "Start scan" enables.

- [ ] **Step 6: Commit**

```bash
git add gui/src/
git commit -m "feat: GUI multi-seed entry with add/remove rows"
```

### Task 16: Per-seed progress cards

**Files:**
- Modify: `gui/src/index.html`, `gui/src/main.js`, `gui/src/styles.css`

- [ ] **Step 1: HTML — aggregate header + per-seed card stack**

Aggregate header: blocks-scanned, downloaded-to height (fetcher), ETA, retry count.
Per-seed card template: label, fingerprint short, birthday, scanned-to height, status pill.

- [ ] **Step 2: JS — listen for `multi-scan-progress` events, render**

Render strategy: render once on first event, then mutate DOM nodes by `data-seed-index` on subsequent events. No full re-render per tick.

Discoveries feed: per-seed grouping; append-only.

- [ ] **Step 3: Manual smoke against testnet**

Confirm earliest-birthday seed begins producing discoveries first; later seeds catch up after fetcher passes their birthday.

- [ ] **Step 4: Commit**

```bash
git add gui/src/
git commit -m "feat: GUI per-seed progress cards and aggregate header"
```

### Task 17: Multi-seed sweep view

**Files:**
- Modify: `gui/src/index.html`, `gui/src/main.js`, `gui/src/styles.css`
- Modify: `gui/src-tauri/src/commands.rs` (add `propose_sweep_all`, `execute_sweep_all`)

- [ ] **Step 1: Backend commands**

`propose_sweep_all(handle, destination) -> Vec<PerSeedSweepProposal>` — calls existing `propose_sweep` for each funded seed in turn.
`execute_sweep_all(handle, destination) -> Vec<PerSeedSweepResult>` — calls existing `execute_sweep` sequentially; failures don't abort remaining.

- [ ] **Step 2: GUI sweep screen**

Header: "X of N seeds funded — Y.YY ZEC total."
Single destination address input.
Per-seed summary list (collapsed by default, expandable).
"Sweep all" button → progress list, per-seed status updates.

- [ ] **Step 3: Manual smoke**

With one funded test seed + one empty seed, run a multi-seed scan, then sweep all. Verify only the funded seed produces a proposal/transaction; empty seed reported as skipped.

- [ ] **Step 4: Commit**

```bash
git add gui/
git commit -m "feat: multi-seed sweep with single destination"
```

---

## Phase 6 — CLI

### Task 18: Repeated `--seed`/`--birthday` and `--seeds-file`

**Files:**
- Modify: `crates/zeck-cli/src/main.rs`

- [ ] **Step 1: Update clap args**

```rust
#[derive(Parser)]
struct ScanArgs {
    #[arg(long)]
    seed: Vec<String>, // can repeat
    #[arg(long)]
    seed_file: Option<PathBuf>, // existing single-seed file path
    #[arg(long)]
    birthday: Vec<String>, // either u32 or "auto"; aligns positionally with seeds
    #[arg(long)]
    seeds_file: Option<PathBuf>, // new: one entry per line, "phrase" or "phrase | birthday"
    // ... rest unchanged
}
```

Validation: if `seeds_file` is set, `seed`/`birthday` must be empty. Otherwise `birthday.len() == seed.len()` (or `birthday` empty → all auto).

- [ ] **Step 2: Parse `seeds_file` format**

```rust
fn parse_seeds_file(path: &Path) -> Result<Vec<SeedEntry>>
```

Each line: trim → skip empty/`#`-comments → split on `|` → first half is phrase, second (optional) is birthday (`auto` or u32). Reject lines with more than one `|`.

- [ ] **Step 3: Test the parser**

```rust
#[test]
fn parses_phrase_only_line() { ... }
#[test]
fn parses_phrase_and_birthday() { ... }
#[test]
fn rejects_malformed_line() { ... }
```

- [ ] **Step 4: Wire CLI to `RecoveryService::start_multi_scan`**

Replace the existing single-seed `service.start_scan(...)` call in `Commands::Scan` (main.rs:189) with `service.start_multi_scan(entries, config)`. The single-seed path becomes a degenerate N=1.

- [ ] **Step 5: Run tests**

Run: `cargo test -p zeck-cli`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/zeck-cli/src/main.rs
git commit -m "feat: CLI multi-seed input via repeated --seed or --seeds-file"
```

### Task 19: CLI per-seed progress table

**Files:**
- Modify: `crates/zeck-cli/src/main.rs` (`wait_for_scan` and friends)

- [ ] **Step 1: Replace `wait_for_scan` with `wait_for_multi_scan`**

Render an in-place updating table:

```
seed   label         birthday   scanned    status
[ 0]   primary       2,400,000  2,402,317  ✓ done
[ 1]   old-cold      2,500,000  2,500,000  ⠋ scanning
[ 2]   archived      2,600,000      —      pending
fetcher  downloaded 2,500,000 / target 2,650,000  retries 1
```

Use `crossterm` (already a probable dep — check `Cargo.toml`) or simple ANSI cursor-up codes. Keep `tracing` debug output below the table.

- [ ] **Step 2: Update `print_scan_result` and `notify_scan_complete` to summarize per-seed**

`scan_completion_summary` becomes "X of N seeds funded — Y.YY ZEC".

- [ ] **Step 3: Manual smoke**

Run a 2-seed CLI scan against testnet and confirm the table renders cleanly without flicker.

- [ ] **Step 4: Commit**

```bash
git add crates/zeck-cli/src/main.rs
git commit -m "feat: CLI per-seed progress table for multi-seed scans"
```

### Task 20: CLI sweep-all flow

**Files:**
- Modify: `crates/zeck-cli/src/main.rs`

- [ ] **Step 1: Update `Commands::Sweep`**

Prompt: "X of N seeds funded — Y.YY ZEC total. Destination address?" → run per-seed proposals → confirm → execute sequentially.

- [ ] **Step 2: Manual smoke**

- [ ] **Step 3: Commit**

```bash
git add crates/zeck-cli/src/main.rs
git commit -m "feat: CLI sweep-all for multi-seed runs"
```

---

## Phase 7 — Integration Tests + Docs

### Task 21: Integration test against mocked lightwalletd

**Files:**
- Create: `crates/zeck-core/tests/multi_seed_integration.rs`

- [ ] **Step 1: Two distinct test seeds, mock client serving compact blocks**

Use two BIP-39 test vectors (existing test seed + a second deterministic phrase). Mock client tracks per-height fetch counts.

- [ ] **Step 2: Assertions**

- Each block height fetched at most once.
- Both wallet DBs reach `final_tip`.
- First discovery in the run is from the earliest-birthday seed.
- After tip, `MultiSeedProgress::phase == Completed`.

- [ ] **Step 3: Mid-run cancel test**

Cancel halfway, assert workspaces are resumable: re-run with same seeds, assert resume picks up from `fully_scanned_height`.

- [ ] **Step 4: Commit**

```bash
git add crates/zeck-core/tests/multi_seed_integration.rs
git commit -m "test: multi-seed integration coverage"
```

### Task 22: TESTING.md update

**Files:**
- Modify: `TESTING.md`

- [ ] **Step 1: Add multi-seed test checklist**

Sections: GUI add/remove rows, GUI multi-seed scan flow, GUI sweep-all, CLI repeated --seed, CLI --seeds-file, CLI sweep-all, mid-run cancel, resume of mid-cancelled run, single-seed regression on shared cache.

- [ ] **Step 2: Commit**

```bash
git add TESTING.md
git commit -m "docs: TESTING.md multi-seed checklist"
```

### Task 23: Final manual end-to-end on testnet

- [ ] **Step 1: Two-seed GUI run**

Add two seeds with different birthdays, scan, observe per-seed cards, sweep to a single destination. Verify expected balance ends up at destination.

- [ ] **Step 2: Mid-run cancel and resume**

Start a 2-seed run, cancel mid-scan, restart with same inputs. Confirm resume from each seed's prior `fully_scanned_height`.

- [ ] **Step 3: Cross-process lock**

Start a CLI scan, then attempt a second concurrent CLI scan against same data dir. Confirm second one fails with "another ZECK scan is in progress".

- [ ] **Step 4: Update CLAUDE.md if any architectural facts changed**

The cache location and the fetcher/scanner split are noteworthy. Add a short bullet under "Scan architecture" in `CLAUDE.md`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note shared cache and fetcher/scanner split"
```

---

## Done Criteria

- All tasks above checked off.
- `cargo test --workspace` is green.
- `cargo clippy --workspace --all-targets -- -D warnings` is clean.
- TESTING.md checklist run end-to-end on testnet.
- Single-seed scan continues to work via the new code path with no user-visible regression.
