import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { get } from "@/api/http";
import { jobTypeColor } from "@allied/shared/production";

// North Jersey service area — where the map rests when a day has no pins.
const HOME_CENTER = [40.85, -74.2];
const HOME_ZOOM = 9;

// Where the background map comes from.
//
// The provider list is served by the backend (/api/map-config) so the MapTiler
// key lives in the env file next to every other credential and can be rotated
// without rebuilding the frontend. This list is only the offline default: it
// keeps the map working if that request fails, and it is what a developer sees
// with no key configured.
//
// Deliberately NOT tile.openstreetmap.org. That is the volunteer-run server
// for openstreetmap.org itself; its usage policy does not cover an application
// serving its own users, and in September 2026 it began answering 403 "App is
// not following the tile usage policy", which the map drew as a wall of
// blocked-tile images.
const DEFAULT_TILE_SOURCES = [
  {
    name: "esri",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri — Esri, DeLorme, NAVTEQ, USGS, Intermap",
    maxZoom: 19,
  },
];

// A blocked or missing tile draws this instead of the browser's broken-image
// icon — the difference between a faint gap and a screen full of "403".
const BLANK_TILE = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
// One tile failing is a gap; a screenful failing is a blocked provider.
const FAILURES_BEFORE_SWITCH = 6;

/**
 * The basemap, with failover. Providers block or disappear without warning,
 * and when that happens the pins and the job list still matter — so this walks
 * down the list and, if nothing works, leaves a plain canvas and says why
 * rather than tiling an error image across the screen.
 */
function BaseTiles({ sources, onExhausted }) {
  const [idx, setIdx] = useState(0);
  const failures = useRef(0);
  const source = sources[idx];

  useEffect(() => { failures.current = 0; setIdx(0); }, [sources]);
  useEffect(() => { failures.current = 0; }, [idx]);
  if (!source) return null;

  return (
    <TileLayer
      key={source.name}
      url={source.url}
      attribution={source.attribution}
      subdomains={source.subdomains ?? "abc"}
      maxZoom={source.maxZoom ?? 19}
      errorTileUrl={BLANK_TILE}
      eventHandlers={{
        tileload: () => { failures.current = 0; },
        tileerror: () => {
          failures.current += 1;
          if (failures.current < FAILURES_BEFORE_SWITCH) return;
          console.warn(`[map] tile source "${source.name}" is failing; falling back.`);
          if (idx + 1 < sources.length) setIdx(idx + 1);
          else onExhausted();
        },
      }}
    />
  );
}

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
  const [noTiles, setNoTiles] = useState(false);

  // The tile providers, newest config first. Cached for the session: the key
  // behind it only changes when someone edits the env file and restarts.
  const { data: sources = DEFAULT_TILE_SOURCES } = useQuery({
    queryKey: ["map-config"],
    queryFn: () => get("/api/map-config").then((r) => (r.sources?.length ? r.sources : DEFAULT_TILE_SOURCES))
      .catch(() => DEFAULT_TILE_SOURCES),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  useEffect(() => { setNoTiles(false); }, [sources]);

  return (
    <div className="relative h-full w-full">
      {noTiles && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1000] bg-white/95 border border-border rounded-lg px-3 py-1.5 shadow-sm text-xs text-muted-foreground max-w-xs text-center">
          Background map unavailable right now. Pins and addresses are still accurate.
        </div>
      )}
      <MapContainer center={HOME_CENTER} zoom={HOME_ZOOM} scrollWheelZoom
        className={`h-full w-full rounded-xl z-0 ${noTiles ? "bg-slate-100" : ""}`}>
        <BaseTiles sources={sources} onExhausted={() => setNoTiles(true)} />
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
    </div>
  );
}
