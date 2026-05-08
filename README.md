<h1 align="center">
  <img src="assets/icons/icon128.png" width="72" alt="ScreenScott logo" /><br/>
  ScreenScott
</h1>

<p align="center">
  <strong>Premium full-page & multi-tab screenshot extension for Chrome</strong><br/>
  Capture entire pages, visible areas, or batch-export dozens of tabs into a ZIP — all locally, with zero data sent anywhere.
</p>

<p align="center">
  <a href="#-installation"><img src="https://img.shields.io/badge/Install-Chrome%20Extension-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Install on Chrome"/></a>
  <a href="#-license"><img src="https://img.shields.io/badge/License-MIT-a78bfa?style=for-the-badge" alt="MIT License"/></a>
  <a href="#-browser-support"><img src="https://img.shields.io/badge/Chrome-109%2B-success?style=for-the-badge&logo=googlechrome" alt="Chrome 109+"/></a>
</p>

---

## 📌 Table of Contents

- [What is ScreenScott?](#-what-is-screenscott)
- [Features](#-features)
- [Browser Support](#-browser-support)
- [Installation](#-installation)
- [How to Use](#-how-to-use)
- [Keyboard Shortcuts](#-keyboard-shortcuts)
- [Permissions Explained](#-permissions-explained)
- [Privacy & Security](#-privacy--security)
- [Project Structure](#-project-structure)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🖼 What is ScreenScott?

**ScreenScott** is a free, open-source Chrome browser extension that lets you capture high-quality screenshots of any web page — whether it's just the visible viewport, the entire scrollable page, or a batch of multiple tabs exported as a ZIP archive.

Unlike cloud-based screenshot tools, ScreenScott works **100% locally** inside your browser. No account. No uploads. No third-party servers. Your captures stay on your machine.

It was built for:
- **Developers** archiving UI states, bug reports, or design references
- **Designers** capturing full-page mockups for review
- **Researchers** saving full articles, documentation, or web evidence
- **Content creators** batch-exporting tabs for mood boards or comparisons
- **Anyone** who wants a fast, beautiful, privacy-first screenshot tool

---

## ✨ Features

| Feature | Description |
|---|---|
| **Full-Page Capture** | Captures the entire scrollable page using Chrome DevTools Protocol — not just what's visible |
| **Visible Area Capture** | One-click snapshot of exactly what's on screen right now |
| **Multi-Tab Batch Export** | Select any number of open tabs and export all screenshots as a single `.zip` file |
| **PNG & JPEG** | Choose lossless PNG (best for UI/text) or compressed JPEG (best for photos) |
| **Smart Fallback** | If CDP capture fails, automatically falls back to a scroll-and-stitch engine |
| **Zoom & Pan Viewer** | Built-in image viewer with smooth zoom (5%–800%), drag-to-pan, and keyboard shortcuts |
| **One-Click Copy** | Copy any screenshot to clipboard as PNG instantly |
| **No Cloud, No Tracking** | Fully local — no network requests, no analytics, no ads |
| **Rate-Limit Safe** | Intelligent inter-tab and stitch delays prevent Chrome API quota errors |
| **Notification Count Stripping** | Automatically removes `(143)` style unread counts from tab titles and filenames |

---

## 🌐 Browser Support

| Browser | Support | Notes |
|---|---|---|
| **Google Chrome** | ✅ Fully supported | Version 109+ required (Manifest V3) |
| **Microsoft Edge** | ✅ Supported | Based on Chromium — load unpacked works |
| **Brave** | ✅ Supported | Chromium-based — load unpacked works |
| **Opera** | ⚠️ Partial | Chromium-based but extension store not available; load unpacked |
| **Firefox** | ❌ Not supported | Manifest V3 differences; would need significant porting |
| **Safari** | ❌ Not supported | Safari uses its own extension format |

> **Minimum Chrome version:** 109 (required for Manifest V3 with module-type service workers)  
> **Recommended:** Chrome 116+ for best Offscreen API compatibility

---

## 📦 Installation

### Load as Unpacked Extension (Developer Mode)

1. Download or clone this repository:
   ```bash
   git clone https://github.com/amolbangare08/ScreenScott.git
   ```

2. Open Chrome and navigate to:
   ```
   chrome://extensions
   ```

3. Enable **Developer mode** (toggle in the top-right corner).

4. Click **Load unpacked** and select the `ScreenScott/` folder (the one containing `manifest.json`).

5. The **ScreenScott** icon appears in your toolbar. Pin it for one-click access.

> **Note:** You'll need to click the reload button in `chrome://extensions` after pulling any updates.

---

## 🚀 How to Use

### Single Tab — Full Page
1. Navigate to any web page
2. Click the ScreenScott toolbar icon
3. Click **Full Page** → a viewer tab opens with your screenshot
4. Use **Download** (or press `D`) to save, or **Copy** (or press `C`) to copy to clipboard

### Single Tab — Visible Area
1. Click the ScreenScott toolbar icon
2. Click **Visible Area** — captures only what's currently on screen

### Multi-Tab Batch Export (ZIP)
1. Click the ScreenScott toolbar icon
2. Click **Multiple Tabs** → the Batch Picker opens
3. Select which tabs to capture (tabs in your current window are pre-selected)
4. Choose **Full Page** or **Visible Area** mode
5. Choose **PNG** or **JPEG** format
6. Click **Capture & Export ZIP**
7. Watch the real-time progress list — each tab is captured in order
8. A `.zip` file is automatically saved to your Downloads folder when done

### Viewer Controls
| Action | Keyboard | Mouse |
|---|---|---|
| Zoom In | `+` or `=` | Ctrl + Scroll Up |
| Zoom Out | `-` | Ctrl + Scroll Down |
| Fit to Screen | `F` | Click Fit button |
| Actual Size (100%) | `0` | Click 1:1 button |
| Pan | — | Drag image |
| Download | `D` | Click Download |
| Copy to Clipboard | `C` | Click Copy |

---

## ⌨ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Alt + Shift + S` | Capture full page (active tab) |
| `Alt + Shift + V` | Capture visible area (active tab) |
| `1` (in popup) | Quick-trigger Full Page |
| `2` (in popup) | Quick-trigger Visible Area |
| `3` (in popup) | Open Batch Picker |

> Shortcuts can be customized at `chrome://extensions/shortcuts`

---

## 🔒 Permissions Explained

ScreenScott requests only the permissions it genuinely needs:

| Permission | Why it's needed |
|---|---|
| `activeTab` | Access the currently focused tab for single captures |
| `tabs` | List all open tabs in the Batch Picker and activate them for capture |
| `debugger` | Attach Chrome DevTools Protocol to capture full-page screenshots |
| `scripting` | Inject helpers to measure page dimensions and trigger lazy-load |
| `storage` | Remember your format preference (PNG/JPEG) across sessions |
| `downloads` | Save screenshots and ZIP archives to your Downloads folder |
| `unlimitedStorage` | Store large captures temporarily without hitting the default 5 MB quota |
| `<all_urls>` | Allow capture of any page you visit (no specific domains hardcoded) |

---

## 🛡 Privacy & Security

- **Zero network requests** — ScreenScott never sends any data outside your browser
- **No analytics or telemetry** — no tracking of any kind
- **No third-party dependencies** — the entire extension is vanilla JS with zero npm packages
- **Local processing only** — captures are stored temporarily in `chrome.storage.local` and removed after 30 minutes
- **Open source** — every line of code is auditable in this repository

---

## 📁 Project Structure

```
ScreenScott/
├── manifest.json                  # Extension manifest (MV3)
├── assets/
│   └── icons/                     # Extension icons (16, 32, 48, 128px)
└── src/
    ├── background/
    │   ├── service-worker.js      # Message routing & capture orchestration
    │   ├── capture.js             # CDP full-page & scroll-and-stitch engines
    │   ├── batch.js               # Multi-tab batch capture orchestrator
    │   ├── zip.js                 # In-memory ZIP builder (STORE method, no deps)
    │   └── util.js                # Shared helpers (filename, sleep, etc.)
    ├── popup/
    │   ├── popup.html             # Toolbar popup UI
    │   ├── popup.js               # Popup controller
    │   └── popup.css              # Popup styles
    ├── picker/
    │   ├── picker.html            # Batch tab picker UI
    │   ├── picker.js              # Picker controller with real-time progress
    │   └── picker.css             # Picker styles
    └── viewer/
        ├── viewer.html            # Screenshot viewer tab UI
        ├── viewer.js              # Zoom, pan, copy, download logic
        └── viewer.css             # Viewer styles
```

---

## 🤝 Contributing

Contributions are welcome! Here's how to get started:

1. **Fork** this repository
2. **Clone** your fork: `git clone https://github.com/your-username/ScreenScott.git`
3. Make your changes (load unpacked to test locally)
4. **Open a pull request** with a clear description of what you changed and why

Please keep PRs focused — one feature or fix per PR. For larger changes, open an issue first to discuss the approach.

---

## 📄 License

ScreenScott is released under the **MIT License**. See [LICENSE](LICENSE) for full details.

You are free to use, modify, and distribute this software for any purpose, including commercial use, as long as the original copyright notice is retained.

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/amolbangare08">Amol Bangare</a>
</p>
