# Azure Deployment Plan

> **Status:** Validated

Generated: 2026-10-25 (Asia/Calcutta)

## 1. Project Overview

**Goal:** Install the existing Bengaluru Transit AI application on the already-created Azure Ubuntu VM without changing its UI, journey-planning logic, live-bus filtering, Gemini behavior, or local Windows workflow.

**Path:** Modernize an existing local application for an existing Azure VM.

OpenTripPlanner and the Python web application will run as separate private Linux services on the same VM. A reverse proxy will be the only public web entry point.

## 2. Requirements

| Attribute | Value |
|-----------|-------|
| Classification | College-project proof of concept |
| Scale | Small; single presenter and demonstration users |
| Budget | Cost-optimized; run only when needed and deallocate/delete afterward |
| Subscription | Azure for Students (confirmed in Azure Portal) |
| Location | Central India (confirmed in Azure Portal) |
| Existing resource group | `bengaluru-transit-vm_group` |
| Existing VM | `bengaluru-transit-vm` |
| VM size | `Standard_B2as_v2` — 2 vCPU, 8 GiB RAM |
| Operating system | Ubuntu Server 24.04 LTS x64 |
| Functional constraint | No route-engine replacement, feature removal, or UI rebuild |

## 3. Components Detected

| Component | Type | Technology | Path |
|-----------|------|------------|------|
| Web UI | Static frontend | HTML, CSS, JavaScript, MapLibre | `static/` |
| Web/API server | Long-running API | Python `ThreadingHTTPServer` | `app.py` |
| Journey planner | Application module | Python + OpenTripPlanner GraphQL | `transit/otp.py` |
| Transit database | Local data | SQLite, 471,306,240 bytes | `data/bengaluru_transit.db` |
| Routing engine | Long-running Java service | OTP 2.8.1 / Java 21 | `otp/otp-shaded-2.8.1.jar` |
| Routing graph | Generated runtime data | OTP graph, 154,267,978 bytes | `otp/graph.obj` |
| Gemini assistant | Optional external integration | Google Gemini HTTPS API | `transit/gemini.py` |
| Live buses | Optional external integration | BMTC mobile HTTPS service | `transit/bmtc_live.py` |

```text
Public browser -> reverse proxy -> Python app (127.0.0.1:8765)
                                  -> OTP (127.0.0.1:8766)
                                  -> local SQLite database
                                  -> BMTC HTTPS service
                                  -> Gemini HTTPS API (when configured)
```

### Existing infrastructure

| Item | Status |
|------|--------|
| Azure VM, Standard SSD, public IP, VNet, NIC and NSG | Created and running |
| Azure deployment files in repository | Not previously present |
| Containers | Not present and not required for this VM deployment |
| Local uncommitted application changes | Present; must be tested and committed before installation |

## 4. Recipe Selection

**Selected:** AZCLI/manual-VM bootstrap rather than new AZD provisioning.

**Rationale:** The user already created every Azure resource. No further infrastructure needs provisioning. A reviewable bootstrap script plus `systemd` is simpler and cheaper than adding Container Registry, Container Apps, AKS, or App Service. Large ignored runtime files will be copied directly from the user's computer over SSH and will not be published without separate permission.

## 5. Architecture

**Stack:** Existing Azure Linux VM with native Linux services.

| Path/service | Purpose |
|--------------|---------|
| `/opt/bengaluru-transit` | Git checkout and runtime data |
| `bengaluru-otp.service` | Java 21 OTP, private port 8766, max heap 4 GiB |
| `bengaluru-app.service` | Python app, private port 8765 |
| `/etc/bengaluru-transit.env` | Root-readable secrets and environment variables |
| Reverse proxy | Public port 80 initially; HTTPS after hostname configuration |

The source repository remains small. These ignored files will be copied with `scp` and verified by SHA-256:

- `data/bengaluru_transit.db`
- `otp/graph.obj`
- `otp/otp-shaded-2.8.1.jar`

`app.py` will accept `APP_HOST` and `PORT` variables while keeping the local defaults `127.0.0.1:8765`, so Windows behavior remains unchanged.

## 6. Provisioning Limit Checklist

No additional Azure resource will be provisioned. Successful creation of the existing resources in Central India already proves subscription capacity.

