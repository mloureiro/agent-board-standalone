mod tray;

use std::io::{self, Write};
use std::process::ExitCode;

use agent_board_server_core::app::{self, Host, Start};
use agent_board_server_core::cli::{self, Invocation, USAGE, USAGE_EXIT_CODE};

fn exit(code: i32) -> ExitCode {
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

fn main() -> ExitCode {
    let invocation = cli::parse(std::env::args_os().skip(1));
    if invocation == Invocation::Usage {
        eprintln!("{USAGE}");
        return exit(USAGE_EXIT_CODE);
    }
    let host = match Host::from_process() {
        Ok(host) => host,
        Err(message) => {
            eprintln!("{message}");
            return exit(1);
        }
    };
    match invocation {
        Invocation::Uninstall { delete_data } => {
            exit(app::run_uninstall(&host, delete_data, &mut io::stdout()))
        }
        Invocation::Headless => {
            let stdin = io::BufReader::new(io::stdin());
            exit(app::run_headless(&host, stdin, &mut io::stdout()))
        }
        Invocation::Tray => match app::start(&host) {
            Ok(Start::Running(running)) => {
                tray::run(*running);
                ExitCode::SUCCESS
            }
            Ok(Start::AlreadyRunning) => ExitCode::SUCCESS,
            Err(error) => {
                let _ = writeln!(io::stderr(), "{error}");
                exit(1)
            }
        },
        Invocation::Usage => exit(USAGE_EXIT_CODE),
    }
}
