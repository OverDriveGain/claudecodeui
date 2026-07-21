import { useEffect, useRef, useState } from 'react';
import type { SourceValue, LocationData } from '../types';
import PaneFrame from './PaneFrame';

/* Cesium is loaded from its CDN (index.html) and read off window.Cesium — NOT
 * bundled (bundling Cesium fights Vite's optimizer). Loose `any` is intentional. */
/* eslint-disable @typescript-eslint/no-explicit-any */

interface LocationPaneProps {
  title: string;
  code?: string;
  source?: SourceValue;
}

function asLocation(source?: SourceValue): LocationData | null {
  const data = source?.data as LocationData | undefined;
  if (!data || typeof data.lat !== 'number' || typeof data.lng !== 'number') return null;
  return data;
}

/**
 * Location pane — the building placed in the "All Dubai" 3D world (Cesium ion:
 * World Terrain + OSM Buildings + the bldr building as a red box). Falls back to
 * a coordinate card if Cesium or the ion token isn't available.
 */
export default function LocationPane({ title, code, source }: LocationPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const [err, setErr] = useState<string | null>(null);
  // window.Cesium is loaded from a CDN <script> and is NOT reactive: if it hasn't
  // finished loading when this pane first renders (slow network), canRender stays
  // false and nothing re-renders it. Poll until it appears, then force a render.
  const [cesiumTick, setCesiumTick] = useState(0);
  const loc = asLocation(source);

  const Cesium = (typeof window !== 'undefined' ? (window as any).Cesium : undefined);
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;
  const canRender = Boolean(loc && Cesium && token);

  useEffect(() => {
    if (Cesium || typeof window === 'undefined') return;
    const id = window.setInterval(() => {
      if ((window as any).Cesium) {
        window.clearInterval(id);
        setCesiumTick((t) => t + 1); // re-render now that Cesium is available
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [Cesium, cesiumTick]);

  useEffect(() => {
    if (!canRender || !containerRef.current || !loc) return;
    let viewer: any = null;
    let ro: ResizeObserver | null = null;
    let raf = 0;
    setErr(null);
    try {
      Cesium.Ion.defaultAccessToken = token;
      // BASE MAP = token-free Esri World Imagery (satellite). We deliberately do NOT
      // use Cesium ion's default Bing imagery (or ion terrain) as a HARD dependency:
      // ion assets get blocked by privacy/ad filters or dropped on slow networks,
      // which left the pane blank ("…CesiumWorldTerrain/…/layer.json" RuntimeError).
      // Esri's public tiles need no token and no ion, so the map always shows.
      viewer = new Cesium.Viewer(containerRef.current, {
        baseLayer: new Cesium.ImageryLayer(
          new Cesium.UrlTemplateImageryProvider({
            url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            maximumLevel: 19,
            credit: 'Imagery © Esri, Maxar, Earthstar Geographics',
          }),
        ),
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        selectionIndicator: false,
        infoBox: false,
      });
      viewer.scene.globe.depthTestAgainstTerrain = true;
      viewerRef.current = viewer;

      // ion world terrain (real elevation) is best-effort: load it AFTER the viewer
      // exists and swap it in only if it resolves. A failure keeps the smooth
      // ellipsoid — the satellite map still renders instead of going blank.
      Cesium.createWorldTerrainAsync()
        .then((tp: any) => viewer && !viewer.isDestroyed?.() && (viewer.terrainProvider = tp))
        .catch((e: any) => console.warn('[location] world terrain unavailable; using ellipsoid', e));

      // A Cesium viewer created while its pane has no/zero size (hidden tab,
      // pre-layout) renders a blank globe and never recovers on its own. Force a
      // resize once layout settles and on every container size change.
      const sizeFix = () => {
        try {
          viewer && !viewer.isDestroyed?.() && viewer.resize();
          viewer && !viewer.isDestroyed?.() && viewer.scene.requestRender();
        } catch { /* viewer torn down mid-frame */ }
      };
      raf = requestAnimationFrame(sizeFix);
      if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
        ro = new ResizeObserver(sizeFix);
        ro.observe(containerRef.current);
      }

      // Stream every Dubai building (optional — terrain still renders without).
      Cesium.createOsmBuildingsAsync()
        .then((osm: any) => viewer && !viewer.isDestroyed?.() && viewer.scene.primitives.add(osm))
        .catch((e: any) => console.warn('[location] OSM 3D buildings unavailable (ion asset):', e));

      // Drop the bldr building (red box) on the plot.
      const side = 30;
      const depth = 20;
      const height = 45;
      viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(loc.lng, loc.lat, height / 2),
        box: {
          dimensions: new Cesium.Cartesian3(side, depth, height),
          material: Cesium.Color.fromCssColorString('#D52027').withAlpha(0.96),
          outline: true,
          outlineColor: Cesium.Color.WHITE,
        },
      });

      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(loc.lng, loc.lat - 0.004, 1200),
        orientation: {
          heading: Cesium.Math.toRadians(20),
          pitch: Cesium.Math.toRadians(-30),
          roll: 0,
        },
        duration: 0,
      });
    } catch (e: any) {
      console.error('[location] Cesium init failed', e);
      setErr(e?.message ? String(e.message) : 'Cesium failed to initialise');
    }

    return () => {
      try {
        if (raf) cancelAnimationFrame(raf);
        if (ro) ro.disconnect();
        if (viewer && !viewer.isDestroyed?.()) viewer.destroy();
      } catch {
        /* ignore teardown races */
      }
      viewerRef.current = null;
    };
  }, [canRender, loc?.lat, loc?.lng, Cesium, token]);

  return (
    <PaneFrame title={title} code={code} flush empty={!loc}>
      <div ref={containerRef} className="absolute inset-0" />
      {loc && (!canRender || err) && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0f1b2d] p-3 text-center">
          <div>
            <div className="text-xs font-medium text-foreground">{loc.label || 'Placed location'}</div>
            <div className="text-[11px] text-muted-foreground">
              {loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground/60">
              {err
                ? `3D map error: ${err}`
                : !token
                  ? 'Cesium ion token not configured'
                  : !Cesium
                    ? 'Cesium library not loaded'
                    : '3D map loading…'}
            </div>
          </div>
        </div>
      )}
    </PaneFrame>
  );
}
