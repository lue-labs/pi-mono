use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::fs::{File, metadata};
use std::io::{self, BufRead, BufReader};
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug)]
struct EntryMetadata {
    id: String,
    parent_id: Option<String>,
    entry_type: String,
    timestamp: String,
    first_kept_entry_id: Option<String>,
    tokens_before: Option<f64>,
    message_role: Option<String>,
    api: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    stop_reason: Option<String>,
    is_error: Option<bool>,
    custom_type: Option<String>,
    display: Option<bool>,
    from_id: Option<String>,
    command: Option<String>,
    tool_call_ids: Vec<String>,
    tool_result_call_id: Option<String>,
    tool_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileFingerprint {
    size_bytes: u64,
    modified_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StubMetadata {
    id: String,
    parent_id: Option<String>,
    entry_type: String,
    timestamp: String,
    message_role: Option<String>,
    api: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    stop_reason: Option<String>,
    is_error: Option<bool>,
    custom_type: Option<String>,
    display: Option<bool>,
    from_id: Option<String>,
    command: Option<String>,
    tool_call_ids: Vec<String>,
    tool_result_call_id: Option<String>,
    tool_name: Option<String>,
    first_kept_entry_id: Option<String>,
    tokens_before: Option<f64>,
}

impl From<&EntryMetadata> for StubMetadata {
    fn from(entry: &EntryMetadata) -> Self {
        Self {
            id: entry.id.clone(),
            parent_id: entry.parent_id.clone(),
            entry_type: entry.entry_type.clone(),
            timestamp: entry.timestamp.clone(),
            message_role: entry.message_role.clone(),
            api: entry.api.clone(),
            provider: entry.provider.clone(),
            model: entry.model.clone(),
            stop_reason: entry.stop_reason.clone(),
            is_error: entry.is_error,
            custom_type: entry.custom_type.clone(),
            display: entry.display,
            from_id: entry.from_id.clone(),
            command: entry.command.clone(),
            tool_call_ids: entry.tool_call_ids.clone(),
            tool_result_call_id: entry.tool_result_call_id.clone(),
            tool_name: entry.tool_name.clone(),
            first_kept_entry_id: entry.first_kept_entry_id.clone(),
            tokens_before: entry.tokens_before,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanOutput {
    file_fingerprint: FileFingerprint,
    candidate_ids: Vec<String>,
    protected_ids: Vec<String>,
    stub_metadata: Vec<StubMetadata>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptStats {
    bytes: u64,
    entries: u64,
    messages: u64,
    tool_results: u64,
    compactions: u64,
}

#[derive(Clone, Copy)]
struct PlanOptions {
    stub_summarized_entries: bool,
    stub_tool_results: bool,
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value.get(field)?.as_str().map(ToOwned::to_owned)
}

fn nullable_string_field(value: &Value, field: &str) -> Option<Option<String>> {
    let value = value.get(field)?;
    if value.is_null() {
        Some(None)
    } else {
        value.as_str().map(|value| Some(value.to_owned()))
    }
}

fn tool_call_ids(message: &Value) -> Vec<String> {
    message
        .get("content")
        .and_then(Value::as_array)
        .map(|content| {
            content
                .iter()
                .filter(|block| string_field(block, "type").as_deref() == Some("toolCall"))
                .filter_map(|block| string_field(block, "id"))
                .collect()
        })
        .unwrap_or_default()
}

fn is_session_entry_type(entry_type: &str) -> bool {
    matches!(
        entry_type,
        "message"
            | "thinking_level_change"
            | "model_change"
            | "compaction"
            | "branch_summary"
            | "custom"
            | "custom_message"
            | "label"
            | "session_info"
    )
}

fn metadata_for_line(line: &str) -> Result<Option<EntryMetadata>, ()> {
    let value: Value = serde_json::from_str(line).map_err(|_| ())?;
    let entry_type = string_field(&value, "type").ok_or(())?;
    if entry_type == "session" {
        return Ok(None);
    }
    if !is_session_entry_type(&entry_type) {
        return Err(());
    }

    let id = string_field(&value, "id").ok_or(())?;
    let parent_id = nullable_string_field(&value, "parentId").ok_or(())?;
    let timestamp = string_field(&value, "timestamp").ok_or(())?;
    let message = value.get("message");
    let message_role = message.and_then(|message| string_field(message, "role"));

    Ok(Some(EntryMetadata {
        id,
        parent_id,
        entry_type: entry_type.clone(),
        timestamp,
        first_kept_entry_id: (entry_type == "compaction")
            .then(|| string_field(&value, "firstKeptEntryId"))
            .flatten(),
        tokens_before: (entry_type == "compaction")
            .then(|| value.get("tokensBefore").and_then(Value::as_f64))
            .flatten(),
        message_role: message_role.clone(),
        api: (entry_type == "message")
            .then(|| message.and_then(|message| string_field(message, "api")))
            .flatten(),
        provider: (entry_type == "message")
            .then(|| message.and_then(|message| string_field(message, "provider")))
            .flatten(),
        model: (entry_type == "message")
            .then(|| message.and_then(|message| string_field(message, "model")))
            .flatten(),
        stop_reason: (entry_type == "message")
            .then(|| message.and_then(|message| string_field(message, "stopReason")))
            .flatten(),
        is_error: (entry_type == "message")
            .then(|| {
                message
                    .and_then(|message| message.get("isError"))
                    .and_then(Value::as_bool)
            })
            .flatten(),
        custom_type: matches!(entry_type.as_str(), "message" | "custom" | "custom_message")
            .then(|| {
                if entry_type == "message" {
                    message.and_then(|message| string_field(message, "customType"))
                } else {
                    string_field(&value, "customType")
                }
            })
            .flatten(),
        display: matches!(entry_type.as_str(), "message" | "custom_message")
            .then(|| {
                if entry_type == "message" {
                    message
                        .and_then(|message| message.get("display"))
                        .and_then(Value::as_bool)
                } else {
                    value.get("display").and_then(Value::as_bool)
                }
            })
            .flatten(),
        from_id: (entry_type == "branch_summary")
            .then(|| string_field(&value, "fromId"))
            .flatten(),
        command: (entry_type == "message")
            .then(|| message.and_then(|message| string_field(message, "command")))
            .flatten(),
        tool_call_ids: message.map(tool_call_ids).unwrap_or_default(),
        tool_result_call_id: (entry_type == "message")
            .then(|| message.and_then(|message| string_field(message, "toolCallId")))
            .flatten(),
        tool_name: (entry_type == "message")
            .then(|| message.and_then(|message| string_field(message, "toolName")))
            .flatten(),
    }))
}

fn can_stub(entry: &EntryMetadata, options: PlanOptions) -> bool {
    match entry.entry_type.as_str() {
        "message" => match entry.message_role.as_deref() {
            Some("user") | Some("bashExecution") | Some("custom") => true,
            Some("assistant") => {
                entry.api.is_some() && entry.provider.is_some() && entry.model.is_some()
            }
            Some("toolResult") => options.stub_tool_results && entry.tool_result_call_id.is_some(),
            _ => false,
        },
        "custom_message" => options.stub_summarized_entries,
        "branch_summary" => options.stub_summarized_entries && entry.from_id.is_some(),
        "compaction" => options.stub_summarized_entries && entry.first_kept_entry_id.is_some(),
        _ => false,
    }
}

fn fingerprint(path: &Path) -> io::Result<FileFingerprint> {
    let metadata = metadata(path)?;
    let modified_ms = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or(0);
    Ok(FileFingerprint {
        size_bytes: metadata.len(),
        modified_ms,
    })
}

fn build_plan(path: &Path, options: PlanOptions) -> io::Result<Option<PlanOutput>> {
    let file = File::open(path)?;
    let reader = BufReader::with_capacity(1024 * 1024, file);
    let mut entries = Vec::new();
    let mut by_id = HashMap::new();
    let mut tool_call_entry_ids = HashMap::new();
    let mut tool_result_entry_ids = HashMap::new();

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Some(entry) = (match metadata_for_line(&line) {
            Ok(entry) => entry,
            Err(()) => return Ok(None),
        }) else {
            continue;
        };
        for tool_call_id in &entry.tool_call_ids {
            tool_call_entry_ids.insert(tool_call_id.clone(), entry.id.clone());
        }
        if let Some(tool_result_call_id) = &entry.tool_result_call_id {
            tool_result_entry_ids.insert(tool_result_call_id.clone(), entry.id.clone());
        }
        by_id.insert(entry.id.clone(), entry.clone());
        entries.push(entry);
    }

    let Some(leaf) = entries.last().cloned() else {
        return Ok(None);
    };
    let mut path_entries = Vec::new();
    let mut current = Some(leaf);
    while let Some(entry) = current {
        current = entry
            .parent_id
            .as_ref()
            .and_then(|parent_id| by_id.get(parent_id).cloned());
        path_entries.push(entry);
    }
    path_entries.reverse();

    let Some(compaction_index) = path_entries
        .iter()
        .rposition(|entry| entry.entry_type == "compaction")
    else {
        return Ok(None);
    };
    let Some(first_kept_entry_id) = path_entries[compaction_index].first_kept_entry_id.as_ref()
    else {
        return Ok(None);
    };
    let Some(first_kept_index) = path_entries
        .iter()
        .position(|entry| entry.id == *first_kept_entry_id)
    else {
        return Ok(None);
    };
    if first_kept_index >= compaction_index {
        return Ok(None);
    }

    let candidates = &path_entries[..first_kept_index];
    let candidate_ids: Vec<String> = candidates.iter().map(|entry| entry.id.clone()).collect();
    let candidate_id_lookup: HashMap<&str, ()> =
        candidate_ids.iter().map(|id| (id.as_str(), ())).collect();
    let mut protected_ids = Vec::new();

    for entry in candidates {
        let has_unpaired_tool_call = entry.tool_call_ids.iter().any(|tool_call_id| {
            tool_result_entry_ids
                .get(tool_call_id)
                .is_none_or(|entry_id| !candidate_id_lookup.contains_key(entry_id.as_str()))
        });
        let has_unpaired_tool_result =
            entry
                .tool_result_call_id
                .as_ref()
                .is_some_and(|tool_result_call_id| {
                    tool_call_entry_ids
                        .get(tool_result_call_id)
                        .is_none_or(|entry_id| !candidate_id_lookup.contains_key(entry_id.as_str()))
                });
        if has_unpaired_tool_call || has_unpaired_tool_result {
            protected_ids.push(entry.id.clone());
        }
    }

    let protected_id_lookup: HashMap<&str, ()> =
        protected_ids.iter().map(|id| (id.as_str(), ())).collect();
    let stub_metadata = candidates
        .iter()
        .filter(|entry| {
            !protected_id_lookup.contains_key(entry.id.as_str()) && can_stub(entry, options)
        })
        .map(StubMetadata::from)
        .collect();

    Ok(Some(PlanOutput {
        file_fingerprint: fingerprint(path)?,
        candidate_ids,
        protected_ids,
        stub_metadata,
    }))
}

pub fn scan_plan_json(path: &Path) -> io::Result<String> {
    let options = PlanOptions {
        stub_summarized_entries: true,
        stub_tool_results: true,
    };
    let plan = build_plan(path, options)?;
    Ok(serde_json::to_string(&plan).expect("plan serializes"))
}

fn scan_stats(path: &Path) -> io::Result<TranscriptStats> {
    let file = File::open(path)?;
    let reader = BufReader::with_capacity(1024 * 1024, file);
    let mut stats = TranscriptStats {
        bytes: metadata(path)?.len(),
        ..TranscriptStats::default()
    };

    for line in reader.lines() {
        let line = line?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match string_field(&value, "type").as_deref() {
            Some("message") => {
                stats.entries += 1;
                stats.messages += 1;
                if value
                    .get("message")
                    .and_then(|message| string_field(message, "role"))
                    .as_deref()
                    == Some("toolResult")
                {
                    stats.tool_results += 1;
                }
            }
            Some("compaction") => {
                stats.entries += 1;
                stats.compactions += 1;
            }
            _ => {}
        }
    }

    Ok(stats)
}

fn main() -> io::Result<()> {
    let mut args = env::args().skip(1);
    let first_argument = args.next().unwrap_or_else(|| {
        eprintln!("usage: rusty-core-recast [--stats] <session.jsonl> [--no-stub-summarized-entries] [--no-stub-tool-results]");
        std::process::exit(2);
    });
    if first_argument == "--stats" {
        let path = args.next().unwrap_or_else(|| {
            eprintln!("usage: rusty-core-recast --stats <session.jsonl>");
            std::process::exit(2);
        });
        if args.next().is_some() {
            eprintln!("--stats accepts exactly one session file");
            std::process::exit(2);
        }
        let stats = scan_stats(Path::new(&path))?;
        println!(
            "{}",
            serde_json::to_string(&stats).expect("stats serialize")
        );
        return Ok(());
    }

    let mut options = PlanOptions {
        stub_summarized_entries: true,
        stub_tool_results: true,
    };
    for argument in args {
        match argument.as_str() {
            "--no-stub-summarized-entries" => options.stub_summarized_entries = false,
            "--no-stub-tool-results" => options.stub_tool_results = false,
            _ => {
                eprintln!("unknown argument: {argument}");
                std::process::exit(2);
            }
        }
    }

    let plan = build_plan(Path::new(&first_argument), options)?;
    println!("{}", serde_json::to_string(&plan).expect("plan serializes"));
    Ok(())
}
