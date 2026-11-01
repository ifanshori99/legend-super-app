# Infrastructure sizing and budget — legend-cyu.3

Research checked 1 November 2026; prices are published list prices, not contracted quotes. Owner ceiling is **strictly below Rp1,000,000/month including server and all recurring costs**. This is a one-outlet hypothesis, not a capacity or availability guarantee. Edge hardware purchase is excluded as instructed; its electricity, WAN and recurring services still count when known. PRD §2 capacity is per outlet: 300 concurrent customer devices, 150 active tables, 600 order items/hour and 40 staff devices; shared architecture must accommodate 50 outlets. Do not extrapolate this budget to 50 outlets.

## Small-VM scenario

One Jakarta Biznet Gio NEO Virtual Compute SM8.4 (4 vCPU, 8 GB RAM, 60 GB disk) runs web, API, worker, PostgreSQL, Caddy and backup/WAL tools in isolated containers. Reserve RAM for PostgreSQL/OS and monitor disk, CPU, I/O and connection pools; this is a sizing hypothesis requiring measurement. Keep edge web/API/database on outlet hardware with continuous synchronization and 15-minute standby snapshots, independent of cloud. No second cloud server is included.

| Monthly item | Assumption | IDR |
| --- | --- | ---: |
| VM | SM8.4, 4 vCPU / 8 GB / 60 GB | 709,000 |
| Live objects | 20 GB single-region × Rp1,000/GB | 20,000 |
| Backups and WAL | 100 GB single-region × Rp1,000/GB, **separate physical site to be confirmed** | 100,000 |
| KirimDev | Starter, one number, no outbound replies/templates | 25,000 |
| Cloudflare Free; free email | Within free limits | 0 |
| AI | Disabled until funded; no usage assumed | 0 |
| **Known subtotal** | Before unknowns below | **854,000** |
| **Remaining under ceiling** | Rp1,000,000 − Rp854,000; actual total must be less, not equal | **146,000** |

[Biznet Gio price list](https://www.biznetgio.com/en/pricelist) lists SM8.4 at Rp709,000/month and object storage rates; [KirimDev](https://kirimdev.com/) lists Starter at Rp25,000/month. The 20/100 GB volumes are planning assumptions, not a retention calculation. Confirm minimums, tax, VM network/egress, object requests/transfer, backup location and current price in a quote. The Rp146,000 is a maximum headroom, **not proof that all-in cost meets the cap**: tax, domain, monitoring, WAN/electricity, Meta charges, storage growth, extra numbers, paid email, LLM usage, payment/EDC rental and transaction fees are unknown. Obtain amounts and enforce alerts/caps before production. At or above Rp1,000,000 the plan fails the owner's cap; do not silently omit charges. Free email and zero AI are explicit workload limits, not evidence of a deploy-ready service.

## NFR gaps and cheapest candidate for compliance

- **RPO ≤5 minutes and RTO ≤4 hours** (PRD §2/§7): one VM alone does not provide off-site recovery or prove either target. Configure encrypted continuous PostgreSQL WAL archiving with `archive_timeout` no greater than five minutes and an independent-site base backup; alert on archive age/failure, capacity and restore failures. Archive timeout alone does not guarantee the end-to-end RPO. Measure end-to-end recovery from off-site backup, including provisioning, download, replay and validation; demonstrate RTO with timed drills. Confirm physically separate location, retention and costs before relying on the object-store row. Outage, backlog or site loss can violate RPO.
- **300 concurrent devices per outlet / 50 outlets**: 8 GB is unproven. Run PRD workload including 150 table sessions, 600 items/hour and 40 staff devices with realistic data, background jobs and edge sync; capture latency, errors, CPU, memory, I/O and connections. Run the separate shared 50-outlet test. Resize or distribute components based on results; no current price proves these targets.
- **99.9% cloud uptime**: one VM, its disk and deployment are single points of failure; backups do not provide high availability. Free CDN does not establish end-to-end uptime. Test monitoring, failure recovery and maintenance. Edge offline operation and standby activation ≤15 minutes are separate PRD requirements.

The cheapest *candidate* to satisfy recovery is the same VM plus an independently located, encrypted S3 base backup and continuous WAL as above; independent-site eligibility and actual end-to-end RPO/RTO are unverified. If capacity or availability tests fail, the next candidate is a separately located standby/second VM and tested failover, sized from results and quoted with storage, traffic and operations. No compliant cheapest configuration can be established without workload measurements, site/price confirmation and restore/failover tests; if the smallest passing option exceeds the cap, escalate the conflict rather than claim compliance. Stage and production simultaneously, or a warm standby, add recurring costs and are not covered by this single-VM estimate.

## Release evidence

Record provider quotes and all recurring expenses; verify residency and off-site independence; exercise full restore and PITR quarterly; measure WAL freshness continuously; run `legend-bxx5` load and `legend-6cpx` recovery drills. Verify the AUTH-02 signature issue in [providers.md](providers.md), free-tier eligibility and vendor contracts. Protect secrets, encrypted backups and tenant isolation. This document supplies a proposal, not a deployment or a test result.
