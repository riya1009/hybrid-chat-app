export default function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="flex min-h-screen">
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-gradient-to-br from-accent-600 via-accent-700 to-slate-900 p-12 text-white lg:flex">
        <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 text-white">R</span>
          Relay
        </div>
        <div>
          <h1 className="text-4xl font-semibold leading-tight">
            Fast when it can be.
            <br />
            Reliable when it must be.
          </h1>
          <p className="mt-4 max-w-sm text-white/70">
            Relay tries a direct connection between you and the other person first — and quietly
            falls back to always-on delivery when it can&apos;t, so nothing is ever lost.
          </p>
        </div>
        <p className="text-xs text-white/50">Built as an MTech systems project — hybrid P2P + server chat.</p>
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-10 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
      </div>

      <div className="flex w-full flex-col justify-center px-6 py-12 sm:px-12 lg:w-1/2">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 text-lg font-semibold lg:hidden">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-600 text-white">R</span>
            Relay
          </div>
          <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">{title}</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
          <div className="mt-8">{children}</div>
        </div>
      </div>
    </div>
  )
}
