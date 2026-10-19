mod api;
mod assets;
mod cli;
mod daemon;
mod git;
mod registry;
mod server;

use clap::Parser;
use std::io::{ErrorKind, Write};

#[tokio::main]
async fn main() {
    let cli = cli::Cli::parse();
    if cli.licenses {
        if let Err(error) = write!(
            std::io::stdout(),
            "gitto\n\n{}\n{}",
            include_str!("../LICENSE"),
            include_str!("../THIRD_PARTY_NOTICES.txt")
        ) && error.kind() != ErrorKind::BrokenPipe
        {
            eprintln!("gitto: {error}");
            std::process::exit(1);
        }
        return;
    }
    let result = if cli.server {
        server::run(cli).await
    } else {
        daemon::run(cli).await
    };
    if let Err(error) = result {
        eprintln!("gitto: {error}");
        std::process::exit(1);
    }
}
