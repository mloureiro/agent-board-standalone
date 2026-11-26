use std::ffi::OsString;

pub const USAGE: &str = "usage: agent-board-server [--headless | --uninstall [--delete-data]]";
pub const USAGE_EXIT_CODE: i32 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    Tray,
    Headless,
    Uninstall { delete_data: bool },
    WorkerCredentials { pending: bool },
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
        _ => Invocation::Usage,
    }
}
