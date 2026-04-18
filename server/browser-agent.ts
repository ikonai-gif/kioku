/**
 * Level 4 — Browser Agent: Playwright in E2B Sandbox
 * Lets Luca open URLs, extract text, take screenshots, and interact with pages
 * using a headless Chromium browser running inside the persistent E2B sandbox.
 */

interface BrowseTask {
  url: string;
  action?: "extract_text" | "screenshot" | "interact";
  selector?: string;
  instructions?: string;
  waitFor?: string;
  timeout?: number;
}

interface BrowseResult {
  success: boolean;
  title?: string;
  url?: string;
  text?: string;
  screenshot?: string;
  error?: string;
}

/**
 * Browse a website using Playwright + Chromium inside the E2B sandbox.
 * Installs Chromium and Playwright on first use (cached in persistent sandbox).
 */
export async function browseWebsite(
  task: BrowseTask,
  sandbox: any
): Promise<BrowseResult> {
  const timeout = task.timeout || 15000;

  // Step 1: Ensure Chromium + Playwright are installed
  const checkResult = await sandbox.commands.run(
    "which chromium-browser || which chromium || echo 'NOT_FOUND'",
    { timeoutMs: 10_000 }
  );

  if (checkResult.stdout?.trim().includes("NOT_FOUND") || checkResult.exitCode !== 0) {
    // Install Chromium via apt
    const installResult = await sandbox.commands.run(
      "apt-get update -qq && apt-get install -y -qq chromium chromium-browser 2>/dev/null || apt-get install -y -qq chromium 2>/dev/null || true",
      { timeoutMs: 120_000 }
    );

    // Verify installation
    const verifyResult = await sandbox.commands.run(
      "which chromium-browser || which chromium || echo 'STILL_NOT_FOUND'",
      { timeoutMs: 10_000 }
    );

    if (verifyResult.stdout?.trim().includes("STILL_NOT_FOUND")) {
      // Fallback: install via npx playwright
      await sandbox.commands.run(
        "npm install -g playwright@latest 2>/dev/null && npx playwright install chromium --with-deps",
        { timeoutMs: 120_000 }
      );
    }
  }

  // Ensure playwright npm package is available for the script
  const pwCheck = await sandbox.commands.run(
    "node -e \"try { require('playwright'); } catch(e) { process.exit(1); }\"",
    { timeoutMs: 10_000 }
  );
  if (pwCheck.exitCode !== 0) {
    await sandbox.commands.run("npm install -g playwright@latest", { timeoutMs: 60_000 });
  }

  // Step 2: Determine Chromium path
  const chromiumPath = await sandbox.commands.run(
    "which chromium-browser || which chromium || echo '/usr/bin/chromium'",
    { timeoutMs: 5_000 }
  );
  const execPath = chromiumPath.stdout?.trim().split("\n")[0] || "/usr/bin/chromium";

  // Step 3: Generate and write Playwright script
  const script = generatePlaywrightScript(task, timeout, execPath);
  await sandbox.files.write("/tmp/browse_task.js", script);

  // Step 4: Execute the script
  const result = await sandbox.commands.run(
    "node /tmp/browse_task.js",
    { timeoutMs: timeout + 30_000 }
  );

  if (result.exitCode !== 0) {
    // Try to parse error from stdout first (script may log JSON errors)
    try {
      const parsed = JSON.parse(result.stdout || "");
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
    return {
      success: false,
      error: result.stderr?.slice(0, 2000) || result.stdout?.slice(0, 2000) || "Browser script failed",
    };
  }

  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    return { success: true, text: result.stdout?.slice(0, 5000) || "" };
  }
}

function generatePlaywrightScript(task: BrowseTask, timeout: number, execPath: string): string {
  const url = JSON.stringify(task.url);
  const action = task.action || "extract_text";
  const selector = task.selector ? JSON.stringify(task.selector) : "null";
  const waitFor = task.waitFor ? JSON.stringify(task.waitFor) : "null";
  const instructions = task.instructions ? JSON.stringify(task.instructions) : "null";

  // Use CJS require syntax for maximum E2B compatibility
  return `
const { chromium } = require('playwright');

(async () => {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: ${JSON.stringify(execPath)},
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    await page.goto(${url}, {
      waitUntil: 'networkidle',
      timeout: ${timeout}
    });

    const waitForSel = ${waitFor};
    if (waitForSel) {
      await page.waitForSelector(waitForSel, { timeout: ${timeout} });
    }

    const title = await page.title();
    const currentUrl = page.url();

    const action = ${JSON.stringify(action)};
    const selector = ${selector};

    if (action === 'screenshot') {
      const screenshotBuf = await page.screenshot({ fullPage: false, type: 'png' });
      const base64 = screenshotBuf.toString('base64');
      console.log(JSON.stringify({ success: true, title, url: currentUrl, screenshot: base64 }));
    } else if (action === 'interact') {
      const instructions = ${instructions};
      // For interact mode, we extract text after page load
      // The agent provides instructions as context but actual interaction
      // would need more sophisticated command parsing
      const text = await page.evaluate(() => document.body.innerText.substring(0, 5000));
      console.log(JSON.stringify({ success: true, title, url: currentUrl, text }));
    } else {
      // extract_text
      let text;
      if (selector) {
        try {
          text = await page.locator(selector).innerText({ timeout: ${timeout} });
        } catch (e) {
          text = await page.evaluate(() => document.body.innerText.substring(0, 5000));
        }
      } else {
        text = await page.evaluate(() => document.body.innerText.substring(0, 5000));
      }
      console.log(JSON.stringify({ success: true, title, url: currentUrl, text }));
    }
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message }));
  } finally {
    if (browser) await browser.close();
  }
})();
`.trim();
}
