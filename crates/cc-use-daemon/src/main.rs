mod launchd;
mod management;
mod runtime;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{}", error);
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let command = args.next();
    let option = args.next();

    match (command.as_deref(), option.as_deref()) {
        (Some("start"), Some("--foreground")) => runtime::run_foreground().await,
        (Some("start"), None) => launchd::start(),
        (Some("stop"), None) => launchd::stop(),
        (Some("restart"), None) => launchd::restart(),
        (Some("status"), None) => {
            let token_exists = management::read_existing_management_token()?.is_some();
            let launchd_status = launchd::status()?;
            println!(
                "cc-use-daemon status; management_token_present={}; launch_agent={}",
                token_exists, launchd_status
            );
            Ok(())
        }
        (Some("install"), None) => launchd::install(),
        (Some("uninstall"), None) => launchd::uninstall(),
        _ => Err(
            "Usage: cc-use-daemon start [--foreground] | stop | restart | status | install | uninstall"
                .to_string(),
        ),
    }
}
