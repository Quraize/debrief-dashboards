import { useEffect, useRef } from "react";
import { MapContainer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "@maplibre/maplibre-gl-leaflet";
import { jobTypeColor } from "@allied/shared/production";

// OpenFreeMap: free, no API key, no usage limits, community-funded. "Liberty"
// is the Google-Maps-like style (cream land, white roads, amber highways).
// Vector tiles, so they render through MapLibre inside the Leaflet map.
const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const BASEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> '
  + 'Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
// If the vector service is unreachable, the board must still show a map.
const FALLBACK_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const FALLBACK_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const STYLE_LOAD_TIMEOUT_MS = 10_000;

function Basemap() {
  const map = useMap();
  useEffect(() => {
    let vector = null;
    let fallback = null;
    let timer = null;

    const useFallback = (why) => {
      if (fallback) return;
      console.warn(`[map] basemap fallback to OpenStreetMap raster tiles: ${why}`);
      if (vector) { map.removeLayer(vector); vector = null; }
      fallback = L.tileLayer(FALLBACK_TILES, { attribution: FALLBACK_ATTRIBUTION, maxZoom: 19 }).addTo(map);
    };

    try {
      vector = L.maplibreGL({ style: BASEMAP_STYLE, attribution: BASEMAP_ATTRIBUTION }).addTo(map);
      const gl = vector.getMaplibreMap();
      gl.once("load", () => { if (timer) clearTimeout(timer); });
      gl.on("error", (e) => {
        // Errors before the style has loaded mean the service itself failed;
        // later ones (a missing glyph, one tile) are cosmetic.
        if (!gl.isStyleLoaded()) useFallback(e?.error?.message ?? "style failed to load");
      });
      timer = setTimeout(() => { if (!gl.isStyleLoaded()) useFallback("style load timed out"); }, STYLE_LOAD_TIMEOUT_MS);
    } catch (err) {
      // No WebGL (very old browser, remote desktop without acceleration).
      useFallback(err?.message ?? "WebGL unavailable");
    }

    return () => {
      if (timer) clearTimeout(timer);
      if (vector) map.removeLayer(vector);
      if (fallback) map.removeLayer(fallback);
    };
  }, [map]);
  return null;
}

// North Jersey service area — where the map rests when a day has no pins.
const HOME_CENTER = [40.85, -74.2];
const HOME_ZOOM = 9;

/**
 * One pin per scheduled job. Colour = job type, shape = status: solid for an
 * assigned crew, hollow/dashed when nobody is assigned (the actionable case),
 * grey when the work is done. The number matches the card in the list.
 */
export function pinIcon({ color, status, label, selected }) {
  const completed = status === "completed";
  const solid = status === "assigned";
  const bg = completed ? "#9ca3af" : solid ? color : "#ffffff";
  const fg = completed || solid ? "#ffffff" : color;
  const border = completed ? "#6b7280" : color;
  const size = selected ? 34 : 28;
  const dash = status === "unassigned" ? "border-style:dashed;" : "";
  const glow = selected ? "0 0 0 4px rgba(37,99,235,.35)," : "";
  return L.divIcon({
    className: "allied-pin",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);`
      + `background:${bg};border:3px solid ${border};${dash}box-shadow:${glow}0 2px 6px rgba(0,0,0,.35);`
      + `display:flex;align-items:center;justify-content:center">`
      + `<span style="transform:rotate(45deg);font:700 ${selected ? 12 : 11}px/1 system-ui,sans-serif;color:${fg}">${label}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -size + 4],
  });
}

function FitToItems({ items }) {
  const map = useMap();
  const key = items.map((i) => i.id).join("|");
  useEffect(() => {
    if (items.length === 0) {
      map.setView(HOME_CENTER, HOME_ZOOM);
      return;
    }
    const bounds = L.latLngBounds(items.map((i) => [i.location.lat, i.location.lng]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

function FocusSelected({ items, selectedId, markerRefs }) {
  const map = useMap();
  useEffect(() => {
    if (!selectedId) return;
    const item = items.find((i) => i.id === selectedId);
    if (!item) return;
    map.flyTo([item.location.lat, item.location.lng], Math.max(map.getZoom(), 13), { duration: 0.6 });
    const marker = markerRefs.current[selectedId];
    if (marker) setTimeout(() => marker.openPopup(), 650);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  return null;
}

/**
 * @param {{ items: any[], selectedId: string|null, onSelect: (id: string) => void }} props
 *   `items` must already be filtered to those with coordinates.
 */
export default function ScheduleMap({ items, selectedId, onSelect }) {
  const markerRefs = useRef({});

  return (
    <MapContainer center={HOME_CENTER} zoom={HOME_ZOOM} scrollWheelZoom className="h-full w-full rounded-xl z-0">
      <Basemap />
      <FitToItems items={items} />
      <FocusSelected items={items} selectedId={selectedId} markerRefs={markerRefs} />
      {items.map((item) => (
        <Marker
          key={item.id}
          position={[item.location.lat, item.location.lng]}
          icon={pinIcon({
            color: jobTypeColor(item.parsed.code), status: item.status,
            label: item.index, selected: item.id === selectedId,
          })}
          zIndexOffset={item.id === selectedId ? 1000 : 0}
          ref={(ref) => { if (ref) markerRefs.current[item.id] = ref; }}
          eventHandlers={{ click: () => onSelect(item.id) }}
        >
          <Popup>
            <div className="text-xs space-y-0.5 min-w-[180px]">
              <div className="font-bold text-sm">{item.customerName || item.parsed.customer || item.title}</div>
              <div className="text-muted-foreground">{item.parsed.label}{item.jobNumber ? ` · ${item.jobNumber}` : ""}</div>
              <div>{[item.location.address, item.location.city].filter(Boolean).join(", ")}</div>
              <div>{item.fullDay ? "All day" : `${item.startTime12} – ${item.endTime12}`}</div>
              <div>{item.crews.length ? item.crews.map((c) => c.name).join(", ") : "No crew assigned"}</div>
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
