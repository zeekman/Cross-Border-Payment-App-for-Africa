//! SC-216: shared event-snapshot harness.
//!
//! Included into a contract crate's `test_events` module with
//! `#[path = "../../test-support/events.rs"] mod events;`.
//!
//! A test scripts a flow, calls [`EventSnapshot::capture`] after each contract
//! call (the test env only keeps the events of the most recent invocation),
//! and finally [`EventSnapshot::assert_matches`] compares the rendered events
//! with `<crate>/event_snapshots/<name>.snap`. Any change to an event's name,
//! topics or payload fields therefore shows up as a diff of a checked-in text
//! file in code review, and the backend indexer can be updated in the same PR.
//!
//! Rendering is deliberately human-readable: symbols and strings print as
//! text, `#[contracttype]` structs print as `{field: value, ...}`, and
//! addresses print as the names the test gave them (`sender`, `agent`, …).
//!
//! - Missing snapshot: written and reported locally; fails under CI (`CI`
//!   set) so a new flow can't be merged without its snapshot.
//! - Mismatch: fails with a line diff. `UPDATE_EVENT_SNAPSHOTS=1` rewrites
//!   the snapshot instead (see `contracts/README.md`).

#![allow(dead_code)]

extern crate std;

use soroban_sdk::{testutils::Events as _, xdr, Address, Env, TryFromVal};
use std::{
    eprintln, format, fs,
    string::{String, ToString},
    vec::Vec,
};

pub struct EventSnapshot<'a> {
    env: &'a Env,
    contract: Address,
    names: Vec<(Address, String)>,
    lines: Vec<String>,
}

impl<'a> EventSnapshot<'a> {
    /// Record events emitted by `contract` (events from other contracts, such
    /// as token transfers, are ignored so the snapshot only tracks our schema).
    pub fn new(env: &'a Env, contract: &Address) -> Self {
        let mut s = Self {
            env,
            contract: contract.clone(),
            names: Vec::new(),
            lines: Vec::new(),
        };
        s.name(contract, "contract");
        s
    }

    /// Render `addr` as `name` in the snapshot instead of its raw strkey.
    pub fn name(&mut self, addr: &Address, name: &str) -> &mut Self {
        self.names.push((addr.clone(), name.to_string()));
        self
    }

    /// Append the events of the most recent invocation under the label `step`.
    pub fn capture(&mut self, step: &str) {
        let mut rendered: Vec<String> = Vec::new();
        for e in self.env.events().all().events() {
            let Some(contract_id) = e.contract_id.clone() else {
                continue;
            };
            let Ok(emitter) =
                Address::try_from_val(self.env, &xdr::ScAddress::Contract(contract_id))
            else {
                continue;
            };
            if emitter != self.contract {
                continue;
            }
            let xdr::ContractEventBody::V0(body) = &e.body;
            let topics: Vec<String> = body.topics.iter().map(|t| self.render(t)).collect();
            rendered.push(format!(
                "{step}: topics=[{}] data={}",
                topics.join(", "),
                self.render(&body.data)
            ));
        }
        if rendered.is_empty() {
            rendered.push(format!("{step}: (no events)"));
        }
        self.lines.extend(rendered);
    }

