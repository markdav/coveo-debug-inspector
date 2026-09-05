import { useSession } from './state/store';
import { Dropzone } from './components/Dropzone';
import { InspectorView } from './components/InspectorView';

export function App() {
  const { session, reset } = useSession();

  return (
    <>
      <header className="app-header">
        <img className="app-logo" src={`${import.meta.env.BASE_URL}favicon.svg`} width={24} height={24} alt="" />
        <h1>Debug Inspector for Coveo</h1>
        <span className="sub">offline · read-only · no replay</span>
        {session && (
          <button className="ghost" style={{ marginLeft: 'auto' }} onClick={reset}>
            Load another
          </button>
        )}
        {!session && <span className="privacy">🔒 nothing leaves your browser</span>}
      </header>

      {!session ? (
        <Dropzone />
      ) : (
        <InspectorView />
      )}
    </>
  );
}
