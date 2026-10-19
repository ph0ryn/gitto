use clap::Parser;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(version, about = "Browse a local Git repository in your browser")]
pub struct Cli {
    /// Repository path (subdirectories are also accepted)
    #[arg(default_value = ".")]
    pub path: PathBuf,
    /// Use this fixed loopback port for the shared server
    #[arg(long, default_value_t = 47319, value_parser = clap::value_parser!(u16).range(1..))]
    pub port: u16,
    /// Print the URL without opening a browser
    #[arg(long)]
    pub no_open: bool,
    /// List registered repositories without starting the server
    #[arg(long, visible_alias = "ls", conflicts_with_all = ["path", "no_open", "server"])]
    pub list: bool,
    /// Run the internal shared server in the foreground
    #[arg(long, hide = true, conflicts_with_all = ["path", "no_open"])]
    pub server: bool,
    /// Print gitto's license and third-party notices
    #[arg(long, exclusive = true)]
    pub licenses: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_command_uses_repository_path_and_fixed_port() {
        let cli = Cli::try_parse_from(["gitto", "."]).unwrap();
        assert_eq!(cli.path, PathBuf::from("."));
        assert_eq!(cli.port, 47319);
        assert!(!cli.no_open);
        assert!(!cli.list);
        assert!(!cli.server);
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
    fn zero_port_is_rejected() {
        assert!(Cli::try_parse_from(["gitto", "--port", "0"]).is_err());
    }

    #[test]
    fn list_aliases_are_flags_but_ls_remains_a_path() {
        for flag in ["--list", "--ls"] {
            let cli = Cli::try_parse_from(["gitto", flag, "--port", "5000"]).unwrap();
            assert!(cli.list);
            assert_eq!(cli.port, 5000);
        }
        let cli = Cli::try_parse_from(["gitto", "ls"]).unwrap();
        assert_eq!(cli.path, PathBuf::from("ls"));
        assert!(!cli.list);
    }

    #[test]
    fn server_mode_is_internal_and_hidden_from_help() {
        assert!(Cli::try_parse_from(["gitto", "--server"]).unwrap().server);
        let help = Cli::try_parse_from(["gitto", "--help"]).unwrap_err();
        assert!(!help.to_string().contains("--server"));
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