    /// Compare everything captured so far with `event_snapshots/<name>.snap`.
    pub fn assert_matches(&self, name: &str) {
        let dir = format!("{}/event_snapshots", env!("CARGO_MANIFEST_DIR"));
        let path = format!("{dir}/{name}.snap");

        let mut actual = String::new();
        actual.push_str(
            "# Event snapshot (SC-216). Do not edit by hand: regenerate with\n\
             # UPDATE_EVENT_SNAPSHOTS=1 cargo test events_ and review the diff.\n",
        );
        for line in &self.lines {
            actual.push_str(line);
            actual.push('\n');
        }

        let write = || {
            fs::create_dir_all(&dir).expect("failed to create event_snapshots/");
            fs::write(&path, &actual).expect("failed to write event snapshot");
        };

        if env_flag("UPDATE_EVENT_SNAPSHOTS") {
            write();
            return;
        }

        match fs::read_to_string(&path) {
            Err(_) => {
                if env_flag("CI") {
                    panic!(
                        "missing event snapshot {path}. Generate it with \
                         `UPDATE_EVENT_SNAPSHOTS=1 cargo test events_` and commit it.\n\n{actual}"
                    );
                }
                write();
                eprintln!("warning: wrote new event snapshot {path}; review and commit it");
            }
            Ok(expected) => {
                if normalize(&expected) != normalize(&actual) {
                    panic!(
                        "event snapshot {path} changed. If the change is intended, \
                         update contracts/EVENTS.md, bump `event_version` where the convention \
                         applies, and rerun with UPDATE_EVENT_SNAPSHOTS=1.\n{}",
                        diff(&expected, &actual)
                    );
                }
            }
        }
    }

    fn address_name(&self, a: &xdr::ScAddress) -> String {
        if let Ok(addr) = Address::try_from_val(self.env, a) {
            if let Some((_, n)) = self.names.iter().find(|(x, _)| *x == addr) {
                return n.clone();
            }
        }
        format!("{a:?}")
    }

    fn render(&self, v: &xdr::ScVal) -> String {
        use xdr::ScVal;
        match v {
            ScVal::Bool(b) => b.to_string(),
            ScVal::Void => "()".into(),
            ScVal::U32(n) => format!("{n}u32"),
            ScVal::I32(n) => format!("{n}i32"),
            ScVal::U64(n) => format!("{n}u64"),
            ScVal::I64(n) => format!("{n}i64"),
            ScVal::Timepoint(t) => format!("{}u64", t.0),
            ScVal::Duration(d) => format!("{}u64", d.0),
            ScVal::U128(p) => format!("{}u128", ((p.hi as u128) << 64) | p.lo as u128),
            ScVal::I128(p) => format!("{}i128", ((p.hi as i128) << 64) | p.lo as i128),
            ScVal::Symbol(s) => s.0.to_utf8_string_lossy(),
            ScVal::String(s) => format!("{:?}", s.0.to_utf8_string_lossy()),
            ScVal::Bytes(b) => {
                let hex: String = b.0.iter().map(|x| format!("{x:02x}")).collect();
                format!("0x{hex}")
            }
            ScVal::Address(a) => self.address_name(a),
            ScVal::Vec(Some(items)) => {
                let parts: Vec<String> = items.0.iter().map(|x| self.render(x)).collect();
                format!("[{}]", parts.join(", "))
            }
            ScVal::Vec(None) => "[]".into(),
            ScVal::Map(Some(entries)) => {
                let parts: Vec<String> = entries
                    .0
                    .iter()
                    .map(|e| format!("{}: {}", self.render(&e.key), self.render(&e.val)))
                    .collect();
                format!("{{{}}}", parts.join(", "))
            }
            ScVal::Map(None) => "{}".into(),
            other => format!("{other:?}"),
        }
    }
}

fn env_flag(var: &str) -> bool {
    match std::env::var(var) {
        Ok(v) => !v.is_empty() && v != "0" && v != "false",
        Err(_) => false,
    }
}

fn normalize(s: &str) -> String {
    s.replace("\r\n", "\n").trim_end().to_string()
}

/// Minimal positional line diff — enough to spot the changed event.
fn diff(expected: &str, actual: &str) -> String {
    let e: Vec<&str> = expected.lines().collect();
    let a: Vec<&str> = actual.lines().collect();
    let mut out = String::new();
    for i in 0..e.len().max(a.len()) {
        match (e.get(i), a.get(i)) {
            (Some(x), Some(y)) if x == y => {}
            (x, y) => {
                if let Some(x) = x {
                    out.push_str(&format!("- {x}\n"));
                }
                if let Some(y) = y {
                    out.push_str(&format!("+ {y}\n"));
                }
            }
        }
    }
    out
}
