import { CHANNELS } from '@workeasy/shared';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-6 px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Workeasy Campaign</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Customer engagement and marketing automation. Sign-in and the workspace arrive in build step 4.
      </p>
      <ul className="flex flex-wrap gap-2">
        {CHANNELS.map((c) => (
          <li
            key={c}
            className="rounded-full border border-zinc-200 px-3 py-1 text-sm capitalize dark:border-zinc-800"
          >
            {c}
          </li>
        ))}
      </ul>
    </main>
  );
}
