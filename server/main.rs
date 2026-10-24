//! Murmur server: the built app (dist/), feeds, pictures and the oRPC API.
//!
//! `murmur`                       serve on $PORT (default 8080)
//! `murmur health`                probe http://127.0.0.1:$PORT/api/health, exit 0 when it answers 200
//! `murmur export-types <path>`   write the TypeScript client types (src/bindings.ts)

mod app;
mod auth;
mod db;
mod http;
mod links;
mod preview;
mod r2;
mod router;
mod slack;
mod webauthn;

use std::sync::Arc;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("export-types") => {
            let path = args
                .get(2)
                .cloned()
                .unwrap_or_else(|| "src/bindings.ts".into());
            match router::bindings_ts().and_then(|ts| std::fs::write(&path, ts).map_err(Into::into))
            {
                Ok(()) => println!("wrote {path}"),
                Err(e) => {
                    eprintln!("export failed: {e:#}");
                    std::process::exit(1);
                }
            }
        }
        Some("health") => {
            let port = std::env::var("PORT")
                .ok()
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(8080);
            let ok = reqwest::Client::new()
                .get(format!("http://127.0.0.1:{port}/api/health"))
                .timeout(std::time::Duration::from_secs(5))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            std::process::exit(if ok { 0 } else { 1 });
        }
        Some(other) => {
            eprintln!(
                "unknown command {other}; try: murmur | murmur health | murmur export-types <path>"
            );
            std::process::exit(2);
        }
        None => serve().await,
    }
}

async fn serve() {
    let app = match app::App::from_env().await {
        Ok(a) => Arc::new(a),
        Err(e) => {
            eprintln!("cannot start: {e:#}");
            std::process::exit(1);
        }
    };
    if let Err(e) = app.db.migrate().await {
        eprintln!("migrate failed: {e:#}");
        std::process::exit(1);
    }
    // housekeeping that requests don't wait for: expiry is checked on read anyway
    let bg = app.clone();
    tokio::spawn(async move {
        for (what, res) in [
            ("prune", auth::prune_auth(&bg.db).await),
            (
                "adopt legacy posts",
                auth::adopt_legacy_posts(&bg.db, &bg.site).await,
            ),
        ] {
            if let Err(e) = res {
                eprintln!("{what} failed: {e:#}");
            }
        }
    });
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(8080);
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot listen on {port}: {e}");
            std::process::exit(1);
        }
    };
    println!(
        "{} listening on http://localhost:{port} (db: {}, origin: {})",
        links::APP_NAME,
        if app.db.remote { "turso" } else { "local file" },
        app.site_url
    );
    let router = http::app_router(app);
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server");
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    ctrl_c.await.ok();
}
