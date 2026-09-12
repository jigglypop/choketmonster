mod api;
mod connectome;
mod local;
mod save_validation;

use anyhow::Context;
use sqlx::postgres::PgPoolOptions;
use std::{env, path::Path, sync::Arc};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let database_url = env::var("DATABASE_URL").context("DATABASE_URL is required")?;
    let db = PgPoolOptions::new()
        .max_connections(6)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&database_url)
        .await?;
    sqlx::migrate!("./migrations").run(&db).await?;
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
    let app = api::router(state);
    let address = env::var("LISTEN_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!(%address, "Rust API ready");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
