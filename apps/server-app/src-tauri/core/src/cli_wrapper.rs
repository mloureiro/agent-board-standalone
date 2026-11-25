use std::fs;
use std::io;
use std::os::unix::fs::{OpenOptionsExt, symlink};
use std::path::Path;

use crate::overrides::{CREDENTIAL_STORE_ENV, E2E_ENV};
use crate::paths::ROOT_ENV;
use crate::worker_setup::WorkerSetup;

pub const REFUSED_COMMANDS: [&str; 4] = ["setup", "self-update", "restart", "init"];
pub const REFUSED_EXIT_CODE: i32 = 2;

pub fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn write_script(path: &Path, body: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let partial = path.with_extension("partial");
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o755)
            .open(&partial)?;
        file.write_all(body.as_bytes())?;
    }
    fs::rename(partial, path)
}

fn credentials_script(setup: &WorkerSetup, pending: bool) -> String {
    let mut assignments = vec![format!(
        "{ROOT_ENV}={}",
        sh_quote(&setup.root.display().to_string())
    )];
    if let Some(file) = &setup.store_file {
        assignments.push(format!(
            "{CREDENTIAL_STORE_ENV}={}",
            sh_quote(&format!("file:{}", file.display()))
        ));
        assignments.push(format!("{E2E_ENV}=1"));
    }
    let flag = if pending { " --pending" } else { "" };
    format!(
        "#!/bin/sh\nexec env {} {} --worker-credentials{flag}\n",
        assignments.join(" "),
        sh_quote(&setup.executable.display().to_string()),
    )
}

pub fn wrapper_script(setup: &WorkerSetup, env: &[(String, String)]) -> String {
    let exports: String = env
        .iter()
        .filter(|(name, _)| name == "PATH" || name.starts_with("AGENT_BOARD_"))
        .map(|(name, value)| format!("{name}={}\nexport {name}\n", sh_quote(value)))
        .collect();
    format!(
        "#!/bin/sh\n\
         skip=0\n\
         for arg in \"$@\"; do\n\
         \x20 if [ \"$skip\" = 1 ]; then skip=0; continue; fi\n\
         \x20 case \"$arg\" in\n\
         \x20   --profile) skip=1 ;;\n\
         \x20   -*) ;;\n\
         \x20   setup|self-update|restart|init)\n\
         \x20     echo \"board $arg is managed by Agent Board Server and is not available here\" >&2\n\
         \x20     exit {REFUSED_EXIT_CODE} ;;\n\
         \x20   *) break ;;\n\
         \x20 esac\n\
         done\n\
         {exports}exec {} \"$@\"\n",
        sh_quote(&setup.paths.cli_link().display().to_string()),
    )
}

fn link_cli(setup: &WorkerSetup) -> Result<(), String> {
    if !setup.cli_source.is_file() {
        return Err(format!(
            "CLI executable missing: {}",
            setup.cli_source.display()
        ));
    }
    let link = setup.paths.cli_link();
    if fs::read_link(&link).is_ok_and(|target| target == setup.cli_source) {
        return Ok(());
    }
    let _ = fs::remove_file(&link);
    symlink(&setup.cli_source, &link).map_err(|error| format!("CLI link failed: {error}"))
}

pub fn prepare_base(setup: &WorkerSetup) -> Result<(), String> {
    let failed = |error: io::Error| format!("worker folders failed: {error}");
    for dir in [
        setup.paths.config(),
        setup.paths.state(),
        setup.paths.run(),
        setup.paths.bin(),
        setup.paths.libexec(),
    ] {
        fs::create_dir_all(dir).map_err(failed)?;
    }
    link_cli(setup)?;
    for pending in [false, true] {
        write_script(
            &setup.paths.credentials_script(pending),
            &credentials_script(setup, pending),
        )
        .map_err(failed)?;
    }
    Ok(())
}

pub fn install_wrapper(setup: &WorkerSetup, env: &[(String, String)]) -> Result<(), String> {
    write_script(&setup.paths.wrapper(), &wrapper_script(setup, env))
        .map_err(|error| format!("CLI wrapper failed: {error}"))
}
