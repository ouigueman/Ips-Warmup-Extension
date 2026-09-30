# IPs Warmup Extension

**A browser-based automation console for coordinating IP warmup runs, tracking queue results, and reviewing each drop from one configurable workflow.**

The extension adds controls to the existing deployment interface and coordinates browser actions with the project's companion services. It is built for operators who need repeatable drop scheduling, per-list quota tracking, pause/resume checks, and clear run reports.

> **Portfolio note:** This repository contains the Firefox extension source. Related Chrome, IceDragon, and Pale Moon versions are maintained separately by the creator and are managed through the same main website platform, where access can be allowed or denied centrally.

## Extension preview

![Full extension settings popup](docs/screenshots/extension-popup-full.png)

*Static capture of the settings popup. Live status, account validation, and service-backed features require the extension runtime and its companion services.*

## What it does

- **Automates configurable drop runs** from the existing deployment page, with a chosen number of drops, start offset, and per-drop schedule.
- **Organizes ISP profiles into a sequence** of Warmup Lists and Passive Lists. Warmup entries can be checked against their remaining quota; optional shuffle reorders the sequence before the first drop.
- **Rotates IP groups across drops.** Keep a main IP list and add groups that rotate in order, with sent targets, increments, and scale-up thresholds.
- **Tracks progress and recovery points.** The popup displays the last saved offset, and run settings include controls for starting from a chosen point or continuing a previous run.
- **Checks queue and pause/resume state.** The extension can verify operations through the deployment page or its MultiMonitor flow, and show progress in the page.
- **Applies optional stop conditions.** Configure delivery tolerance and, when email counting is enabled, stop thresholds based on a spam count or percentage.
- **Sends run updates and reports.** Telegram can receive per-drop updates, generated reports, and optional remote-stop handling.
- **Exports results to Google Sheets.** Drop reports and summary statistics can be written to a configured spreadsheet.
- **Offers optional post-drop email counting.** A companion service can count inbox/spam messages after a configured delay and report the result.
- **Connects to the creator's access platform.** The platform can allow or deny extension access across the browser versions.

## Automation flow

1. Open the supported deployment page and configure the run in the extension popup.
2. The extension checks access with the creator's platform and loads the saved browser settings.
3. It processes the configured ISP sequence and IP groups, coordinating deployment-page and MultiMonitor actions.
4. It checks queue results, updates the live progress view, and records list usage and run results with companion services.
5. If configured, it sends updates to Telegram, writes the report to Google Sheets, and performs post-drop email counting.

## Integrations and APIs

| Integration | How the extension uses it |
| --- | --- |
| **Creator's companion APIs** | Extension access checks; ISP list status and quota updates; list validation; application-password checks; report/data storage; email counts; and latest platform messages. |
| **Google Sheets API v4** | Creates or updates report sheets, writes drop and summary data, and formats report sections. Google OAuth 2.0 is used to request Sheets access. |
| **Telegram Bot API** | Sends status messages and reports, can upload a generated report document, and supports the configured remote-stop workflow. |
| **Deployment and MultiMonitor interfaces** | The content and background scripts interact with the existing pages to coordinate actions, read queue state, and verify pause/resume operations. |

The companion API implementations are **not included** in this repository. This project documents the extension-side integrations; backend behavior, hosting, data retention, and availability are managed separately.

## Built with

- Firefox WebExtensions APIs using a Manifest V2 extension structure
- JavaScript content scripts, background scripts, and popup logic
- HTML and CSS for the configuration interface
- Browser local storage for saved extension settings
- Fetch-based API integrations and Web Crypto for Google OAuth request signing

### Source files

| File | Responsibility |
| --- | --- |
| `manifest.json` | Extension metadata, permissions, popup, background scripts, and deployment-page content-script registration. |
| `popup.html` / `popup.js` | Configuration form, saved settings, validation, and starting a run. |
| `content.js` | Deployment-page automation, run orchestration, queue/result handling, reporting, and in-page panels. |
| `background.js` | Background coordination, tab operations, and MultiMonitor-related checks. |
| `googleSheets.js` | Google OAuth and spreadsheet report writing/formatting. |
| `telegram.js` | Telegram notifications and report delivery. |
| `config.js` | Integration configuration. **Review and secure this file before sharing the repository.** |

## Browser versions

The current repository contains the Firefox-oriented extension source. The creator also maintains separate versions for:

- Chrome
- IceDragon
- Pale Moon

The browser versions are connected to the creator's main website platform for centralized access management, including allowing or denying users. Those browser-specific packages and their compatibility details are not included in this repository.

## Security, privacy, and release readiness

**Do not publish or distribute this imported source as-is.** The current source snapshot contains a hard-coded Google service-account private key in `config.js`. Treat that key as exposed:

1. Revoke or rotate the credential immediately.
2. Remove secrets from the extension package and Git history; keep service credentials on a protected backend instead.
3. Review the Telegram and other integration credentials before publishing.
4. Move companion-service traffic to HTTPS and narrow the extension's host permissions to only the hosts it needs.
5. Review what the companion services store and who can access it.

Additional considerations visible in the current source:

- The extension requests broad host access in its manifest.
- Some companion-service requests use unencrypted HTTP.
- The access-check code currently allows the extension to continue if the check fails due to a network error. The website's allow/deny control is therefore **not fail-closed** in that case.
- When optional email counting is used, the Gmail address and app password are sent to a companion service. Review and protect that service's handling of those credentials.
- Telegram reports send run data to Telegram; spreadsheet reporting sends report data to the selected Google Sheet.

User configuration is stored in browser local storage, but that does **not** make bundled API credentials safe. This README is based on the checked-in extension source and is not a security audit or a guarantee of safe operation. Use the extension only with systems and accounts you are authorized to operate, and follow applicable laws and service policies.

## Loading the Firefox source for development

After the security issues above have been addressed and the required companion services are configured:

1. Open `about:debugging` in Firefox.
2. Choose **This Firefox**.
3. Select **Load Temporary Add-on…**.
4. Choose this repository's `manifest.json`.
5. Open the supported deployment page and confirm that the extension can reach its authorized companion services.

Temporary loading is for development and testing; it is not a signed distribution package. This repository does not include the companion backend services.

## Interested in a walkthrough or collaboration?

This project combines browser automation, service integrations, queue monitoring, and centralized access management. If you would like a walkthrough, a tailored deployment, or to discuss licensing and collaboration, contact the creator through their portfolio or project contact channel.
