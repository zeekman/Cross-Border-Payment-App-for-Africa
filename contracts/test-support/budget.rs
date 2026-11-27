//! SC-215: shared resource-budget regression harness.
//!
//! Included into each contract crate's `test_budget` module with
//! `#[path = "../../test-support/budget.rs"] mod budget;` so every crate
//! measures and compares the same way against one checked-in baseline file,
//! `contracts/budgets.json`.
//!
//! How a check works:
//! 1. [`measure`] resets the host budget immediately before the call under
//!    test, so the numbers cover that single invocation and none of the setup.
//! 2. [`check`] prints one row of the CI table and compares the measured CPU
//!    instructions and memory bytes against the baseline for that name.
//!    Exceeding the baseline by more than [`TOLERANCE_PCT`] fails the test.
//! 3. `UPDATE_BUDGETS=1` records the measured values as the new baseline
//!    instead of comparing (see `contracts/README.md`).
//!
//! A name with no baseline yet (`null` in `budgets.json`) is reported as
//! `NO BASELINE`. That fails under CI (`CI` set) so a new hot path can't be
//! merged without a baseline, and passes locally so it can be recorded.

#![allow(dead_code)]

extern crate std;

use soroban_sdk::Env;
use std::{
    collections::BTreeMap,
    eprintln, format, fs, println,
    string::{String, ToString},
    sync::Mutex,
    vec::Vec,
};

/// A function may use this much more than its baseline before the test fails.
pub const TOLERANCE_PCT: u64 = 10;

/// Serialises reads/writes of `budgets.json` between tests running in
/// parallel threads of the same test binary.
static BUDGETS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug)]
pub struct Measurement {
    pub cpu: u64,
    pub mem: u64,
}

type Baselines = BTreeMap<String, Option<(u64, u64)>>;

/// Run `f` (a single contract invocation) and return its result together with
/// the CPU instructions and memory bytes it consumed.
pub fn measure<R>(env: &Env, f: impl FnOnce() -> R) -> (R, Measurement) {
    // Unlimited so a large-state call reports its cost instead of aborting on
    // the default limits; the tracker is reset, so only `f` is counted.
    env.cost_estimate().budget().reset_unlimited();
    let out = f();
    let budget = env.cost_estimate().budget();
    let m = Measurement {
        cpu: budget.cpu_instruction_cost(),
        mem: budget.memory_bytes_cost(),
    };
    (out, m)
}

/// Lift the default budget limits for a test's setup phase (e.g. creating
/// hundreds of vaults or schedules before the measured call).
pub fn unlimited_setup(env: &Env) {
    env.cost_estimate().budget().reset_unlimited();
}

/// Compare `m` with the baseline stored under `name` in `budgets.json`.
pub fn check(name: &str, m: Measurement) {
    let _guard = BUDGETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = budgets_path();
    let mut baselines = load(&path);
    let baseline = baselines.get(name).copied().flatten();

    print_row(name, m, baseline);

    if env_flag("UPDATE_BUDGETS") {
        baselines.insert(name.to_string(), Some((m.cpu, m.mem)));
        save(&path, &baselines);
        return;
    }

    match baseline {
        None => {
            let msg = format!(
                "no baseline for `{name}` in contracts/budgets.json \
                 (measured cpu={} mem={}). Record it with \
                 `UPDATE_BUDGETS=1 cargo test budget_` and commit budgets.json.",
                m.cpu, m.mem
            );
            if env_flag("CI") {
                panic!("{msg}");
            }
            eprintln!("warning: {msg}");
        }
        Some((base_cpu, base_mem)) => {
            assert!(
                within_tolerance(m.cpu, base_cpu),
                "`{name}` CPU instructions regressed: {} vs baseline {} ({:+.1}%, limit +{}%). \
                 If the increase is intended, update the baseline (see contracts/README.md).",
                m.cpu,
                base_cpu,
                pct_change(m.cpu, base_cpu),
                TOLERANCE_PCT
            );
            assert!(
                within_tolerance(m.mem, base_mem),
                "`{name}` memory bytes regressed: {} vs baseline {} ({:+.1}%, limit +{}%). \
                 If the increase is intended, update the baseline (see contracts/README.md).",
                m.mem,
                base_mem,
                pct_change(m.mem, base_mem),
                TOLERANCE_PCT
            );
        }
    }
}

