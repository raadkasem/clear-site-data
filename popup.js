document.addEventListener("DOMContentLoaded", async () => {
  const siteUrl = document.getElementById("site-url");
  const clearBtn = document.getElementById("clear-btn");
  const btnText = document.getElementById("btn-text");
  const status = document.getElementById("status");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (
    !tab?.url ||
    tab.url.startsWith("chrome://") ||
    tab.url.startsWith("chrome-extension://") ||
    tab.url.startsWith("about:")
  ) {
    siteUrl.textContent = "Cannot clear data for this page";
    clearBtn.disabled = true;
    return;
  }

  const url = new URL(tab.url);
  const origin = url.origin;
  const hostname = url.hostname;

  siteUrl.textContent = origin;

  // Open external links in new tab (popup closes, so use chrome.tabs)
  document.querySelectorAll("a[target='_blank']").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: link.href });
    });
  });

  clearBtn.addEventListener("click", async () => {
    clearBtn.disabled = true;
    btnText.textContent = "Clearing\u2026";
    status.textContent = "";
    status.className = "status";

    try {
      const opts = {
        cookies: document.getElementById("cookies").checked,
        localStorage: document.getElementById("localStorage").checked,
        indexedDB: document.getElementById("indexedDB").checked,
        cacheStorage: document.getElementById("cacheStorage").checked,
        serviceWorkers: document.getElementById("serviceWorkers").checked,
        thirdPartyCookies: document.getElementById("thirdPartyCookies").checked,
      };

      // 1. Clear first-party data via browsingData API (origin-scoped)
      const dataToRemove = {};
      if (opts.cookies) dataToRemove.cookies = true;
      if (opts.localStorage) dataToRemove.localStorage = true;
      if (opts.indexedDB) dataToRemove.indexedDB = true;
      if (opts.cacheStorage) dataToRemove.cacheStorage = true;
      if (opts.serviceWorkers) dataToRemove.serviceWorkers = true;

      if (Object.keys(dataToRemove).length > 0) {
        await chrome.browsingData.remove({ origins: [origin] }, dataToRemove);
      }

      // 2. Clear sessionStorage via content script injection
      if (opts.localStorage) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              sessionStorage.clear();
            },
          });
        } catch {
          // May fail on restricted pages
        }
      }

      // 3. Clear third-party cookies
      if (opts.cookies && opts.thirdPartyCookies) {
        await clearThirdPartyCookies(tab, hostname);
      }

      // 4. Unregister service workers via content script
      if (opts.serviceWorkers) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async () => {
              const allRegs = await navigator.serviceWorker.getRegistrations();
              for (const reg of allRegs) {
                await reg.unregister();
              }
            },
          });
        } catch {
          // ignore
        }
      }

      status.textContent = "Site data cleared successfully";
      status.className = "status success";

      chrome.tabs.reload(tab.id);
    } catch (err) {
      status.textContent = "Error: " + err.message;
      status.className = "status error";
    } finally {
      clearBtn.disabled = false;
      btnText.textContent = "Clear site data";
    }
  });
});

async function clearThirdPartyCookies(tab, hostname) {
  let thirdPartyDomains = [];

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const domains = new Set();
        for (const entry of performance.getEntriesByType("resource")) {
          try {
            domains.add(new URL(entry.name).hostname);
          } catch {}
        }
        for (const iframe of document.querySelectorAll("iframe[src]")) {
          try {
            domains.add(new URL(iframe.src).hostname);
          } catch {}
        }
        return [...domains];
      },
    });

    if (results?.[0]?.result) {
      thirdPartyDomains = results[0].result.filter(
        (d) => d !== hostname && !d.endsWith("." + hostname)
      );
    }
  } catch {
    return;
  }

  for (const domain of thirdPartyDomains) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      for (const cookie of cookies) {
        const protocol = cookie.secure ? "https" : "http";
        const cookieUrl = `${protocol}://${cookie.domain.replace(/^\./, "")}${cookie.path}`;
        await chrome.cookies.remove({ url: cookieUrl, name: cookie.name });
      }
    } catch {
      // Continue clearing other domains
    }
  }
}