| Resource type | Number still to deploy | Total after work | Result |
|---------------|------------------------|------------------|--------|
| Azure VM | 0 | 1 existing | Within limit; VM running |
| Managed disk | 0 | 1 existing | Within limit |
| Public IP | 0 | 1 existing | Within limit |
| VNet, NIC and NSG | 0 | 1 each existing | Within limit |

## 7. Validation Proof

Validated: 2026-10-25 (Asia/Calcutta)

Revalidated: 2026-10-26 (Asia/Calcutta) after the journey-dock UI, assistant latency, Gemini request, and OTP query changes.

| Check | Result |
|-------|--------|
| `python -m unittest discover -s tests -p "test_*.py"` | PASS — 93 tests |
| Frontend syntax and four Node regression suites | PASS |
| `python -m py_compile` for `app.py` and `transit/*.py` | PASS |
| VM-side `bash -n` for bootstrap and verification scripts | PASS |
| PowerShell parser for `upload-runtime.ps1` | PASS |
| Credential scan of deployment files | PASS — no keys present |
| SSH authentication to `azureuser@20.204.43.17` | PASS |
| VM capacity check | PASS — approximately 27 GB free and 7 GB memory available |
| Runtime assets | PASS — database, OTP graph and OTP JAR present locally |
| Static RBAC review | Not applicable — no managed identities or Azure data-plane services |
| Infrastructure template/policy validation | Not applicable — approved target is an existing VM; no Azure resources are provisioned |

The 2026-10-26 revalidation repeated the complete 93-test Python suite, all four Node regression suites, JavaScript syntax checking, Python byte-compilation, and `git diff --check`; every check passed.

## 8. Security and Cost Controls

- Keep SSH-key authentication; never copy the private key into Git or the VM.
- Run OTP and Python on loopback only; expose only the reverse proxy.
- Store Gemini credentials outside Git in `/etc/bengaluru-transit.env` with restrictive permissions.
- Open HTTP/HTTPS only after local health checks pass.
- Keep Azure Spot disabled and auto-shutdown enabled.
- Use Azure Portal **Stop** and verify `Stopped (deallocated)` to stop compute charges.
- Delete the resource group only after explicit user confirmation.
- Do not publicly distribute BMTC/OTP generated runtime data without confirming redistribution rights.

## 9. Execution Checklist

### Preparation

- [x] Analyze workspace and Azure context.
- [x] Identify components and runtime files.
- [x] Confirm subscription, region and existing VM from Azure screenshots.
- [x] Select existing-VM bootstrap recipe.
- [x] Confirm no additional Azure quota is needed.
- [x] Receive user approval for this plan.

### Implementation after approval

- [x] Review and test all current uncommitted application changes.
- [x] Make host/port environment-configurable without changing local defaults.
- [x] Add Linux bootstrap, service, reverse-proxy and verification files.
- [x] Add Azure start/stop/deletion instructions to the README.
- [x] Run all Python and frontend tests.
- [ ] Commit and push the tested deployment package.
- [ ] Copy runtime assets and verify SHA-256 checksums.
- [ ] Install Java 21, Python, Git and reverse proxy.
- [ ] Install and start OTP and app services.
- [ ] Open web ports only after local health checks pass.

### Validation

- [x] Run Azure validation and record proof.
- [ ] Confirm OTP GraphQL health on `127.0.0.1:8766`.
- [ ] Confirm `/api/health`, stop search, planning and static assets.
- [ ] Confirm external access, Gemini fallback/configuration and BMTC graceful failure.
- [ ] Confirm both services restart automatically after a VM restart.

### Rollback

- Stop and disable the two services.
- Restore the previous Git commit if an application regression occurs.
- Keep SSH available until external checks pass.
- Resource-group deletion always requires explicit confirmation.

## 10. Deployment Files

| File | Purpose |
|------|---------|
| `.azure/deployment-plan.md` | Deployment source of truth |
| `deploy/azure/bootstrap.sh` | Ubuntu dependency and service installer |
| `deploy/azure/bengaluru-otp.service` | OTP `systemd` unit |
| `deploy/azure/bengaluru-app.service` | Python `systemd` unit |
| `deploy/azure/nginx.conf` | Initial reverse proxy |
| `deploy/azure/verify.sh` | Server health verification |
| `deploy/azure/upload-runtime.ps1` | Windows-to-VM runtime-file transfer |
| `README.md` | Deployment and cost-control instructions |

## 11. Current Next Step

Commit and push the validated deployment package, then install it on the approved VM.
