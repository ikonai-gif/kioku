import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center h-full p-6 text-center">
      <div className="text-4xl font-bold text-muted-foreground/30 mb-2">404</div>
      <p className="text-sm text-muted-foreground mb-4">Page not found</p>
      <Link href="/">
        <a className="text-xs text-primary hover:text-primary/80">← Back to Dashboard</a>
      </Link>
    </div>
  );
}
