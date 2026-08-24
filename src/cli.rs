use std::env;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener as StdTcpListener};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant as StdInstant;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command as TokioCommand};
use tokio::signal;
use tokio::time::{Instant, sleep, timeout};

use crate::NcxResult;
use crate::dataset::Dataset;
use crate::server::{self, Limits};

const USAGE: &str = "\
ncx — a thin, remote-first NetCDF viewer

Usage:
  ncx open [OPTIONS] FILE
  ncx open [OPTIONS] SSH_DESTINATION:/absolute/path.nc
  ncx serve [OPTIONS] FILE
  ncx serve [OPTIONS] --dataset ID=FILE [--dataset ID=FILE ...]

Options:
  --port PORT                 Loopback port for `serve` (default: 0)
  --max-response-bytes BYTES  Maximum binary response (default: 1073741824)
  --ugrid-warn-faces FACES    UGRID confirmation threshold (default: 2000000)
  --dataset ID=FILE           Add one named read-only dataset to `serve`
  --exit-on-stdin-eof         Stop `serve` when its owner pipe closes
  -h, --help                  Show this help
";

enum ParsedCommand {
    Help,
    Open {
        target: String,
        limits: Limits,
    },
    Serve {
        sources: Vec<ServeSource>,
        port: u16,
        limits: Limits,
        exit_on_stdin_eof: bool,
    },
}

struct ServeSource {
    id: String,
    path: PathBuf,
}

enum OpenTarget {
    Local(PathBuf),
    Remote { destination: String, path: String },
}

pub async fn run() -> NcxResult<()> {
    let arguments = env::args_os()
        .skip(1)
        .map(|argument| {
            argument
                .into_string()
                .map_err(|_| "command-line arguments must be valid UTF-8".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;

    match parse_arguments(arguments)? {
        ParsedCommand::Help => {
            print!("{USAGE}");
            Ok(())
        }
        ParsedCommand::Serve {
            sources,
            port,
            limits,
            exit_on_stdin_eof,
        } => serve_local(sources, port, limits, false, exit_on_stdin_eof).await,
        ParsedCommand::Open { target, limits } => match classify_target(&target)? {
            OpenTarget::Local(path) => {
                serve_local(single_source(path), 0, limits, true, false).await
            }
            OpenTarget::Remote { destination, path } => {
                open_remote(&destination, &path, limits).await
            }
        },
    }
}

fn parse_arguments(arguments: Vec<String>) -> NcxResult<ParsedCommand> {
    let Some(command) = arguments.first().map(String::as_str) else {
        return Ok(ParsedCommand::Help);
    };
    if matches!(command, "-h" | "--help") {
        return Ok(ParsedCommand::Help);
    }
    if command != "open" && command != "serve" {
        return Err(format!("unknown command {command:?}\n\n{USAGE}"));
    }

    let mut limits = Limits::default();
    let mut port = 0;
    let mut exit_on_stdin_eof = false;
    let mut sources = Vec::new();
    let mut target = None;
    let mut index = 1;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "-h" | "--help" => return Ok(ParsedCommand::Help),
            "--port" => {
                if command != "serve" {
                    return Err("--port is only valid with `ncx serve`".to_owned());
                }
                port = parse_value(&arguments, &mut index, "--port")?;
            }
            "--max-response-bytes" => {
                limits.max_response_bytes =
                    parse_positive(&arguments, &mut index, "--max-response-bytes")?;
            }
            "--ugrid-warn-faces" => {
                limits.ugrid_warn_faces =
                    parse_positive(&arguments, &mut index, "--ugrid-warn-faces")?;
            }
            "--exit-on-stdin-eof" => {
                if command != "serve" {
                    return Err("--exit-on-stdin-eof is only valid with `ncx serve`".to_owned());
                }
                exit_on_stdin_eof = true;
            }
            "--dataset" => {
                if command != "serve" {
                    return Err("--dataset is only valid with `ncx serve`".to_owned());
                }
                let value = parse_value(&arguments, &mut index, "--dataset")?;
                let source = parse_dataset(value)?;
                if sources
                    .iter()
                    .any(|current: &ServeSource| current.id == source.id)
                {
                    return Err(format!("duplicate dataset ID {:?}", source.id));
                }
                sources.push(source);
            }
            "--" => {
                index += 1;
                if index >= arguments.len() || target.is_some() || index + 1 != arguments.len() {
                    return Err("expected exactly one NetCDF file after `--`".to_owned());
                }
                target = Some(arguments[index].clone());
            }
            option if option.starts_with('-') => {
                return Err(format!("unknown option {option:?}"));
            }
            value => {
                if target.replace(value.to_owned()).is_some() {
                    return Err("expected exactly one NetCDF file".to_owned());
                }
            }
        }
        index += 1;
    }

    if command == "open" {
        if !sources.is_empty() {
            return Err("--dataset is only valid with `ncx serve`".to_owned());
        }
        let target = target.ok_or_else(|| "missing NetCDF file".to_owned())?;
        Ok(ParsedCommand::Open { target, limits })
    } else {
        if !sources.is_empty() && target.is_some() {
            return Err("use either FILE or --dataset, not both".to_owned());
        }
        if sources.is_empty() {
            sources = single_source(PathBuf::from(
                target.ok_or_else(|| "missing NetCDF file or --dataset".to_owned())?,
            ));
        }
        Ok(ParsedCommand::Serve {
            sources,
            port,
            limits,
            exit_on_stdin_eof,
        })
    }
}

fn single_source(path: PathBuf) -> Vec<ServeSource> {
    vec![ServeSource {
        id: "dataset".to_owned(),
        path,
    }]
}

fn parse_dataset(value: String) -> NcxResult<ServeSource> {
    let (id, path) = value
        .split_once('=')
        .ok_or_else(|| "--dataset must be ID=FILE".to_owned())?;
    let valid_id = (1..=64).contains(&id.len())
        && id.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        });
    if !valid_id {
        return Err(format!("invalid dataset ID {id:?}"));
    }
    if path.is_empty() {
        return Err("dataset file path is empty".to_owned());
    }
    Ok(ServeSource {
        id: id.to_owned(),
        path: PathBuf::from(path),
    })
}

