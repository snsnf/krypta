//! `api healthcheck`: the container's liveness probe.
//!
//! The runtime image carries no curl or wget, and adding one would put a
//! general-purpose network client into a container with no other use for it.
//! The binary can already open a socket, so it asks itself.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(3);

/// Healthy when `GET /health` at `addr` answers with status 200.
pub fn probe(addr: SocketAddr) -> anyhow::Result<()> {
    let mut stream = TcpStream::connect_timeout(&addr, TIMEOUT)?;
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    stream.write_all(b"GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
    // "HTTP/1.1 200" is exactly twelve bytes; the status code is the last three.
    let mut status_line = [0u8; 12];
    stream.read_exact(&mut status_line)?;
    anyhow::ensure!(
        &status_line[9..12] == b"200",
        "health route answered {}",
        String::from_utf8_lossy(&status_line)
    );
    Ok(())
}

/// Probes this process's own port, read the same way the server reads it.
pub fn run() -> anyhow::Result<()> {
    let port = match std::env::var("PORT") {
        Ok(value) if !value.is_empty() => value.parse::<u16>()?,
        _ => 8080,
    };
    probe(SocketAddr::from(([127, 0, 0, 1], port)))
}

#[cfg(test)]
mod tests {
    use super::probe;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};

    /// Accepts one connection and answers it with `response`.
    fn serve_once(response: &'static [u8]) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 256];
            let _ = stream.read(&mut request);
            stream.write_all(response).unwrap();
        });
        addr
    }

    #[test]
    fn a_200_is_healthy() {
        let addr = serve_once(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
        assert!(probe(addr).is_ok());
    }

    #[test]
    fn any_other_status_is_unhealthy() {
        let addr = serve_once(b"HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n");
        assert!(probe(addr).is_err());
    }

    #[test]
    fn nothing_listening_is_unhealthy() {
        // Bound and immediately dropped, so the port is free and refuses.
        let addr = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        assert!(probe(addr).is_err());
    }
}
