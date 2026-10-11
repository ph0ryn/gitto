mod api;
mod assets;
mod cli;
mod git;
mod server;

use clap::Parser;

#[tokio::main]
async fn main() {
    if let Err(error) = server::run(cli::Cli::parse()).await {
        eprintln!("gitto: {error}");
        std::process::exit(1);
    }
}