fn parse_value<T>(arguments: &[String], index: &mut usize, option: &str) -> NcxResult<T>
where
    T: std::str::FromStr,
{
    *index += 1;
    let value = arguments
        .get(*index)
        .ok_or_else(|| format!("{option} requires a value"))?;
    value
        .parse()
        .map_err(|_| format!("invalid value {value:?} for {option}"))
}

fn parse_positive(arguments: &[String], index: &mut usize, option: &str) -> NcxResult<u64> {
    let value = parse_value(arguments, index, option)?;
    if value == 0 {
        return Err(format!("{option} must be greater than zero"));
    }
    Ok(value)
}

fn classify_target(target: &str) -> NcxResult<OpenTarget> {
    if Path::new(target).exists() {
        return Ok(OpenTarget::Local(PathBuf::from(target)));
    }
    if let Some(separator) = target.rfind(":/") {
        let destination = &target[..separator];
        let path = &target[separator + 1..];
        if destination.is_empty() {
            return Err("the SSH destination before `:/` is empty".to_owned());
        }
        return Ok(OpenTarget::Remote {
            destination: destination.to_owned(),
            path: path.to_owned(),
        });
    }
    if let Some(separator) = target.find(':')
        && !target[..separator].contains('/')
    {
        return Err("remote NetCDF paths must be absolute: use host:/path/file.nc".to_owned());
    }
    Ok(OpenTarget::Local(PathBuf::from(target)))
}

async fn serve_local(
    sources: Vec<ServeSource>,
    port: u16,
    limits: Limits,
    launch: bool,
    exit_on_stdin_eof: bool,
) -> NcxResult<()> {
    let started = StdInstant::now();
    let mut datasets = Vec::with_capacity(sources.len());
    let mut variable_count = 0;
    for source in sources {
        let dataset = Dataset::open(&source.path)?;
        variable_count += dataset.metadata().variables.len();
        datasets.push(server::ServedDataset {
            id: source.id.clone(),
            label: source.id,
            dataset,
        });
    }
    eprintln!(
        "ncx: opened {} dataset(s), {} variables in {} ms",
        datasets.len(),
        variable_count,
        started.elapsed().as_millis()
    );
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|error| format!("cannot bind 127.0.0.1:{port}: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("cannot inspect the loopback listener: {error}"))?;
    let url = format!("http://127.0.0.1:{}/", address.port());

    println!("NCX_READY=127.0.0.1:{}", address.port());
    if !exit_on_stdin_eof {
        println!("{url}");
    }
    if launch && !launch_browser(&url) {
        eprintln!("ncx: could not open a browser; open {url} manually");
    }

    server::serve(listener, datasets, limits, shutdown(exit_on_stdin_eof)).await
}

async fn shutdown(exit_on_stdin_eof: bool) {
    if !exit_on_stdin_eof {
        let _ = signal::ctrl_c().await;
        return;
    }
    let mut input = tokio::io::stdin();
    let mut byte = [0_u8; 1];
    tokio::select! {
        _ = signal::ctrl_c() => {}
        _ = async {
            loop {
                match input.read(&mut byte).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        } => {}
    }
}

async fn open_remote(destination: &str, path: &str, limits: Limits) -> NcxResult<()> {
    let mut last_error = String::new();
    for attempt in 1..=3 {
        let port = unused_loopback_port()?;
        let remote_command = remote_serve_command(path, port, limits);
        let forward = format!("127.0.0.1:{port}:127.0.0.1:{port}");
        let mut child = TokioCommand::new("ssh")
            .arg("-o")
            .arg("ExitOnForwardFailure=yes")
            .arg("-L")
            .arg(forward)
            .arg(destination)
            .arg(remote_command)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("cannot start ssh: {error}"))?;

        match wait_until_ready(&mut child, port).await {
            Ok(()) => {
                let url = format!("http://127.0.0.1:{port}/");
                if !launch_browser(&url) {
                    eprintln!("ncx: could not open a browser; open {url} manually");
                }
                return own_ssh_session(child).await;
            }
            Err(error) => {
                last_error = error;
                stop_child(&mut child).await;
                if attempt < 3 {
                    eprintln!("ncx: remote startup failed; retrying with another port");
                }
            }
        }
    }
    Err(format!("remote ncx did not become ready: {last_error}"))
}

fn unused_loopback_port() -> NcxResult<u16> {
    let listener = StdTcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("cannot choose a loopback port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("cannot inspect a candidate loopback port: {error}"))
}

fn remote_serve_command(path: &str, port: u16, limits: Limits) -> String {
    [
        "ncx".to_owned(),
        "serve".to_owned(),
        "--port".to_owned(),
        port.to_string(),
        "--max-response-bytes".to_owned(),
        limits.max_response_bytes.to_string(),
        "--ugrid-warn-faces".to_owned(),
        limits.ugrid_warn_faces.to_string(),
        "--".to_owned(),
        path.to_owned(),
    ]
    .iter()
    .map(|part| shell_quote(part))
    .collect::<Vec<_>>()
    .join(" ")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

async fn wait_until_ready(child: &mut Child, port: u16) -> NcxResult<()> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("cannot inspect ssh: {error}"))?
        {
            return Err(format!("ssh exited before ncx was ready ({status})"));
        }
        if metadata_is_ready(port).await {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("timed out after 30 seconds".to_owned());
        }
        sleep(Duration::from_millis(100)).await;
    }
}

