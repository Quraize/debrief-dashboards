import { Outlet, NavLink, useLocation } from "react-router-dom";
import { useState } from "react";
import { base44 } from "@/api/client";
import { useQuery } from "@tanstack/react-query";
import {
  Home, ClipboardList, Inbox, CalendarDays, BarChart3, Users, PhoneCall,
  AlertTriangle, Download, Settings, Menu, X, HardHat, Upload, FileText, ClipboardCheck, Megaphone, Shield, RefreshCw
} from "lucide-react";

const DASHBOARDS = [
  { to: "/", label: "Overview", icon: Home, end: true },
  { to: "/marketing", label: "Marketing", icon: Megaphone },
  { to: "/setters", label: "Call Center", icon: PhoneCall },
  { to: "/sales-reps", label: "Sales", icon: Users },
  { to: "/insurance", label: "Insurance", icon: Shield },
];

const OPERATIONS = [
  { to: "/submit", label: "Submit Debrief", icon: ClipboardList },
  { to: "/queue", label: "Open Debrief Queue", icon: Inbox },
  { to: "/appointments", label: "Appointment Records", icon: CalendarDays },
  { to: "/kpi", label: "KPI Dashboard", icon: BarChart3 },
  { to: "/results", label: "Results Review", icon: FileText },
  { to: "/manager-report", label: "Manager Report", icon: ClipboardCheck },
  { to: "/exceptions", label: "Exceptions / Unmatched", icon: AlertTriangle },
  { to: "/import", label: "Import Appointments", icon: Upload },
  { to: "/export", label: "Export / Sync Center", icon: Download },
  { to: "/admin", label: "Admin Settings", icon: Settings },
];

const ADMIN_OPERATIONS = [
  { to: "/jobprogress-sync", label: "JobProgress Sync", icon: RefreshCw },
];

const ALL_NAV = [...DASHBOARDS, ...OPERATIONS];

export default function AppLayout() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => base44.auth.me().catch(() => null)
  });

  return (
    <div className="min-h-screen bg-secondary/40">
      {/* Top bar */}
      <header className="sticky top-0 z-30 bg-primary text-primary-foreground shadow-md">
        <div className="flex items-center justify-between px-4 h-14">
          <div className="flex items-center gap-2">
            <div className="bg-accent rounded-lg w-8 h-8 flex items-center justify-center">
              <HardHat className="w-5 h-5 text-white" />
            </div>
            <div className="leading-tight">
              <div className="font-heading font-bold text-sm sm:text-base">Allied Roofing</div>
              <div className="text-[10px] text-primary-foreground/70 -mt-0.5">Sales Debrief & KPI</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {me && (
              <span className="hidden sm:inline text-xs bg-white/10 px-2 py-1 rounded-full">
                {me.full_name || me.email}
              </span>
            )}
            <button className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
              <Menu className="w-6 h-6" />
            </button>
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Desktop sidebar */}
        <aside className="hidden lg:flex flex-col w-64 min-h-[calc(100vh-3.5rem)] bg-white border-r border-border p-3 gap-1 sticky top-14 overflow-y-auto">
          <NavSection label="Dashboards" items={DASHBOARDS} />
          <div className="my-1 border-t border-border/60" />
          <NavSection label="Operations" items={OPERATIONS} />
          {me?.role === "admin" && (
            <>
              <div className="my-1 border-t border-border/60" />
              <NavSection label="Admin" items={ADMIN_OPERATIONS} />
            </>
          )}
        </aside>

        {/* Mobile drawer */}
        {open && (
          <div className="lg:hidden fixed inset-0 z-50">
            <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
            <div className="absolute right-0 top-0 bottom-0 w-72 bg-white p-4 overflow-y-auto">
              <div className="flex items-center justify-between mb-4">
                <span className="font-heading font-bold">Menu</span>
                <button onClick={() => setOpen(false)}><X className="w-5 h-5" /></button>
              </div>
              <div className="flex flex-col gap-1">
                <NavSection label="Dashboards" items={DASHBOARDS} onClick={() => setOpen(false)} />
                <div className="my-1 border-t border-border/60" />
                <NavSection label="Operations" items={OPERATIONS} onClick={() => setOpen(false)} />
                {me?.role === "admin" && (
                  <>
                    <div className="my-1 border-t border-border/60" />
                    <NavSection label="Admin" items={ADMIN_OPERATIONS} onClick={() => setOpen(false)} />
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Main content */}
        <main className="flex-1 min-w-0 pb-20 lg:pb-8">
          <div className="p-4 sm:p-6 max-w-7xl mx-auto" key={location.pathname}>
            <Outlet />
          </div>
        </main>
      </div>

      {/* Mobile bottom nav — dashboard switcher */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-border grid grid-cols-5 h-16">
        {DASHBOARDS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink key={item.to} to={item.to} end={item.end}
              className={({ isActive }) =>
                `flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium ${
                  isActive ? "text-accent" : "text-muted-foreground"
                }`
              }>
              <Icon className="w-5 h-5" />
              {item.label}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}

function NavSection({ label, items, onClick }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-3 pt-2 pb-1">{label}</span>
      {items.map((item) => (
        <NavItem key={item.to} item={item} onClick={onClick} />
      ))}
    </div>
  );
}

function NavItem({ item, onClick }) {
  const Icon = item.icon;
  return (
    <NavLink to={item.to} end={item.end} onClick={onClick}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
          isActive ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-secondary"
        }`
      }>
      <Icon className="w-4 h-4" />
      {item.label}
    </NavLink>
  );
}