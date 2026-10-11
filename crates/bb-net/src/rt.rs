//! The tiny runtime surface bb-net needs, per platform. Native sessions pump
//! on their own thread (the partii engine owns its runtime); the web build
//! pumps on the browser event loop via `spawn_local`.

#[cfg(target_arch = "wasm32")]
use std::future::Future;

/// `Send` on native (session pumps run on their own thread); nothing on wasm,
/// where browser handles are `!Send` and everything is single-threaded.
#[cfg(not(target_arch = "wasm32"))]
pub trait MaybeSend: Send {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: Send> MaybeSend for T {}
#[cfg(target_arch = "wasm32")]
pub trait MaybeSend {}
#[cfg(target_arch = "wasm32")]
impl<T> MaybeSend for T {}

#[cfg(target_arch = "wasm32")]
pub fn spawn(f: impl Future<Output = ()> + 'static) {
    wasm_bindgen_futures::spawn_local(f);
}

#[cfg(target_arch = "wasm32")]
pub async fn sleep_ms(ms: u32) {
    let p = js_sys::Promise::new(&mut |resolve, _| {
        if let Some(w) = web_sys::window() {
            let _ = w.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms as i32);
        }
    });
    let _ = wasm_bindgen_futures::JsFuture::from(p).await;
}

/// Wall-clock milliseconds since the Unix epoch (for the phone dedupe and
/// token expiry; never used for simulation).
pub fn now_ms() -> f64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    }
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now()
    }
}