async fn metadata_is_ready(port: u16) -> bool {
    let check = async {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.ok()?;
        stream
            .write_all(b"GET /api/meta HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .await
            .ok()?;
        let mut response = [0_u8; 64];
        let length = stream.read(&mut response).await.ok()?;
        response[..length]
            .starts_with(b"HTTP/1.1 200")
            .then_some(())
    };
    timeout(Duration::from_millis(500), check)
        .await
        .ok()
        .flatten()
        .is_some()
}

async fn own_ssh_session(mut child: Child) -> NcxResult<()> {
    tokio::select! {
        signal = signal::ctrl_c() => {
            signal.map_err(|error| format!("cannot listen for Ctrl-C: {error}"))?;
            stop_child(&mut child).await;
            Ok(())
        }
        status = child.wait() => {
            let status = status.map_err(|error| format!("cannot wait for ssh: {error}"))?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("ssh session ended with {status}"))
            }
        }
    }
}

async fn stop_child(child: &mut Child) {
    let _ = child.start_kill();
    let _ = child.wait().await;
}

fn launch_browser(url: &str) -> bool {
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", ""]);
        command
    };

    command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_targets_and_quotes_paths_as_data() {
        let OpenTarget::Remote { destination, path } =
            classify_target("cluster:/data/a file's.nc").unwrap()
        else {
            panic!("expected a remote target");
        };

        assert_eq!(destination, "cluster");
        assert_eq!(path, "/data/a file's.nc");
        assert_eq!(shell_quote(&path), "'/data/a file'\"'\"'s.nc'");
    }

    #[test]
    fn parses_serve_limits_without_a_cli_dependency() {
        let command = parse_arguments(vec![
            "serve".into(),
            "--port".into(),
            "8765".into(),
            "--max-response-bytes".into(),
            "4096".into(),
            "--exit-on-stdin-eof".into(),
            "fixture.nc".into(),
        ])
        .unwrap();

        let ParsedCommand::Serve {
            port,
            limits,
            sources,
            exit_on_stdin_eof,
        } = command
        else {
            panic!("expected serve");
        };
        assert_eq!(port, 8765);
        assert_eq!(limits.max_response_bytes, 4096);
        assert_eq!(sources[0].id, "dataset");
        assert_eq!(sources[0].path, PathBuf::from("fixture.nc"));
        assert!(exit_on_stdin_eof);
    }

    #[test]
    fn parses_repeated_named_datasets_without_a_cli_dependency() {
        let command = parse_arguments(vec![
            "serve".into(),
            "--dataset".into(),
            "case-a=/data/a.nc".into(),
            "--dataset".into(),
            "case-b=/data/b.nc".into(),
        ])
        .unwrap();

        let ParsedCommand::Serve { sources, .. } = command else {
            panic!("expected serve");
        };
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].id, "case-a");
        assert_eq!(sources[1].path, PathBuf::from("/data/b.nc"));
    }
}
