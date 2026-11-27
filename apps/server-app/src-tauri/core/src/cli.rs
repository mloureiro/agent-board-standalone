use std::ffi::OsString;

pub const USAGE: &str = "usage: rumo-server [--headless | --uninstall [--delete-data] | setup status | setup remote (--public-url https://<host> | --off) | setup first-passkey [--done]]";
pub const USAGE_EXIT_CODE: i32 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupCommand {
    Status,
    RemoteOn { public_url: String },
    RemoteOff,
    FirstPasskeyOpen,
    FirstPasskeyDone,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    Tray,
    Headless,
    Uninstall { delete_data: bool },
    WorkerCredentials { pending: bool },
    Setup(SetupCommand),
    Usage,
}

pub fn parse<I: IntoIterator<Item = OsString>>(args: I) -> Invocation {
    let args: Vec<String> = match args.into_iter().map(OsString::into_string).collect() {
        Ok(args) => args,
        Err(_) => return Invocation::Usage,
    };
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] => Invocation::Tray,
        ["--headless"] => Invocation::Headless,
        ["--uninstall"] => Invocation::Uninstall { delete_data: false },
        ["--uninstall", "--delete-data"] => Invocation::Uninstall { delete_data: true },
        ["--worker-credentials"] => Invocation::WorkerCredentials { pending: false },
        ["--worker-credentials", "--pending"] => Invocation::WorkerCredentials { pending: true },
        ["setup", "status"] => Invocation::Setup(SetupCommand::Status),
        ["setup", "remote", "--public-url", public_url] => {
            Invocation::Setup(SetupCommand::RemoteOn {
                public_url: (*public_url).to_string(),
            })
        }
        ["setup", "remote", "--off"] => Invocation::Setup(SetupCommand::RemoteOff),
        ["setup", "first-passkey"] => Invocation::Setup(SetupCommand::FirstPasskeyOpen),
        ["setup", "first-passkey", "--done"] => Invocation::Setup(SetupCommand::FirstPasskeyDone),
        _ => Invocation::Usage,
    }
}
