mod api;
mod assets;
mod cli;
mod git;
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
    if let Err(error) = server::run(cli).await {
        eprintln!("gitto: {error}");
        std::process::exit(1);
    }
}
