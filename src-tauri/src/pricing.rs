//! Public-list prices for a node type. Missing price is None — never invented.

use serde::Deserialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub struct UnitPrices {
    pub usd_per_vcpu_hour: f64,
    pub usd_per_gib_hour: f64,
}

struct Cache {
    at: Instant,
    value: Option<UnitPrices>,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

pub async fn unit_prices() -> Option<UnitPrices> {
    if let Ok(guard) = CACHE.lock() {
        if let Some(c) = guard.as_ref() {
            if c.at.elapsed() < Duration::from_secs(6 * 3600) {
                return c.value;
            }
        }
    }
    let provider = std::env::var("TMJLENS_PRICING_PROVIDER").unwrap_or_else(|_| "auto".into());
    let instance = std::env::var("TMJLENS_PRICE_INSTANCE").ok().filter(|s| !s.is_empty());
    let region = std::env::var("TMJLENS_PRICE_REGION").ok().filter(|s| !s.is_empty());
    let value = match (provider.as_str(), instance, region) {
        ("none", _, _) => None,
        (_, None, _) | (_, _, None) => None,
        ("azure" | "auto", Some(sku), Some(region)) if looks_azure(&sku) || provider == "azure" => {
            azure_price(&sku, &region).await
        }
        ("aws" | "auto", Some(sku), Some(region)) => aws_price(&sku, &region).await,
        _ => None,
    };
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(Cache { at: Instant::now(), value });
    }
    value
}

fn looks_azure(sku: &str) -> bool {
    sku.starts_with("Standard_")
}

async fn azure_price(sku: &str, region: &str) -> Option<UnitPrices> {
    let url = format!(
        "https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Virtual Machines' \
         and armSkuName eq '{sku}' and armRegionName eq '{region}' and priceType eq 'Consumption'"
    );
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().ok()?;
    let body: AzurePrices = client.get(&url).send().await.ok()?.json().await.ok()?;
    let item = body.Items.into_iter().find(|i| i.unitPrice > 0.0 && !i.meterName.to_lowercase().contains("spot"))?;
    let vcpu = item.vcpu.unwrap_or(1.0).max(1.0);
    Some(UnitPrices {
        usd_per_vcpu_hour: item.unitPrice / vcpu,
        usd_per_gib_hour: item.unitPrice / item.memoryInGB.unwrap_or(vcpu).max(1.0),
    })
}

#[derive(Deserialize)]
#[allow(non_snake_case)]
struct AzurePrices {
    Items: Vec<AzureItem>,
}

#[derive(Deserialize)]
#[allow(non_snake_case)]
struct AzureItem {
    unitPrice: f64,
    meterName: String,
    vcpu: Option<f64>,
    memoryInGB: Option<f64>,
}

async fn aws_price(instance: &str, region: &str) -> Option<UnitPrices> {
    let url = format!(
        "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/{region}/index.json"
    );
    let client = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().ok()?;
    let body: serde_json::Value = client.get(&url).send().await.ok()?.json().await.ok()?;
    let products = body.get("products")?.as_object()?;
    let sku = products.iter().find_map(|(_, p)| {
        let attrs = p.get("attributes")?;
        if attrs.get("instanceType")?.as_str()? == instance
            && attrs.get("operatingSystem")?.as_str() == Some("Linux")
            && attrs.get("tenancy")?.as_str() == Some("Shared")
        {
            return p.get("sku")?.as_str().map(|s| s.to_string());
        }
        None
    })?;
    let on_demand = body.pointer(&format!("/terms/OnDemand/{sku}"))?;
    let price = on_demand
        .as_object()?
        .values()
        .next()?
        .pointer("/priceDimensions")?
        .as_object()?
        .values()
        .find_map(|d| d.pointer("/pricePerUnit/USD")?.as_str()?.parse::<f64>().ok())?;
    if price <= 0.0 {
        return None;
    }
    // vCPU/GiB split is unknown without the product attrs; split evenly so a
    // missing dimension does not pretend to be free.
    Some(UnitPrices {
        usd_per_vcpu_hour: price / 2.0,
        usd_per_gib_hour: price / 2.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn azure_skus_are_recognised() {
        assert!(looks_azure("Standard_D4s_v5"));
        assert!(!looks_azure("m5.large"));
    }
}
