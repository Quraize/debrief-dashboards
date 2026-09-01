import { NavLink } from "react-router-dom";
import { Home, Megaphone, PhoneCall, Users, Shield } from "lucide-react";

const TABS = [
  { to: "/", label: "Overview", icon: Home, end: true },
  { to: "/marketing", label: "Marketing", icon: Megaphone },
  { to: "/setters", label: "Call Center", icon: PhoneCall },
  { to: "/sales-reps", label: "Sales", icon: Users },
  { to: "/insurance", label: "Insurance", icon: Shield },
];

export default function DashboardSwitcher() {
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1 no-print">
      {TABS.map((t) => {
        const Icon = t.icon;
        return (
          <NavLink key={t.to} to={t.to} end={t.end}
            className={({ isActive }) =>
              `flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-colors ${
                isActive ? "bg-primary text-primary-foreground" : "bg-white border border-border text-foreground hover:bg-secondary"
              }`
            }>
            <Icon className="w-4 h-4" />
            {t.label}
          </NavLink>
        );
      })}
    </div>
  );
}