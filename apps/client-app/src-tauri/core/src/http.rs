use crate::headers::Header;
use crate::ports::{Http, HttpRequest, HttpResponse, Limits, PortError};
use futures_util::StreamExt;
use reqwest::redirect::Policy;
use reqwest::{Client, Method};

pub struct ReqwestHttp {
    streaming: Client,
}

fn builder() -> reqwest::ClientBuilder {
    Client::builder().redirect(Policy::none())
}

fn failure(error: &reqwest::Error) -> PortError {
    let text = if error.is_timeout() {
        "timed out"
    } else if error.is_connect() {
        "connection failed"
    } else {
        "request failed"
    };
    PortError(text.to_owned())
}

impl ReqwestHttp {
    pub fn new() -> Result<Self, PortError> {
        let streaming = builder().build().map_err(|error| failure(&error))?;
        Ok(Self { streaming })
    }

    fn client_for(&self, limits: Option<Limits>) -> Result<Client, PortError> {
        match limits {
            Some(limits) => builder()
                .connect_timeout(limits.connect)
                .build()
                .map_err(|error| failure(&error)),
            None => Ok(self.streaming.clone()),
        }
    }
}

impl Http for ReqwestHttp {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, PortError> {
        let method = Method::from_bytes(request.method.as_bytes())
            .map_err(|_| PortError("invalid method".to_owned()))?;
        let mut call = self
            .client_for(request.limits)?
            .request(method, &request.url);
        for (name, value) in &request.headers {
            call = call.header(name, value);
        }
        if !request.body.is_empty() {
            call = call.body(request.body);
        }
        if let Some(limits) = request.limits {
            call = call.timeout(limits.total);
        }
        let response = call.send().await.map_err(|error| failure(&error))?;
        let status = response.status().as_u16();
        let headers: Vec<Header> = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned()))
            })
            .collect();
        let body = response
            .bytes_stream()
            .map(|chunk| {
                chunk
                    .map(|bytes| bytes.to_vec())
                    .map_err(|error| failure(&error))
            })
            .boxed();
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}
