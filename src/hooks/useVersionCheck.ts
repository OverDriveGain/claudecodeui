import { version } from '../../package.json';
import { ReleaseInfo } from '../types/sharedTypes';

/**
 * Compare two semantic version strings
 * Works only with numeric versions separated by dots (e.g. "1.2.3")
 * @param {string} v1 
 * @param {string} v2
 * @returns positive if v1 > v2, negative if v1 < v2, 0 if equal
 */
const compareVersions = (v1: string, v2: string) => {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 !== p2) return p1 - p2;
  }
  return 0;
};

export type InstallMode = 'git' | 'npm';

// This product ships its own release line and does NOT track the upstream
// claudecodeui repo. The external GitHub version check + "update available"
// banner were removed: the hook now only reports our own current version
// (from package.json) and never makes a network call. `compareVersions` is
// kept for callers/tests that still import it. The owner/repo args are
// accepted for backward compatibility but ignored.
export const useVersionCheck = (_owner?: string, _repo?: string) => {
  void compareVersions; // retained for API compatibility; no upstream comparison
  return {
    updateAvailable: false,
    latestVersion: null as string | null,
    currentVersion: version,
    releaseInfo: null as ReleaseInfo | null,
    installMode: 'git' as InstallMode,
  };
}; 