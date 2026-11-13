import { ApiStatus } from './status';

export default function Home() {
  return (
    <main>
      <p className="eyebrow">Practice management / Development preview</p>
      <h1>A clearer chamber day.</h1>
      <p className="intro">The foundation for booking patients and keeping their queue in order.</p>
      <section aria-labelledby="preview-heading">
        <h2 id="preview-heading">Workspace preview</h2>
        <p>Account setup, session booking and queue controls will arrive in the next implementation segments. This preview does not accept patient information.</p>
        <ApiStatus />
      </section>
      <footer>Development environment · No patient records</footer>
    </main>
  );
}
