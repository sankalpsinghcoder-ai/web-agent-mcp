import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createServer } from "node:http";
import { z } from "zod";
import {
  chromium,
  Browser,
  BrowserContext,
  Page,
} from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT || 3000);

const server = new McpServer({
  name: "web-agent",
  version: "0.2.0",
});

/* =========================================================
   BROWSER STATE
========================================================= */

let browser: Browser | null = null;
let context: BrowserContext | null = null;

const pages = new Map<string, Page>();
let activePageId: string | null = null;

let profilePath: string | null = null;

/* =========================================================
   HELPERS
========================================================= */

function makePageId(): string {
  return `page_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function jsonResponse(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function textResponse(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
  };
}

async function ensureBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: false,
      slowMo: 300,
    });
  }

  if (!context) {
    context = await browser.newContext({
      acceptDownloads: true,
    });
  }

  return context;
}

async function getPage(): Promise<Page> {
  const ctx = await ensureBrowser();

  if (activePageId && pages.has(activePageId)) {
    return pages.get(activePageId)!;
  }

  const existing = ctx.pages();

  if (existing.length > 0) {
    const page = existing[0];
    const id = makePageId();

    pages.set(id, page);
    activePageId = id;

    attachPageListeners(id, page);

    return page;
  }

  const page = await ctx.newPage();
  const id = makePageId();

  pages.set(id, page);
  activePageId = id;

  attachPageListeners(id, page);

  return page;
}

function attachPageListeners(id: string, page: Page) {
  page.on("close", () => {
    pages.delete(id);

    if (activePageId === id) {
      const next = pages.keys().next();

      activePageId = next.done ? null : next.value;
    }
  });
}

async function createPage(url?: string) {
  const ctx = await ensureBrowser();

  const page = await ctx.newPage();
  const id = makePageId();

  pages.set(id, page);
  activePageId = id;

  attachPageListeners(id, page);

  if (url) {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  }

  return {
    id,
    page,
  };
}

function getPageById(id: string): Page {
  const page = pages.get(id);

  if (!page) {
    throw new Error(`Unknown page/tab id: ${id}`);
  }

  return page;
}

/* =========================================================
   EXISTING TOOL
   NAVIGATE
========================================================= */

server.registerTool(
  "browser_navigate",
  {
    description: "Navigate the active browser tab to a URL.",
    inputSchema: {
      url: z.string().url(),
    },
  },
  async ({ url }) => {
    const p = await getPage();

    await p.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    return jsonResponse({
      url: p.url(),
      title: await p.title(),
    });
  }
);

/* =========================================================
   EXISTING TOOL
   INSPECT
========================================================= */

server.registerTool(
  "browser_inspect",
  {
    description:
      "Inspect the current webpage and return interactive elements and visible text.",
  },
  async () => {
    const p = await getPage();

    const result = await p.evaluate(() => {
      const elements = Array.from(
        document.querySelectorAll(
          "button, input, textarea, select, a, [role='button'], [role='link'], [contenteditable='true']"
        )
      );

      return {
        url: location.href,
        title: document.title,

        elements: elements.map((el, index) => ({
          index,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          text: (el.textContent || "").trim().slice(0, 300),
          ariaLabel: el.getAttribute("aria-label"),
          placeholder: el.getAttribute("placeholder"),
          name: el.getAttribute("name"),
          type: el.getAttribute("type"),
          value:
            "value" in el
              ? String((el as HTMLInputElement).value).slice(0, 300)
              : null,
          disabled:
            "disabled" in el
              ? Boolean((el as HTMLInputElement).disabled)
              : false,
        })),

        visibleText: document.body.innerText.slice(0, 10000),
      };
    });

    return jsonResponse(result);
  }
);

/* =========================================================
   EXISTING TOOL
   CLICK
========================================================= */

server.registerTool(
  "browser_click",
  {
    description: "Click an element identified by inspection index.",
    inputSchema: {
      index: z.number().int().nonnegative(),
    },
  },
  async ({ index }) => {
    const p = await getPage();

    const locator = p
      .locator(
        "button, input, textarea, select, a, [role='button'], [role='link'], [contenteditable='true']"
      )
      .nth(index);

    await locator.scrollIntoViewIfNeeded();
    await locator.click();

    return textResponse(`Clicked element ${index}`);
  }
);

/* =========================================================
   EXISTING TOOL
   TYPE
========================================================= */

server.registerTool(
  "browser_type",
  {
    description: "Type text into an input or textarea.",
    inputSchema: {
      index: z.number().int().nonnegative(),
      text: z.string(),
    },
  },
  async ({ index, text }) => {
    const p = await getPage();

    const locator = p
      .locator("input, textarea, [contenteditable='true']")
      .nth(index);

    await locator.fill(text);

    return textResponse(`Typed text into element ${index}`);
  }
);

/* =========================================================
   EXISTING TOOL
   SELECT
========================================================= */

server.registerTool(
  "browser_select",
  {
    description: "Select an option from a select element.",
    inputSchema: {
      index: z.number().int().nonnegative(),
      value: z.string(),
    },
  },
  async ({ index, value }) => {
    const p = await getPage();

    const locator = p.locator("select").nth(index);

    await locator.selectOption(value);

    return textResponse(`Selected ${value}`);
  }
);

/* =========================================================
   EXISTING TOOL
   SCROLL
========================================================= */

server.registerTool(
  "browser_scroll",
  {
    description: "Scroll the webpage.",
    inputSchema: {
      direction: z.enum(["up", "down"]),
      amount: z.number().int().positive().default(700),
    },
  },
  async ({ direction, amount }) => {
    const p = await getPage();

    const distance = direction === "down" ? amount : -amount;

    await p.evaluate((distance) => {
      window.scrollBy({
        top: distance,
        behavior: "smooth",
      });
    }, distance);

    return textResponse(`Scrolled ${direction} by ${amount}px`);
  }
);

/* =========================================================
   EXISTING TOOL
   READ
========================================================= */

server.registerTool(
  "browser_read",
  {
    description: "Read the current visible webpage text.",
    inputSchema: {},
  },
  async () => {
    const p = await getPage();

    const text = await p.locator("body").innerText();

    return textResponse(text.slice(0, 20000));
  }
);

/* =========================================================
   1. SCREENSHOT
========================================================= */

server.registerTool(
  "browser_screenshot",
  {
    description: "Take a screenshot of the active browser page.",
    inputSchema: {
      path: z.string().optional(),
      fullPage: z.boolean().default(false),
    },
  },
  async ({ path: outputPath, fullPage }) => {
    const p = await getPage();

    const screenshot = await p.screenshot({
      path: outputPath,
      fullPage,
    });

    return {
      content: [
        {
          type: "image" as const,
          data: screenshot.toString("base64"),
          mimeType: "image/png",
        },
      ],
    };
  }
);

/* =========================================================
   2. WAIT
========================================================= */

server.registerTool(
  "browser_wait",
  {
    description: "Wait for a specified amount of time.",
    inputSchema: {
      milliseconds: z.number().int().nonnegative().max(120000),
    },
  },
  async ({ milliseconds }) => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));

    return textResponse(`Waited ${milliseconds}ms`);
  }
);

/* =========================================================
   3. KEYBOARD
========================================================= */

server.registerTool(
  "browser_keyboard",
  {
    description: "Press a keyboard key or type keyboard text.",
    inputSchema: {
      action: z.enum(["press", "type"]),
      value: z.string(),
    },
  },
  async ({ action, value }) => {
    const p = await getPage();

    if (action === "press") {
      await p.keyboard.press(value);
    } else {
      await p.keyboard.type(value);
    }

    return textResponse(`Keyboard ${action}: ${value}`);
  }
);

/* =========================================================
   4. HOVER
========================================================= */

server.registerTool(
  "browser_hover",
  {
    description: "Hover over an element.",
    inputSchema: {
      selector: z.string(),
    },
  },
  async ({ selector }) => {
    const p = await getPage();

    await p.locator(selector).hover();

    return textResponse(`Hovered over ${selector}`);
  }
);

/* =========================================================
   5. BACK
========================================================= */

server.registerTool(
  "browser_back",
  {
    description: "Navigate back in browser history.",
    inputSchema: {},
  },
  async () => {
    const p = await getPage();

    await p.goBack({
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    return jsonResponse({
      url: p.url(),
      title: await p.title(),
    });
  }
);

/* =========================================================
   6. FORWARD
========================================================= */

server.registerTool(
  "browser_forward",
  {
    description: "Navigate forward in browser history.",
    inputSchema: {},
  },
  async () => {
    const p = await getPage();

    await p.goForward({
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    return jsonResponse({
      url: p.url(),
      title: await p.title(),
    });
  }
);

/* =========================================================
   7. RELOAD
========================================================= */

server.registerTool(
  "browser_reload",
  {
    description: "Reload the current page.",
    inputSchema: {},
  },
  async () => {
    const p = await getPage();

    await p.reload({
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    return jsonResponse({
      url: p.url(),
      title: await p.title(),
    });
  }
);

/* =========================================================
   8. NEW TAB
========================================================= */

server.registerTool(
  "browser_new_tab",
  {
    description: "Create a new browser tab.",
    inputSchema: {
      url: z.string().url().optional(),
    },
  },
  async ({ url }) => {
    const result = await createPage(url);

    return jsonResponse({
      tabId: result.id,
      url: result.page.url(),
      title: await result.page.title(),
    });
  }
);

/* =========================================================
   9. SWITCH TAB
========================================================= */

server.registerTool(
  "browser_switch_tab",
  {
    description: "Switch the active browser tab.",
    inputSchema: {
      tabId: z.string(),
    },
  },
  async ({ tabId }) => {
    const page = getPageById(tabId);

    activePageId = tabId;

    await page.bringToFront();

    return jsonResponse({
      tabId,
      url: page.url(),
      title: await page.title(),
    });
  }
);

/* =========================================================
   10. CLOSE TAB
========================================================= */

server.registerTool(
  "browser_close_tab",
  {
    description: "Close a browser tab.",
    inputSchema: {
      tabId: z.string().optional(),
    },
  },
  async ({ tabId }) => {
    const id = tabId || activePageId;

    if (!id) {
      throw new Error("No active tab");
    }

    const page = getPageById(id);

    await page.close();

    pages.delete(id);

    if (activePageId === id) {
      const next = pages.keys().next();

      activePageId = next.done ? null : next.value;

      if (activePageId) {
        await pages.get(activePageId)!.bringToFront();
      }
    }

    return textResponse(`Closed tab ${id}`);
  }
);

/* =========================================================
   11. LIST TABS
========================================================= */

server.registerTool(
  "browser_list_tabs",
  {
    description: "List all open browser tabs.",
    inputSchema: {},
  },
  async () => {
    const tabs = [];

    for (const [id, page] of pages.entries()) {
      tabs.push({
        tabId: id,
        active: id === activePageId,
        url: page.url(),
        title: await page.title().catch(() => ""),
      });
    }

    return jsonResponse(tabs);
  }
);

/* =========================================================
   12. SEMANTIC INSPECT
========================================================= */

server.registerTool(
  "browser_inspect_semantic",
  {
    description:
      "Inspect the page semantically using roles, accessible names, labels, states and stable element metadata.",
    inputSchema: {},
  },
  async () => {
    const p = await getPage();

    const result = await p.evaluate(() => {
      const selectors = [
        "button",
        "a",
        "input",
        "textarea",
        "select",
        "option",
        "[role]",
        "[contenteditable='true']",
      ];

      const elements = Array.from(
        document.querySelectorAll(selectors.join(","))
      );

      return elements
        .map((el, index) => {
          const htmlEl = el as HTMLElement;

          const rect = htmlEl.getBoundingClientRect();

          const label =
            htmlEl.getAttribute("aria-label") ||
            htmlEl.getAttribute("title") ||
            (htmlEl as HTMLInputElement).placeholder ||
            htmlEl.textContent?.trim() ||
            "";

          return {
            id: `element_${index}`,
            tag: htmlEl.tagName.toLowerCase(),
            role:
              htmlEl.getAttribute("role") ||
              ({
                BUTTON: "button",
                A: "link",
                INPUT: "textbox",
                TEXTAREA: "textbox",
                SELECT: "combobox",
              } as Record<string, string>)[htmlEl.tagName] ||
              null,

            name: label.slice(0, 300),

            ariaLabel: htmlEl.getAttribute("aria-label"),

            placeholder: htmlEl.getAttribute("placeholder"),

            type: htmlEl.getAttribute("type"),

            nameAttribute: htmlEl.getAttribute("name"),

            value:
              "value" in htmlEl
                ? String(
                    (htmlEl as HTMLInputElement).value
                  ).slice(0, 300)
                : null,

            disabled:
              "disabled" in htmlEl
                ? Boolean((htmlEl as HTMLInputElement).disabled)
                : false,

            checked:
              "checked" in htmlEl
                ? Boolean((htmlEl as HTMLInputElement).checked)
                : false,

            visible:
              rect.width > 0 &&
              rect.height > 0 &&
              getComputedStyle(htmlEl).visibility !== "hidden" &&
              getComputedStyle(htmlEl).display !== "none",

            bounds: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
          };
        })
        .filter((el) => el.visible);
    });

    return jsonResponse({
      url: p.url(),
      title: await p.title(),
      elements: result,
    });
  }
);

/* =========================================================
   13. GET ELEMENT
========================================================= */

server.registerTool(
  "browser_get_element",
  {
    description:
      "Find an element using a CSS selector, text, role, label, placeholder or semantic identifier.",
    inputSchema: {
      strategy: z.enum([
        "css",
        "text",
        "role",
        "label",
        "placeholder",
      ]),
      value: z.string(),
    },
  },
  async ({ strategy, value }) => {
    const p = await getPage();

    let locator;

    switch (strategy) {
      case "css":
        locator = p.locator(value);
        break;

      case "text":
        locator = p.getByText(value, {
          exact: false,
        });
        break;

      case "role":
        locator = p.getByRole(
          value as Parameters<typeof p.getByRole>[0]
        );
        break;

      case "label":
        locator = p.getByLabel(value);
        break;

      case "placeholder":
        locator = p.getByPlaceholder(value);
        break;
    }

    const count = await locator.count();

    if (count === 0) {
      return jsonResponse({
        found: false,
        count: 0,
      });
    }

    const first = locator.first();

    return jsonResponse({
      found: true,
      count,
      element: {
        tag: await first.evaluate((el) => el.tagName.toLowerCase()),
        text: (await first.textContent())?.trim().slice(0, 500),
        visible: await first.isVisible().catch(() => false),
        enabled: await first.isEnabled().catch(() => false),
      },
    });
  }
);

/* =========================================================
   14. EXTRACT
========================================================= */

server.registerTool(
  "browser_extract",
  {
    description: "Extract structured data from elements matching a selector.",
    inputSchema: {
      selector: z.string(),
      fields: z
        .array(
          z.object({
            name: z.string(),
            selector: z.string().optional(),
            attribute: z.string().optional(),
          })
        )
        .min(1),
    },
  },
  async ({ selector, fields }) => {
    const p = await getPage();

    const data = await p.locator(selector).evaluateAll(
      (elements, fields) => {
        return elements.map((element) => {
          const root = element as HTMLElement;

          const result: Record<string, string | null> = {};

          for (const field of fields) {
            const target = field.selector
              ? root.querySelector(field.selector)
              : root;

            if (!target) {
              result[field.name] = null;
              continue;
            }

            if (field.attribute) {
              result[field.name] =
                target.getAttribute(field.attribute);
            } else {
              result[field.name] =
                (target.textContent || "").trim();
            }
          }

          return result;
        });
      },
      fields
    );

    return jsonResponse(data);
  }
);

/* =========================================================
   15. FILL FORM
========================================================= */

server.registerTool(
  "browser_fill_form",
  {
    description: "Fill multiple form fields in one operation.",
    inputSchema: {
      fields: z
        .array(
          z.object({
            selector: z.string(),
            value: z.string(),
          })
        )
        .min(1),
    },
  },
  async ({ fields }) => {
    const p = await getPage();

    const results = [];

    for (const field of fields) {
      const locator = p.locator(field.selector);

      await locator.fill(field.value);

      results.push({
        selector: field.selector,
        filled: true,
      });
    }

    return jsonResponse(results);
  }
);

/* =========================================================
   16. UPLOAD FILE
========================================================= */

server.registerTool(
  "browser_upload_file",
  {
    description: "Upload one or more files to a file input.",
    inputSchema: {
      selector: z.string(),
      files: z.array(z.string()).min(1),
    },
  },
  async ({ selector, files }) => {
    const p = await getPage();

    const resolvedFiles = files.map((file) =>
      path.resolve(file)
    );

    for (const file of resolvedFiles) {
      await fs.access(file);
    }

    await p.locator(selector).setInputFiles(resolvedFiles);

    return jsonResponse({
      selector,
      files: resolvedFiles,
    });
  }
);

/* =========================================================
   17. DOWNLOAD
========================================================= */

server.registerTool(
  "browser_download",
  {
    description:
      "Click a download element and save the resulting file.",
    inputSchema: {
      selector: z.string(),
      path: z.string().optional(),
    },
  },
  async ({ selector, path: outputPath }) => {
    const p = await getPage();

    const downloadPromise = p.waitForEvent("download");

    await p.locator(selector).click();

    const download = await downloadPromise;

    const suggestedName = download.suggestedFilename();

    const finalPath =
      outputPath ||
      path.join(process.cwd(), "downloads", suggestedName);

    await fs.mkdir(path.dirname(finalPath), {
      recursive: true,
    });

    await download.saveAs(finalPath);

    return jsonResponse({
      path: finalPath,
      filename: suggestedName,
      failure: await download.failure(),
    });
  }
);

/* =========================================================
   18. WAIT FOR ELEMENT
========================================================= */

server.registerTool(
  "browser_wait_for_element",
  {
    description: "Wait until an element reaches the requested state.",
    inputSchema: {
      selector: z.string(),
      state: z
        .enum(["attached", "detached", "visible", "hidden"])
        .default("visible"),
      timeout: z.number().int().positive().default(30000),
    },
  },
  async ({ selector, state, timeout }) => {
    const p = await getPage();

    await p.locator(selector).waitFor({
      state,
      timeout,
    });

    return textResponse(
      `Element ${selector} reached state ${state}`
    );
  }
);

/* =========================================================
   19. WAIT FOR TEXT
========================================================= */

server.registerTool(
  "browser_wait_for_text",
  {
    description: "Wait until text appears on the page.",
    inputSchema: {
      text: z.string(),
      timeout: z.number().int().positive().default(30000),
    },
  },
  async ({ text, timeout }) => {
    const p = await getPage();

    await p.getByText(text, {
      exact: false,
    }).first().waitFor({
      state: "visible",
      timeout,
    });

    return textResponse(`Text appeared: ${text}`);
  }
);

/* =========================================================
   20. WAIT FOR NAVIGATION
========================================================= */

server.registerTool(
  "browser_wait_for_navigation",
  {
    description: "Wait for browser navigation to complete.",
    inputSchema: {
      url: z.string().optional(),
      timeout: z.number().int().positive().default(30000),
    },
  },
  async ({ url, timeout }) => {
    const p = await getPage();

    if (url) {
      await p.waitForURL(url, {
        timeout,
        waitUntil: "domcontentloaded",
      });
    } else {
      await p.waitForLoadState("domcontentloaded", {
        timeout,
      });
    }

    return jsonResponse({
      url: p.url(),
      title: await p.title(),
    });
  }
);

/* =========================================================
   21. PERMISSIONS
========================================================= */

server.registerTool(
  "browser_permissions",
  {
    description:
      "Grant or clear browser permissions for an origin.",
    inputSchema: {
      action: z.enum(["grant", "clear"]),
      origin: z.string().url(),
      permissions: z
        .array(z.string())
        .optional(),
    },
  },
  async ({ action, origin, permissions }) => {
    const ctx = await ensureBrowser();

    if (action === "grant") {
      if (!permissions || permissions.length === 0) {
        throw new Error(
          "permissions are required when action=grant"
        );
      }

      await ctx.grantPermissions(
        permissions,
        {
          origin,
        }
      );

      return jsonResponse({
        action,
        origin,
        permissions,
      });
    }

    await ctx.clearPermissions();

    return jsonResponse({
      action,
      origin,
    });
  }
);

/* =========================================================
   22. SESSION
========================================================= */

server.registerTool(
  "browser_session",
  {
    description:
      "Inspect or manage the current browser session.",
    inputSchema: {
      action: z.enum([
        "info",
        "close",
        "clear_cookies",
        "clear_permissions",
      ]),
    },
  },
  async ({ action }) => {
    const ctx = await ensureBrowser();

    if (action === "close") {
      for (const page of pages.values()) {
        await page.close().catch(() => {});
      }

      pages.clear();
      activePageId = null;

      await ctx.close();

      context = null;

      if (browser) {
        await browser.close().catch(() => {});
      }

      browser = null;

      return textResponse("Browser session closed");
    }

    if (action === "clear_cookies") {
      await ctx.clearCookies();

      return textResponse("Cookies cleared");
    }

    if (action === "clear_permissions") {
      await ctx.clearPermissions();

      return textResponse("Permissions cleared");
    }

    return jsonResponse({
      browserRunning: Boolean(browser),
      contextRunning: Boolean(context),
      activePageId,
      tabs: pages.size,
      profilePath,
    });
  }
);

/* =========================================================
   23. PROFILE
========================================================= */

server.registerTool(
  "browser_profile",
  {
    description:
      "Create or inspect a persistent browser profile.",
    inputSchema: {
      action: z.enum(["info", "set"]),
      path: z.string().optional(),
    },
  },
  async ({ action, path: requestedPath }) => {
    if (action === "info") {
      return jsonResponse({
        profilePath,
        persistent: Boolean(profilePath),
      });
    }

    if (!requestedPath) {
      throw new Error("path is required when action=set");
    }

    if (browser) {
      throw new Error(
        "Close the current browser session before changing profile."
      );
    }

    profilePath = path.resolve(requestedPath);

    await fs.mkdir(profilePath, {
      recursive: true,
    });

    context = await chromium.launchPersistentContext(
      profilePath,
      {
        headless: false,
        slowMo: 300,
        acceptDownloads: true,
      }
    );

    browser = null;

    for (const page of context.pages()) {
      const id = makePageId();

      pages.set(id, page);
      activePageId = id;

      attachPageListeners(id, page);
    }

    return jsonResponse({
      profilePath,
      tabs: pages.size,
    });
  }
);

/* =========================================================
   24. REMOTE BROWSER
========================================================= */

server.registerTool(
  "browser_remote",
  {
    description:
      "Connect to an existing remote Chromium browser using CDP.",
    inputSchema: {
      action: z.enum(["connect", "disconnect"]),
      endpoint: z.string().url().optional(),
    },
  },
  async ({ action, endpoint }) => {
    if (action === "disconnect") {
      if (browser) {
        await browser.close().catch(() => {});
      }

      browser = null;
      context = null;
      pages.clear();
      activePageId = null;

      return textResponse("Disconnected from remote browser");
    }

    if (!endpoint) {
      throw new Error(
        "endpoint is required when action=connect"
      );
    }

    if (browser) {
      await browser.close().catch(() => {});
    }

    browser = await chromium.connectOverCDP(endpoint);

    const contexts = browser.contexts();

    if (contexts.length === 0) {
      throw new Error("Remote browser has no contexts");
    }

    context = contexts[0];

    pages.clear();

    for (const page of context.pages()) {
      const id = makePageId();

      pages.set(id, page);
      attachPageListeners(id, page);

      if (!activePageId) {
        activePageId = id;
      }
    }

    return jsonResponse({
      connected: true,
      endpoint,
      tabs: pages.size,
      activePageId,
    });
  }
);

/* =========================================================
   25. BROWSER TASK
========================================================= */

const taskActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("navigate"),
    url: z.string().url(),
  }),

  z.object({
    action: z.literal("click"),
    selector: z.string(),
  }),

  z.object({
    action: z.literal("type"),
    selector: z.string(),
    text: z.string(),
  }),

  z.object({
    action: z.literal("fill"),
    selector: z.string(),
    text: z.string(),
  }),

  z.object({
    action: z.literal("hover"),
    selector: z.string(),
  }),

  z.object({
    action: z.literal("wait"),
    milliseconds: z.number().int().nonnegative(),
  }),

  z.object({
    action: z.literal("wait_for_element"),
    selector: z.string(),
    state: z
      .enum(["attached", "detached", "visible", "hidden"])
      .default("visible"),
  }),

  z.object({
    action: z.literal("wait_for_text"),
    text: z.string(),
  }),

  z.object({
    action: z.literal("press"),
    key: z.string(),
  }),

  z.object({
    action: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    amount: z.number().int().positive().default(700),
  }),

  z.object({
    action: z.literal("back"),
  }),

  z.object({
    action: z.literal("forward"),
  }),

  z.object({
    action: z.literal("reload"),
  }),
]);

server.registerTool(
  "browser_task",
  {
    description:
      "Execute a sequence of browser actions as one high-level task.",
    inputSchema: {
      actions: z.array(taskActionSchema).min(1).max(100),
    },
  },
  async ({ actions }) => {
    const p = await getPage();

    const results: unknown[] = [];

    for (const action of actions) {
      switch (action.action) {
        case "navigate":
          await p.goto(action.url, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });

          results.push({
            action: "navigate",
            url: p.url(),
          });
          break;

        case "click":
          await p.locator(action.selector).click();

          results.push({
            action: "click",
            selector: action.selector,
          });
          break;

        case "type":
        case "fill":
          await p.locator(action.selector).fill(action.text);

          results.push({
            action: action.action,
            selector: action.selector,
          });
          break;

        case "hover":
          await p.locator(action.selector).hover();

          results.push({
            action: "hover",
            selector: action.selector,
          });
          break;

        case "wait":
          await new Promise((resolve) =>
            setTimeout(resolve, action.milliseconds)
          );

          results.push({
            action: "wait",
            milliseconds: action.milliseconds,
          });
          break;

        case "wait_for_element":
          await p.locator(action.selector).waitFor({
            state: action.state,
            timeout: 30000,
          });

          results.push({
            action: "wait_for_element",
            selector: action.selector,
          });
          break;

        case "wait_for_text":
          await p.getByText(action.text, {
            exact: false,
          }).first().waitFor({
            state: "visible",
            timeout: 30000,
          });

          results.push({
            action: "wait_for_text",
            text: action.text,
          });
          break;

        case "press":
          await p.keyboard.press(action.key);

          results.push({
            action: "press",
            key: action.key,
          });
          break;

        case "scroll":
          await p.evaluate((amount) => {
            window.scrollBy({
              top: amount,
              behavior: "smooth",
            });
          }, action.direction === "down" ? action.amount : -action.amount);

          results.push({
            action: "scroll",
            direction: action.direction,
          });
          break;

        case "back":
          await p.goBack({
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });

          results.push({
            action: "back",
            url: p.url(),
          });
          break;

        case "forward":
          await p.goForward({
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });

          results.push({
            action: "forward",
            url: p.url(),
          });
          break;

        case "reload":
          await p.reload({
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });

          results.push({
            action: "reload",
            url: p.url(),
          });
          break;
      }
    }

    return jsonResponse({
      success: true,
      results,
      final: {
        url: p.url(),
        title: await p.title(),
      },
    });
  }
);

/* =========================================================
   HTTP SERVER
========================================================= */

const httpServer = createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      res.writeHead(200, {
        "content-type": "application/json",
      });

      res.end(
        JSON.stringify({
          status: "ok",
          service: "web-agent-mcp",
          version: "0.2.0",
        })
      );

      return;
    }

    if (req.url === "/mcp") {
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);

      await transport.handleRequest(req, res);

      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  } catch (error) {
    console.error(error);

    if (!res.headersSent) {
      res.writeHead(500, {
        "content-type": "application/json",
      });
    }

    res.end(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : String(error),
      })
    );
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Web Agent MCP running on port ${PORT}`
  );

  console.log(
    `MCP endpoint: http://localhost:${PORT}/mcp`
  );
});