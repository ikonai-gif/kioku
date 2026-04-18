import { ArrowLeft, Cookie } from "lucide-react";

export default function CookiesPage() {
  return (
    <div className="min-h-screen bg-background text-foreground px-4 py-10 max-w-3xl mx-auto">
      <div className="mb-8">
        <a href="#/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6">
          <ArrowLeft className="w-4 h-4" /> Back
        </a>
        <div className="flex items-center gap-3 mb-2">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Cookie className="w-4 h-4 text-primary" />
          </div>
          <h1 className="text-xl font-bold text-foreground">Cookie Policy</h1>
        </div>
        <p className="text-xs text-muted-foreground">
          KIOKU™ by IKONBAI™, Inc. &nbsp;·&nbsp; Last Updated: April 18, 2026 &nbsp;·&nbsp; Patent Pending
        </p>
      </div>

      {/* Table of Contents */}
      <nav className="mb-10 p-4 rounded-xl border border-border bg-muted/30">
        <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider mb-3">Table of Contents</h2>
        <ol className="list-decimal list-inside space-y-1.5 text-xs text-muted-foreground">
          <li><a href="#cp-what" className="hover:text-primary underline-offset-2 hover:underline">What Are Cookies</a></li>
          <li><a href="#cp-we-use" className="hover:text-primary underline-offset-2 hover:underline">Cookies We Use</a></li>
          <li><a href="#cp-third-party" className="hover:text-primary underline-offset-2 hover:underline">Third-Party Cookies</a></li>
          <li><a href="#cp-control" className="hover:text-primary underline-offset-2 hover:underline">How to Control Cookies</a></li>
          <li><a href="#cp-changes" className="hover:text-primary underline-offset-2 hover:underline">Changes to This Policy</a></li>
          <li><a href="#cp-contact" className="hover:text-primary underline-offset-2 hover:underline">Contact</a></li>
        </ol>
      </nav>

      <div className="prose prose-sm prose-invert max-w-none space-y-8 text-sm text-muted-foreground leading-relaxed">

        {/* 1. What Are Cookies */}
        <section id="cp-what">
          <h2 className="text-base font-semibold text-foreground mb-3">1. What Are Cookies</h2>
          <p>
            Cookies are small text files stored on your device by your web browser when you visit a website.
            They are widely used to make websites work efficiently, provide functionality, and give site operators information about how the site is being used.
          </p>
          <p className="mt-2">
            KIOKU™ uses <strong className="text-foreground">only essential cookies</strong> that are strictly necessary for the platform to function.
            We do not use any cookies for tracking, analytics, advertising, or profiling purposes.
          </p>
        </section>

        {/* 2. Cookies We Use */}
        <section id="cp-we-use">
          <h2 className="text-base font-semibold text-foreground mb-3">2. Cookies We Use</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs border border-border rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">Cookie Name</th>
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">Type</th>
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">Purpose</th>
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">Duration</th>
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">Essential?</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border/50">
                  <td className="p-2.5 text-foreground font-medium">kioku_session</td>
                  <td className="p-2.5">httpOnly, Secure, SameSite=Lax</td>
                  <td className="p-2.5">Authentication session — keeps you logged in</td>
                  <td className="p-2.5">Session (browser close)</td>
                  <td className="p-2.5 text-foreground font-medium">Yes</td>
                </tr>
                <tr>
                  <td className="p-2.5 text-foreground font-medium">kioku_consent</td>
                  <td className="p-2.5">Non-httpOnly, Secure, SameSite=Lax</td>
                  <td className="p-2.5">Remembers your cookie consent choice</td>
                  <td className="p-2.5">365 days</td>
                  <td className="p-2.5 text-foreground font-medium">Yes</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3">
            Both cookies listed above are <strong className="text-foreground">strictly essential</strong> for the operation of KIOKU™.
            They do not collect personal information for marketing or profiling purposes.
          </p>
        </section>

        {/* 3. Third-Party Cookies */}
        <section id="cp-third-party">
          <h2 className="text-base font-semibold text-foreground mb-3">3. Third-Party Cookies</h2>
          <p className="p-3 rounded-lg border border-primary/20 bg-primary/5 text-foreground font-medium">
            We do NOT use any third-party cookies. No analytics. No advertising. No tracking.
          </p>
          <p className="mt-3">
            KIOKU™ does not embed any third-party tracking scripts, advertising pixels, social media widgets,
            or analytics tools that would place cookies on your device. Your browsing activity on KIOKU™ is not
            shared with any advertising networks or data brokers.
          </p>
        </section>

        {/* 4. How to Control Cookies */}
        <section id="cp-control">
          <h2 className="text-base font-semibold text-foreground mb-3">4. How to Control Cookies</h2>
          <p>
            You can control and manage cookies through your browser settings. Most browsers allow you to:
          </p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li>View what cookies are stored on your device and delete them individually.</li>
            <li>Block third-party cookies (though KIOKU™ does not use any).</li>
            <li>Block all cookies from specific sites.</li>
            <li>Block all cookies from being set.</li>
            <li>Delete all cookies when you close your browser.</li>
          </ul>
          <p className="mt-3">
            <strong className="text-foreground">Please note:</strong> If you block or delete the <code className="text-xs bg-muted px-1.5 py-0.5 rounded text-foreground">kioku_session</code> cookie,
            you will be logged out and will need to sign in again. If you delete the <code className="text-xs bg-muted px-1.5 py-0.5 rounded text-foreground">kioku_consent</code> cookie,
            the cookie consent banner will reappear on your next visit.
          </p>
          <p className="mt-2">
            For instructions on managing cookies in your specific browser, visit your browser&apos;s help documentation.
          </p>
        </section>

        {/* 5. Changes to This Policy */}
        <section id="cp-changes">
          <h2 className="text-base font-semibold text-foreground mb-3">5. Changes to This Policy</h2>
          <p>
            We may update this Cookie Policy from time to time to reflect changes in our practices or for operational,
            legal, or regulatory reasons. We will notify registered users of material changes via email.
          </p>
        </section>

        {/* 6. Contact */}
        <section id="cp-contact">
          <h2 className="text-base font-semibold text-foreground mb-3">6. Contact</h2>
          <p>
            For questions about our cookie practices:<br />
            Privacy inquiries: <a href="mailto:privacy@ikonbai.com" className="text-primary underline">privacy@ikonbai.com</a><br />
            Legal inquiries: <a href="mailto:legal@ikonbai.com" className="text-primary underline">legal@ikonbai.com</a><br />
            IKONBAI™, Inc. · Delaware, United States
          </p>
        </section>

      </div>

      <div className="mt-10 pt-6 border-t border-border flex flex-wrap gap-4 items-center justify-between text-xs text-muted-foreground/50">
        <span>&copy; {new Date().getFullYear()} IKONBAI™, Inc. · Patent Pending · All rights reserved.</span>
        <div className="flex gap-4">
          <a href="#/privacy" className="hover:text-foreground underline">Privacy Policy</a>
          <a href="#/terms" className="hover:text-foreground underline">Terms of Service</a>
          <a href="#/" className="hover:text-foreground underline">Back to App</a>
        </div>
      </div>
    </div>
  );
}
