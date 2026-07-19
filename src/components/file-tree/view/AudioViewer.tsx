import { X } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import { AUTH_TOKEN_STORAGE_KEY } from '../../auth/constants';
import type { FileTreeAudioSelection } from '../types/types';

type AudioViewerProps = {
  file: FileTreeAudioSelection;
  onClose: () => void;
};

export default function AudioViewer({ file, onClose }: AudioViewerProps) {
  // Point <audio> straight at the content endpoint so the browser issues its own
  // HTTP Range requests (native streaming + seeking). The auth token rides as a
  // query param because an <audio> element can't set headers — the server's
  // authenticateToken middleware already accepts ?token=. Same as VideoViewer.
  const token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  const params = new URLSearchParams({ path: file.path });
  if (token) {
    params.set('token', token);
  }
  const audioUrl = `/api/projects/${file.projectId}/files/content?${params.toString()}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="mx-4 w-full max-w-lg overflow-hidden rounded-lg bg-white shadow-xl dark:bg-gray-800">
        <div className="flex items-center justify-between border-b p-4">
          <h3 className="truncate text-lg font-semibold text-gray-900 dark:text-white">{file.name}</h3>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex min-h-[120px] items-center justify-center bg-gray-50 p-6 dark:bg-gray-900">
          <audio src={audioUrl} controls autoPlay className="w-full">
            Your browser does not support the audio element.
          </audio>
        </div>

        <div className="border-t bg-gray-50 p-4 dark:bg-gray-800">
          <p className="truncate text-sm text-gray-600 dark:text-gray-400">{file.path}</p>
        </div>
      </div>
    </div>
  );
}
