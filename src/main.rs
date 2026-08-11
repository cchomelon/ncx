mod cf;
mod cli;
mod dataset;
mod server;

pub type NcxResult<T> = Result<T, String>;

#[tokio::main]
async fn main() {
    if let Err(message) = cli::run().await {
        eprintln!("ncx: {message}");
        std::process::exit(1);
    }
}