/// Convenience: measure `f` and check it under `name` in one step.
pub fn assert_budget<R>(env: &Env, name: &str, f: impl FnOnce() -> R) -> R {
    let (out, m) = measure(env, f);
    check(name, m);
    out
}

fn within_tolerance(measured: u64, baseline: u64) -> bool {
    (measured as u128) * 100 <= (baseline as u128) * (100 + TOLERANCE_PCT as u128)
}

fn pct_change(measured: u64, baseline: u64) -> f64 {
    if baseline == 0 {
        return 0.0;
    }
    (measured as f64 - baseline as f64) * 100.0 / baseline as f64
}

fn print_row(name: &str, m: Measurement, baseline: Option<(u64, u64)>) {
    let (base_cpu, base_mem, delta_cpu, delta_mem, status) = match baseline {
        Some((c, b)) => {
            let ok = within_tolerance(m.cpu, c) && within_tolerance(m.mem, b);
            (
                c.to_string(),
                b.to_string(),
                format!("{:+.1}%", pct_change(m.cpu, c)),
                format!("{:+.1}%", pct_change(m.mem, b)),
                if ok { "ok" } else { "OVER" },
            )
        }
        None => ("-".into(), "-".into(), "-".into(), "-".into(), "NO BASELINE"),
    };
    println!(
        "| {:<48} | {:>12} | {:>12} | {:>7} | {:>10} | {:>10} | {:>7} | {:<11} |",
        name, m.cpu, base_cpu, delta_cpu, m.mem, base_mem, delta_mem, status
    );
}

fn env_flag(var: &str) -> bool {
    match std::env::var(var) {
        Ok(v) => !v.is_empty() && v != "0" && v != "false",
        Err(_) => false,
    }
}

fn budgets_path() -> String {
    format!("{}/../budgets.json", env!("CARGO_MANIFEST_DIR"))
}

/// Parse `budgets.json`. The file is machine-written by [`save`] with one
/// entry per line, so a line-based reader is enough and avoids pulling a JSON
/// dependency into every contract crate:
///
/// ```json
///   "escrow::create_escrow": { "cpu": 123, "mem": 456 },
/// ```
fn load(path: &str) -> Baselines {
    let mut out = Baselines::new();
    let Ok(text) = fs::read_to_string(path) else {
        return out;
    };
    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with('"') || !line.contains("\"cpu\"") {
            continue;
        }
        let Some(end) = line[1..].find('"') else { continue };
        let key = &line[1..1 + end];
        let cpu = field(line, "\"cpu\"");
        let mem = field(line, "\"mem\"");
        let value = match (cpu, mem) {
            (Some(c), Some(m)) => Some((c, m)),
            _ => None,
        };
        out.insert(key.to_string(), value);
    }
    out
}

/// Value of `"name": <number|null>` within `line`, or `None` for `null`.
fn field(line: &str, name: &str) -> Option<u64> {
    let start = line.find(name)? + name.len();
    let rest = line[start..].trim_start().strip_prefix(':')?.trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn save(path: &str, baselines: &Baselines) {
    let mut lines: Vec<String> = Vec::new();
    lines.push("{".into());
    lines.push(
        "  \"_comment\": \"SC-215 resource baselines (CPU instructions, memory bytes) per hot path. \
         Tests fail when a call exceeds its baseline by more than 10%. \
         Regenerate with UPDATE_BUDGETS=1 cargo test budget_ (see contracts/README.md).\","
            .into(),
    );
    let n = baselines.len();
    for (i, (name, value)) in baselines.iter().enumerate() {
        let comma = if i + 1 < n { "," } else { "" };
        let entry = match value {
            Some((cpu, mem)) => format!("  \"{name}\": {{ \"cpu\": {cpu}, \"mem\": {mem} }}{comma}"),
            None => format!("  \"{name}\": {{ \"cpu\": null, \"mem\": null }}{comma}"),
        };
        lines.push(entry);
    }
    lines.push("}".into());
    let mut text = lines.join("\n");
    text.push('\n');
    fs::write(path, text).expect("failed to write contracts/budgets.json");
}
