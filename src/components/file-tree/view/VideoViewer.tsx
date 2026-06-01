import { X } from 'lucide-react';
import { Button } from '../../../shared/view/ui';
import type { FileTreeVideoSelection } from '../types/types';

type VideoViewerProps = {
  file: FileTreeVideoSelection;
  onClose: () => void;
};

export default function VideoViewer({ file, onClose }: VideoViewerProps) {
  // Point <video> straight at the content endpoint so the browser issues its
  // own HTTP Range requests (native streaming + scrubbing). The auth token is
  // passed as a query param because a <video> element can't set headers — the
  // server's authenticateToken middleware already accepts ?token= for this.
  const token = localStorage.getItem('auth-token');
  const params = new URLSearchParams({ path: file.path });
  if (token) {
    params.set('token', token);
  }
  const videoUrl = `/api/projects/${file.projectId}/files/content?${params.toString()}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="mx-4 max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-lg bg-white shadow-xl dark:bg-gray-800">
        <div className="flex items-center justify-between border-b p-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{file.name}</h3>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex min-h-[400px] items-center justify-center bg-black p-4">
          <video
            src={videoUrl}
            controls
            autoPlay
            className="max-h-[70vh] max-w-full rounded-lg shadow-md"
          >
            Your browser does not support the video tag.
          </video>
        </div>

        <div className="border-t bg-gray-50 p-4 dark:bg-gray-800">
          <p className="text-sm text-gray-600 dark:text-gray-400">{file.path}</p>
        </div>
      </div>
    </div>
  );
}
