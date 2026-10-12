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
    /// Print gitto's license and third-party notices
    #[arg(long, exclusive = true)]
    pub licenses: bool,
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
        assert!(!cli.licenses);
    }

    #[test]
    fn development_options_and_invalid_ports() {
        let cli = Cli::try_parse_from(["gitto", "src", "--port", "3000", "--no-open"]).unwrap();
        assert_eq!(cli.port, 3000);
        assert!(cli.no_open);
        assert!(Cli::try_parse_from(["gitto", "--port", "65536"]).is_err());
    }

    #[test]
    fn help_lists_the_licenses_option() {
        let help = Cli::try_parse_from(["gitto", "--help"]).unwrap_err();
        assert!(help.to_string().contains("--licenses"));
    }

    #[test]
    fn licenses_option_preserves_repository_paths_and_rejects_other_arguments() {
        let cli = Cli::try_parse_from(["gitto", "--licenses"]).unwrap();
        assert!(cli.licenses);

        for path in ["licenses", "./licenses"] {
            let cli = Cli::try_parse_from(["gitto", path]).unwrap();
            assert_eq!(cli.path, PathBuf::from(path));
            assert!(!cli.licenses);
        }

        assert!(Cli::try_parse_from(["gitto", ".", "--licenses"]).is_err());
        assert!(Cli::try_parse_from(["gitto", "--no-open", "--licenses"]).is_err());
    }
}
