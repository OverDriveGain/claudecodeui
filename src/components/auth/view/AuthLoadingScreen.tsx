import Loader from '@/components/ui/Loader';

export default function AuthLoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="flex flex-col items-center text-center">
        <Loader variant="orbit" size="xl" />
        <h1 className="mt-2 text-2xl font-bold text-foreground">MyMu</h1>
        <p className="mt-1 text-muted-foreground">Loading…</p>
      </div>
    </div>
  );
}
