import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import DateRangeFilter from "@/components/DateRangeFilter";
import DashboardSwitcher from "@/components/DashboardSwitcher";
import KpiCard from "@/components/KpiCard";
import { computeKPIs } from "@allied/shared/kpi";
import { salesAppointmentsOnly } from "@allied/shared/salesAppointment";
import { nonInsuranceAppointments } from "@allied/shared/insurance";
import { ClipboardList, Inbox, AlertTriangle, TrendingUp, CalendarClock, Upload, FileText, ClipboardCheck } from "lucide-react";

export default function Home() {
  const [filter, setFilter] = useState("Today");
  const [cs, setCs] = useState("");
  const [ce, setCe] = useState("");

  const { data: debriefs = [] } = useQuery({
    queryKey: ["debriefs"],
    queryFn: () => base44.entities.Debrief.list("-created_date", 500)
  });
  const { data: appointments = [] } = useQuery({
    queryKey: ["appointments-all"],
    queryFn: () => base44.entities.Appointment.list("-created_date", 500)
  });

  const salesAppts = salesAppointmentsOnly(nonInsuranceAppointments(appointments));
  const kpis = computeKPIs(debriefs, salesAppts, filter, cs, ce);
  const todayAppts = salesAppts.filter((a) => a.appointment_date === new Date().toISOString().slice(0, 10));
  const missing = salesAppts.filter((a) => {
    if (!a.appointment_date) return false;
    return new Date(a.appointment_date + "T00:00:00").getTime() < Date.now() && (a.debrief_status === "Missing" || a.debrief_status === "Unmatched");
  });

  return (
    <div className="space-y-4">
      <DashboardSwitcher />
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Today</h1>
        <p className="text-sm text-muted-foreground">Allied Roofing & Construction — sales at a glance.</p>
      </div>

      <DateRangeFilter filter={filter} setFilter={setFilter} customStart={cs} setCustomStart={setCs} customEnd={ce} setCustomEnd={setCe} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <QuickLink to="/submit" icon={ClipboardList} label="Submit Debrief" />
        <QuickLink to="/queue" icon={Inbox} label="Open Queue" badge={missing.length} />
        <QuickLink to="/import" icon={Upload} label="Import" />
        <QuickLink to="/exceptions" icon={AlertTriangle} label="Exceptions" />
        <QuickLink to="/kpi" icon={TrendingUp} label="KPI Dashboard" />
        <QuickLink to="/results" icon={FileText} label="Results Review" />
        <QuickLink to="/manager-report" icon={ClipboardCheck} label="Weekly Manager Report" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {kpis.map((k) => <KpiCard key={k.label} label={k.label} value={k.value} />)}
      </div>

      <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
        <div className="flex items-center gap-2 mb-3">
          <CalendarClock className="w-5 h-5 text-accent" />
          <h2 className="font-heading font-bold text-primary">Today's Appointments</h2>
        </div>
        {todayAppts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No appointments scheduled today.</p>
        ) : (
          <div className="space-y-2">
            {todayAppts.map((a) => (
              <div key={a.id} className="flex items-center justify-between border-b border-border/60 py-2 last:border-0">
                <div>
                  <div className="font-semibold text-sm text-primary">{a.customer_name}</div>
                  <div className="text-xs text-muted-foreground">{a.product} • {a.original_sales_rep || "Unassigned"}</div>
                </div>
                <span className={`text-xs font-semibold px-2 py-1 rounded-full ${a.debrief_status === "Missing" ? "bg-accent/15 text-accent" : "bg-secondary text-secondary-foreground"}`}>
                  {a.debrief_status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function QuickLink({ to, icon: Icon, label, badge }) {
  return (
    <Link to={to} className="bg-white rounded-xl border border-border p-4 shadow-sm hover:shadow-md transition-shadow flex flex-col items-start gap-2 relative">
      <Icon className="w-6 h-6 text-accent" />
      <span className="font-semibold text-sm text-primary">{label}</span>
      {badge > 0 && (
        <span className="absolute top-2 right-2 bg-accent text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">{badge}</span>
      )}
    </Link>
  );
}