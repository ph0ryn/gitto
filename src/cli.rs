use clap::Parser;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(version, about = "Browse a local Git repository in your browser")]
pub struct Cli {
    /// Repository path (subdirectories are also accepted)
    #[arg(default_value = ".")]
    pub path: PathBuf,
    /// Listen on this port instead of an automatically allocated port
    #[arg(long, default_value_t = 0)]
    pub port: u16,
    /// Print the URL without opening a browser
    #[arg(long)]
    pub no_open: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_command_uses_repository_path_and_automatic_port() {
        let cli = Cli::try_parse_from(["gitto", "."]).unwrap();
        assert_eq!(cli.path, PathBuf::from("."));
        assert_eq!(cli.port, 0);
        assert!(!cli.no_open);
    }

    #[test]
    fn development_options_and_invalid_ports() {
        let cli = Cli::try_parse_from(["gitto", "src", "--port", "3000", "--no-open"]).unwrap();
        assert_eq!(cli.port, 3000);
        assert!(cli.no_open);
        assert!(Cli::try_parse_from(["gitto", "--port", "65536"]).is_err());
    }
}
