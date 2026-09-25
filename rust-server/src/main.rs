mod api;
mod combat_forms;
mod connectome;
mod local;
mod ranked;
mod realtime;
mod save_validation;
mod trades;

use anyhow::Context;
use sqlx::postgres::PgPoolOptions;
use std::{env, path::Path, sync::Arc};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let realtime_only = env::var("REALTIME_ONLY")
        .is_ok_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"));
    let app = if realtime_only {
        tracing::info!("REALTIME_ONLY enabled: database and connectome are disabled");
        realtime::router()
    } else {
        let database_url = env::var("DATABASE_URL").context("DATABASE_URL is required")?;
        let db = PgPoolOptions::new()
            .max_connections(12)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect(&database_url)
            .await?;
        let mut migrator = sqlx::migrate!("./migrations");
        // A rollback restores the previous binary but not the schema, so an older release must
        // start on a database that a newer release already migrated. Migrations stay additive.
        migrator.set_ignore_missing(true);
        migrator.run(&db).await?;
        let graph = if let Ok(dir) = env::var("CONNECTOME_DIR") {
            let graph = connectome::Connectome::load(Path::new(&dir))
                .context("Cannot load the configured full connectome; refusing silent fallback")?;
            tracing::info!(graph = %graph.info(), "Connectome loaded");
            Some(Arc::new(graph))
        } else {
            tracing::warn!("CONNECTOME_DIR unset: neural API disabled");
            None
        };
        let state = api::AppState::new(db, graph);
        api::router(state)
    };
    let address = env::var("LISTEN_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!(%address, "Rust API ready");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// systemd stops the service with SIGTERM; Ctrl+C covers local runs. Either one lets in-flight
/// requests finish before the process exits.
async fn shutdown_signal() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = interrupt => {}
        _ = terminate => {}
    }
    tracing::info!("Shutdown signal received");
}
