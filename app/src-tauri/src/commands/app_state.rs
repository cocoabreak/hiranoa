use serde_json::{Map, Value};
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

fn file_for_kind(kind: &str) -> Result<&'static str, String> {
    match kind {
        "settings" => Ok("settings.json"),
        "tabs" => Ok("tabs.json"),
        "recent" => Ok("recent.json"),
        _ => Err("未対応の状態ストアです".to_string()),
    }
}

fn store_path_for_kind(kind: &str) -> Result<PathBuf, String> {
    let file = file_for_kind(kind)?;
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("HIRANOA_E2E_STATE_DIR") {
        let dir = PathBuf::from(dir);
        if dir.is_absolute() {
            return Ok(dir.join(file));
        }
    }
    Ok(PathBuf::from(file))
}

fn validate_state(kind: &str, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("状態データが大きすぎます".to_string());
    }
    let object = value
        .as_object()
        .ok_or_else(|| "状態データはオブジェクトである必要があります".to_string())?;
    let allowed: &[&str] = match kind {
        "settings" => &["settings"],
        "tabs" => &[
            "schemaVersion",
            "workspace",
            "tabs",
            "activeIndex",
            "explorer",
            "expandedDirs",
            "search",
        ],
        "recent" => &["files", "folders", "archives"],
        _ => return Err("未対応の状態ストアです".to_string()),
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("状態データに未対応のキーがあります".to_string());
    }
    let max_entries = if kind == "recent" { 10 } else { 100 };
    for key in ["tabs", "files", "folders", "archives"] {
        if object
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(|items| items.len() > max_entries)
        {
            return Err("状態データの項目数が上限を超えています".to_string());
        }
    }
    if kind == "tabs" {
        if object.contains_key("schemaVersion") || object.contains_key("workspace") {
            validate_workspace(object)?;
        }
        if let Some(expanded_dirs) = object.get("expandedDirs") {
            let paths = expanded_dirs
                .as_array()
                .ok_or_else(|| "Explorer展開状態は配列である必要があります".to_string())?;
            if paths.len() > 64 || paths.iter().any(|path| !path.is_string()) {
                return Err("Explorer展開状態が不正です".to_string());
            }
        }
        if let Some(search) = object.get("search") {
            let search = search
                .as_object()
                .ok_or_else(|| "検索状態はオブジェクトである必要があります".to_string())?;
            let valid_keys = ["open", "query", "useRegex"];
            if search.keys().any(|key| !valid_keys.contains(&key.as_str()))
                || search.get("open").is_some_and(|value| !value.is_boolean())
                || search
                    .get("useRegex")
                    .is_some_and(|value| !value.is_boolean())
                || search.get("query").is_some_and(|value| {
                    value
                        .as_str()
                        .is_none_or(|query| query.encode_utf16().count() > 10_000)
                })
            {
                return Err("検索状態が不正です".to_string());
            }
        }
    }
    Ok(())
}

fn validate_workspace(object: &Map<String, Value>) -> Result<(), String> {
    let invalid = || "Workspace状態が不正です".to_string();
    if object.get("schemaVersion").and_then(Value::as_u64) != Some(2)
        || ["tabs", "activeIndex", "search"]
            .iter()
            .any(|key| object.contains_key(*key))
    {
        return Err(invalid());
    }
    let workspace = object
        .get("workspace")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    if workspace
        .keys()
        .any(|key| !["panes", "activePaneIndex", "splitRatio"].contains(&key.as_str()))
    {
        return Err(invalid());
    }
    let panes = workspace
        .get("panes")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if panes.is_empty() || panes.len() > 2 {
        return Err(invalid());
    }
    let active = workspace
        .get("activePaneIndex")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    let ratio = workspace
        .get("splitRatio")
        .and_then(Value::as_f64)
        .ok_or_else(invalid)?;
    if active >= panes.len() as u64 || !(0.2..=0.8).contains(&ratio) {
        return Err(invalid());
    }
    let mut count = 0;
    for pane in panes {
        let pane_object = pane.as_object().ok_or_else(invalid)?;
        if pane_object
            .keys()
            .any(|key| !["tabs", "activeIndex", "search"].contains(&key.as_str()))
        {
            return Err(invalid());
        }
        let tabs = pane_object
            .get("tabs")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?;
        if pane_object.get("activeIndex").is_some_and(|value| {
            !value.is_null()
                && value.as_i64().is_none_or(|index| {
                    if tabs.is_empty() {
                        index != -1
                    } else {
                        index < 0 || index as usize >= tabs.len()
                    }
                })
        }) {
            return Err(invalid());
        }
        for tab in tabs {
            validate_workspace_tab(tab)?;
        }
        count += tabs.len();
        if count > 100 {
            return Err(invalid());
        }
        validate_state("tabs", pane)?;
    }
    Ok(())
}

