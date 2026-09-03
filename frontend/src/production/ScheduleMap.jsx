import { useEffect, useRef } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { jobTypeColor } from "@allied/shared/production";

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
      {/* CARTO Voyager: a free, keyless basemap in the Google Maps idiom —
          cream land, white roads, amber highways, quiet labels, retina tiles. */}
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
        subdomains="abcd"
        maxZoom={20}
      />
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
