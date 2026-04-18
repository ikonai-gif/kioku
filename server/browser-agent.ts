/**
 * Level 4 — Browser Agent: Puppeteer in E2B Sandbox
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
 * Browse a website using Puppeteer + bundled Chromium inside the E2B sandbox.
 * Installs system deps and Puppeteer on first use (cached in persistent sandbox).
 */
async function safeRun(sandbox: any, cmd: string, opts: { timeoutMs: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const r = await sandbox.commands.run(cmd, opts);
    return { stdout: r.stdout || "", stderr: r.stderr || "", exitCode: r.exitCode ?? 0 };
  } catch (e: any) {
    // E2B throws CommandExitError on non-zero exit — extract result from it
    if (e?.result) return { stdout: e.result.stdout || "", stderr: e.result.stderr || "", exitCode: e.result.exitCode ?? 1 };
    return { stdout: "", stderr: e?.message || String(e), exitCode: 1 };
  }
}

export async function browseWebsite(
  task: BrowseTask,
  sandbox: any
): Promise<BrowseResult> {
  const timeout = task.timeout || 15000;

  // Step 1: Ensure Puppeteer is installed (it bundles its own Chromium)
  const checkResult = await safeRun(sandbox,
    `node -e "try{require('puppeteer');console.log('OK')}catch(e){console.log('MISSING')}"`,
    { timeoutMs: 10_000 }
  );

  if (checkResult.stdout?.trim() !== "OK") {
    // Install system dependencies required by Chromium (E2B runs as non-root, needs sudo)
    await safeRun(sandbox,
      "sudo apt-get update -qq && sudo apt-get install -y -qq libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 2>/dev/null || true",
      { timeoutMs: 120_000 }
    );

    // Install Puppeteer in /home/user (downloads bundled Chromium automatically)
    await safeRun(sandbox,
      "cd /home/user && npm install puppeteer 2>/dev/null",
      { timeoutMs: 120_000 }
    );

    // Verify installation
    const verify = await safeRun(sandbox,
      `node -e "try{require('puppeteer');console.log('OK')}catch(e){console.log('MISSING')}"`,
      { timeoutMs: 10_000 }
    );
    if (verify.stdout?.trim() !== "OK") {
      return { success: false, error: "Failed to install Puppeteer in sandbox" };
    }
  }

  // Step 2: Generate and write Puppeteer script (in /home/user where node_modules lives)
  const script = generatePuppeteerScript(task, timeout);
  await sandbox.files.write("/home/user/browse_task.js", script);

  // Step 3: Execute the script
  const result = await safeRun(sandbox,
    "node /home/user/browse_task.js",
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

function generatePuppeteerScript(task: BrowseTask, timeout: number): string {
  const url = JSON.stringify(task.url);
  const action = task.action || "extract_text";
  const selector = task.selector ? JSON.stringify(task.selector) : "null";
  const waitFor = task.waitFor ? JSON.stringify(task.waitFor) : "null";
  const instructions = task.instructions ? JSON.stringify(task.instructions) : "null";

  // Use CJS require syntax for maximum E2B compatibility
  return `
const puppeteer = require('puppeteer');

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    await page.goto(${url}, {
      waitUntil: 'networkidle2',
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
          text = await page.$eval(selector, el => el.innerText);
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