fn validate_workspace_tab(tab: &Value) -> Result<(), String> {
    let invalid = || "タブ状態が不正です".to_string();
    let tab = tab.as_object().ok_or_else(invalid)?;
    if tab.keys().any(|key| {
        ![
            "path",
            "pinned",
            "source",
            "documentPath",
            "scrollPositions",
            "viewMode",
        ]
        .contains(&key.as_str())
    }) || tab
        .get("path")
        .and_then(Value::as_str)
        .is_none_or(|path| path.is_empty() || path.len() > 131_072)
        || tab.get("pinned").is_some_and(|value| !value.is_boolean())
        || tab
            .get("documentPath")
            .is_some_and(|value| value.as_str().is_none_or(|path| path.len() > 131_072))
        || tab
            .get("viewMode")
            .is_some_and(|value| !matches!(value.as_str(), Some("rendered" | "source")))
    {
        return Err(invalid());
    }
    if let Some(source) = tab.get("source") {
        let source = source.as_object().ok_or_else(invalid)?;
        if source
            .keys()
            .any(|key| !["kind", "nativePath"].contains(&key.as_str()))
            || !matches!(
                source.get("kind").and_then(Value::as_str),
                Some("native" | "zip")
            )
            || source
                .get("nativePath")
                .and_then(Value::as_str)
                .is_none_or(|path| path.is_empty() || path.len() > 131_072)
        {
            return Err(invalid());
        }
    }
    if let Some(positions) = tab.get("scrollPositions") {
        let positions = positions.as_object().ok_or_else(invalid)?;
        if positions.iter().any(|(key, value)| {
            !["rendered", "source", "safe"].contains(&key.as_str())
                || value
                    .as_f64()
                    .is_none_or(|position| !position.is_finite() || position < 0.0)
        }) {
            return Err(invalid());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn load_app_state(app: AppHandle, kind: String) -> Result<Value, String> {
    let store = app
        .store(store_path_for_kind(&kind)?)
        .map_err(|e| e.to_string())?;
    Ok(Value::Object(
        store.entries().into_iter().collect::<Map<_, _>>(),
    ))
}

#[tauri::command]
pub fn save_app_state(app: AppHandle, kind: String, value: Value) -> Result<(), String> {
    validate_state(&kind, &value)?;
    let Value::Object(values) = value else {
        return Err("状態データはオブジェクトである必要があります".to_string());
    };
    let store = app
        .store(store_path_for_kind(&kind)?)
        .map_err(|e| e.to_string())?;
    store.clear();
    for (key, value) in values {
        store.set(key, value);
    }
    store.save().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{file_for_kind, validate_state};
    use serde_json::{json, Value};

    #[test]
    fn only_known_state_stores_are_exposed() {
        assert_eq!(file_for_kind("settings"), Ok("settings.json"));
        assert_eq!(file_for_kind("tabs"), Ok("tabs.json"));
        assert_eq!(file_for_kind("recent"), Ok("recent.json"));
        assert!(file_for_kind("trusted-root").is_err());
        assert!(file_for_kind("../trusted-root.json").is_err());
    }

    #[test]
    fn state_schema_rejects_unknown_keys_and_excess_entries() {
        assert!(validate_state("tabs", &json!({ "unknown": true })).is_err());
        assert!(validate_state("tabs", &json!({ "activePath": null })).is_err());
        assert!(validate_state("tabs", &json!({ "rootPath": null })).is_err());
        assert!(validate_state("recent", &json!({ "files": vec![json!({}); 11] })).is_err());
        assert!(validate_state("tabs", &json!({ "tabs": [] })).is_ok());
        assert!(validate_state(
            "tabs",
            &json!({
                "tabs": [],
                "activeIndex": null,
                "explorer": { "kind": "zip", "nativePath": "C:/notes.zip" },
                "expandedDirs": ["docs", "docs/guides"],
                "search": { "open": true, "query": "setup", "useRegex": false }
            })
        )
        .is_ok());
        assert!(validate_state("recent", &json!({ "archives": [] })).is_ok());
        assert!(validate_state("tabs", &json!({ "expandedDirs": vec!["docs"; 65] })).is_err());
        assert!(validate_state("tabs", &json!({ "expandedDirs": [1] })).is_err());
        assert!(validate_state(
            "tabs",
            &json!({ "search": { "open": "yes", "query": "x", "useRegex": false } })
        )
        .is_err());
    }

    #[test]
    fn workspace_schema_bounds_panes_and_total_tabs() {
        let state = |panes: Value| {
            json!({
                "schemaVersion": 2,
                "workspace": { "panes": panes, "activePaneIndex": 0, "splitRatio": 0.5 },
                "explorer": null, "expandedDirs": []
            })
        };
        let pane = json!({ "tabs": [], "activeIndex": null, "search": {"open": false,"query":"","useRegex":false} });
        assert!(validate_state("tabs", &state(json!([pane.clone(), pane.clone()]))).is_ok());
        assert!(validate_state("tabs", &state(json!([]))).is_err());
        assert!(validate_state(
            "tabs",
            &state(json!([pane.clone(), pane.clone(), pane.clone()]))
        )
        .is_err());
        let oversized = json!({"tabs":vec![json!({"path":"D:/notes/a.md"});51]});
        assert!(validate_state("tabs", &state(json!([oversized.clone(), oversized]))).is_err());
        let mut invalid = state(json!([pane]));
        invalid["workspace"]["splitRatio"] = json!(1);
        assert!(validate_state("tabs", &invalid).is_err());
        invalid["schemaVersion"] = json!(3);
        assert!(validate_state("tabs", &invalid).is_err());
    }
}
