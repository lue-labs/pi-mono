#[allow(dead_code)]
#[path = "main.rs"]
mod planner;

use std::ffi::{CStr, CString, c_void};
use std::os::raw::c_char;

unsafe extern "C" {
    fn rusty_core_recast_napi_register_module() -> *mut c_void;
}

#[used]
static NAPI_MODULE_REGISTRAR: unsafe extern "C" fn() -> *mut c_void =
    rusty_core_recast_napi_register_module;
use std::path::Path;

pub fn scan_plan_json(path: &Path) -> std::io::Result<String> {
    planner::scan_plan_json(path)
}

fn error_json(message: impl std::fmt::Display) -> CString {
    let escaped = serde_json::to_string(&message.to_string()).expect("error message serializes");
    CString::new(format!("{{\"error\":{escaped}}}")).expect("JSON contains no NUL")
}

#[unsafe(no_mangle)]
pub extern "C" fn rusty_core_recast_force_napi_link() -> *mut c_void {
    unsafe { rusty_core_recast_napi_register_module() }
}

/// # Safety
///
/// `path` must point to a valid, NUL-terminated UTF-8 string for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rusty_core_recast_scan_plan_json(path: *const c_char) -> *mut c_char {
    if path.is_null() {
        return error_json("missing transcript path").into_raw();
    }

    // The C N-API shim passes a NUL-terminated string allocated from JavaScript input.
    let path = unsafe { CStr::from_ptr(path) };
    let path = match path.to_str() {
        Ok(path) => path,
        Err(_) => return error_json("transcript path is not UTF-8").into_raw(),
    };

    match scan_plan_json(Path::new(path)) {
        Ok(plan) => CString::new(plan)
            .expect("serialized JSON contains no NUL")
            .into_raw(),
        Err(error) => error_json(error).into_raw(),
    }
}

/// # Safety
///
/// `value` must be a non-null pointer returned by `rusty_core_recast_scan_plan_json`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rusty_core_recast_free_string(value: *mut c_char) {
    if !value.is_null() {
        // `value` is only accepted when allocated by `CString::into_raw` above.
        unsafe {
            drop(CString::from_raw(value));
        }
    }
}
