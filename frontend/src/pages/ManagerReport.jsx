import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import DebriefFilters from "@/components/DebriefFilters";
import { filterByDate, computeKPIs, isSale, buildExportRows, toCSV, twoLegStats, isTwoLegEligible, TWO_LEG_DEFINITION, appointmentQualityStats, appointmentQualityByGroup, DEMO_RATE_DEFINITION, NO_DEMO_RATE_DEFINITION, NO_SEE_RATE_DEFINITION, RESET_RATE_DEFINITION, RESET_RECOVERY_DEFINITION, LEGACY_DEMO_RATE_DEFINITION } from "@allied/shared/kpi";
import {
  DEMO_OUTCOMES, DEMO_NO_SALE_OUTCOME, RESET_OUTCOMES, FIRST_CALL_CLOSE, ESTIMATING_IN_PROGRESS_OUTCOME
} from "@allied/shared/constants";
import { salesAppointmentsOnly } from "@allied/shared/salesAppointment";
import { nonInsuranceDebriefs, nonInsuranceAppointments } from "@allied/shared/insurance";
import { Printer, Download, Loader2, Target } from "lucide-react";

function num(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }
function money(v) { return "$" + num(v).toLocaleString(); }

export default function ManagerReport() {
  const [filter, setFilter] = useState("This Week");
  const [cs, setCs] = useState("");
  const [ce, setCe] = useState("");
  const [rep, setRep] = useState("");
  const [clientName, setClientName] = useState("");
  const [city, setCity] = useState("");
  const [div, setDiv] = useState("");
  const [outcome, setOutcome] = useState("");
  const [dm, setDm] = useState("");
  const [closeType, setCloseType] = useState("");

  const { data: debriefs = [], isLoading } = useQuery({ queryKey: ["debriefs"], queryFn: () => base44.entities.Debrief.list("-created_date", 500) });
  const { data: appointments = [] } = useQuery({ queryKey: ["appointments-all"], queryFn: () => base44.entities.Appointment.list("-created_date", 500) });

  const fdb = useMemo(() => {
    let result = filterByDate(nonInsuranceDebriefs(debriefs), "appointment_date", filter, cs, ce);
    if (rep) result = result.filter((d) => d.sales_rep === rep);
    if (div) result = result.filter((d) => d.product === div);
    if (outcome) result = result.filter((d) => d.appointment_outcome === outcome);
    if (dm) result = result.filter((d) => d.decision_maker_status === dm);
    if (closeType) result = result.filter((d) => d.sale_close_type === closeType);
    if (city) result = result.filter((d) => d.city === city);
    if (clientName.trim()) {
      const q = clientName.toLowerCase().trim();
      result = result.filter((d) => d.customer_name && d.customer_name.toLowerCase().includes(q));
    }
    return result;
  }, [debriefs, filter, cs, ce, rep, div, outcome, dm, closeType, city, clientName]);

  const dateTotal = useMemo(() => filterByDate(debriefs, "appointment_date", filter, cs, ce).length, [debriefs, filter, cs, ce]);
  const fAppts = useMemo(() =>
    filterByDate(salesAppointmentsOnly(nonInsuranceAppointments(appointments)), "appointment_date", filter, cs, ce),
    [appointments, filter, cs, ce]
  );

  const kpis = useMemo(() => computeKPIs(fdb, fAppts, "All", "", ""), [fdb, fAppts]);
  const kpi = (label) => kpis.find((k) => k.label === label)?.value ?? 0;

  // Two-Leg canonical: numerator = Two-Leg among (First Appts + Reset Demos + Re-engagements) in qualifying divisions
  const tl = useMemo(() => twoLegStats(fdb), [fdb]);
  const twoLeg = tl.twoLeg;
  const twoLegDenom = tl.denominator;
  const twoLegPct = tl.rate;
  const aq = useMemo(() => appointmentQualityStats(fdb), [fdb]);
  // Qualifying divisions still used for one-leg coaching list
  const qualifying = useMemo(() => fdb.filter(isTwoLegEligible), [fdb]);
  const oneLeg = qualifying.filter((d) => d.decision_maker_status === "One-Leg").length;

  const sales = fdb.filter((d) => isSale(d));
  const revenue = sales.reduce((s, d) => s + num(d.sale_amount), 0);
  const firstCallCloses = fdb.filter((d) => d.sale_close_type === FIRST_CALL_CLOSE).length;
  const demos = fdb.filter((d) => DEMO_OUTCOMES.includes(d.appointment_outcome)).length;
  const pricesGiven = fdb.filter((d) => num(d.prices_given) > 0).length;
  const resets = fdb.filter((d) => d.reset_needed === true || RESET_OUTCOMES.includes(d.appointment_outcome)).length;
  const followUps = fdb.filter((d) => d.follow_up_needed === true).length;
  const missingDebriefs = kpi("Missing Debriefs");

  // Rep table
  const repTable = useMemo(() => {
    const map = {};
    fdb.forEach((d) => {
      const k = d.sales_rep || "Unassigned";
      if (!map[k]) map[k] = { name: k, count: 0, demos: 0, twoLeg: 0, twoLegDenom: 0, oneLeg: 0, sales: 0, revenue: 0, fcc: 0, prices: 0, resets: 0, followUps: 0 };
      const g = map[k];
      g.count++;
      if (DEMO_OUTCOMES.includes(d.appointment_outcome)) g.demos++;
      if (isTwoLegEligible(d)) {
        g.twoLegDenom++;
        if (d.decision_maker_status === "Two-Leg") g.twoLeg++;
      }
      if (isTwoLegEligible(d) && d.decision_maker_status === "One-Leg") g.oneLeg++;
      if (isSale(d)) { g.sales++; g.revenue += num(d.sale_amount); }
      if (d.sale_close_type === FIRST_CALL_CLOSE) g.fcc++;
      if (num(d.prices_given) > 0) g.prices++;
      if (d.reset_needed === true || RESET_OUTCOMES.includes(d.appointment_outcome)) g.resets++;
      if (d.follow_up_needed === true) g.followUps++;
    });
    const aqMap = {};
    appointmentQualityByGroup(fdb, "sales_rep").forEach((g) => { aqMap[g.name] = g; });
    return Object.values(map).map((g) => {
      const a = aqMap[g.name] || {};
      return { ...g, demoRate: a.demoRate || 0, aqNoDemo: a.aqNoDemo || 0, noDemoRate: a.noDemoRate || 0, aqNoSee: a.aqNoSee || 0, noSeeRate: a.noSeeRate || 0, aqResetNeeded: a.aqResetNeeded || 0, resetRate: a.resetRate || 0, aqCompletedResetDemo: a.aqCompletedResetDemo || 0, resetRecoveryRate: a.resetRecoveryRate || 0 };
    }).sort((a, b) => b.count - a.count);
  }, [fdb]);

  // Detail lists
  const wins = sales.map((d) => ({ customer: d.customer_name, trade: d.product, amount: d.sale_amount, close: d.sale_close_type, date: d.appointment_date }));
  const noSales = fdb.filter((d) => d.appointment_outcome === DEMO_NO_SALE_OUTCOME);
  const objectionMap = {};
  noSales.forEach((d) => { const k = d.main_objection || "Unspecified"; objectionMap[k] = (objectionMap[k] || 0) + 1; });
  const topObjections = Object.entries(objectionMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const oneLegCoaching = qualifying.filter((d) => d.decision_maker_status === "One-Leg");
  const resetRecords = fdb.filter((d) => d.reset_needed === true || RESET_OUTCOMES.includes(d.appointment_outcome));
  const followUpRecords = fdb.filter((d) => d.follow_up_needed === true);
  const estimatingRecords = fdb.filter((d) => d.appointment_outcome === ESTIMATING_IN_PROGRESS_OUTCOME);

  // Missing debriefs (past appointments without matching debrief)
  const debriefKeys = new Set();
  fdb.forEach((d) => { if (d.crm_lead_id && d.appointment_date) debriefKeys.add(d.crm_lead_id.toLowerCase().trim() + "|" + d.appointment_date); });
  const missingRecords = fAppts.filter((a) => {
    if (!a.appointment_date) return false;
    if (new Date(a.appointment_date + "T00:00:00").getTime() >= Date.now()) return false;
    const key = (a.crm_lead_id || "").toLowerCase().trim() + "|" + a.appointment_date;
    return !debriefKeys.has(key);
  });
  const dataQualityRecords = fdb.filter((d) => d.data_quality_flag);

  // Executive summary
  const execBullets = [];
  execBullets.push(`${kpi("Appointments")} appointments, ${demos} demos (${pct(demos, kpi("Appointments"))}% demo rate), ${sales.length} sales totaling ${money(revenue)}.`);
  execBullets.push(`Two-Leg: ${twoLeg} of ${twoLegDenom} qualifying appointments (First Appts + Reset Demos + Rehashes) = ${twoLegPct}% (Roofing, Siding, Roofing + Siding only).`);
  execBullets.push(`First Call Close: ${firstCallCloses} of ${sales.length} sales = ${pct(firstCallCloses, sales.length)}%.`);
  if (missingDebriefs > 0) execBullets.push(`${missingDebriefs} missing debriefs require follow-up.`);
  if (oneLegCoaching.length > 0) execBullets.push(`${oneLegCoaching.length} qualifying one-leg appointments need coaching.`);

  function handlePrint() { window.print(); }
  function handleCSV() {
    const rows = buildExportRows(fdb, salesAppointmentsOnly(nonInsuranceAppointments(appointments)));
    const csv = toCSV(rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `manager-report-${filter.replace(/\s/g, "-").toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      {/* Header */}
      <div className="print-break">
        <h1 className="text-2xl font-heading font-bold text-primary">Weekly Manager Report</h1>
        <p className="text-sm text-muted-foreground">Allied Roofing & Construction — Sales Manager Review</p>
      </div>

      {/* Controls (hidden in print) */}
      <div className="no-print space-y-3">
        <DebriefFilters
          debriefs={debriefs}
          filter={filter} setFilter={setFilter} cs={cs} setCs={setCs} ce={ce} setCe={setCe}
          clientName={clientName} setClientName={setClientName}
          city={city} setCity={setCity}
          rep={rep} setRep={setRep}
          div={div} setDiv={setDiv}
          outcome={outcome} setOutcome={setOutcome}
          dm={dm} setDm={setDm}
          closeType={closeType} setCloseType={setCloseType}
          dateTotalCount={dateTotal}
          filteredCount={fdb.length}
        />
        <div className="flex justify-end gap-2">
          <button onClick={handlePrint} className="flex items-center gap-1.5 bg-primary text-primary-foreground font-semibold text-sm px-4 py-2.5 rounded-lg hover:bg-primary/90">
            <Printer className="w-4 h-4" /> Print / PDF
          </button>
          <button onClick={handleCSV} className="flex items-center gap-1.5 bg-accent text-white font-semibold text-sm px-4 py-2.5 rounded-lg hover:bg-accent/90">
            <Download className="w-4 h-4" /> CSV
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {/* Executive Summary */}
          <Section title="Executive Summary">
            <ul className="list-disc pl-5 space-y-1 text-sm text-foreground">
              {execBullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </Section>

          {/* KPI Strip */}
          <Section title="KPI Summary">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <MiniKpi label="Appointments" value={kpi("Appointments")} />
              <MiniKpi label="Demos" value={`${demos} (${pct(demos, kpi("Appointments"))}%)`} />
              <MiniKpi label="Two-Leg" value={`${twoLeg}/${twoLegDenom} (${twoLegPct}%)`} />
              <MiniKpi label="Sales" value={`${sales.length} (${pct(sales.length, demos)}%)`} />
              <MiniKpi label="Revenue" value={money(revenue)} />
              <MiniKpi label="First Call Close" value={`${firstCallCloses}/${sales.length} (${pct(firstCallCloses, sales.length)}%)`} />
              <MiniKpi label="Prices Given" value={pricesGiven} />
              <MiniKpi label="Resets" value={resets} />
              <MiniKpi label="Follow-Ups" value={followUps} />
              <MiniKpi label="Missing Debriefs" value={missingDebriefs} />
              <MiniKpi label="Demo Rate" value={`${aq.aqDemos}/${aq.aqOpportunities} (${aq.demoRate}%)`} />
              <MiniKpi label="No Demo" value={`${aq.aqNoDemo} (${aq.noDemoRate}%)`} />
              <MiniKpi label="No See Rate" value={`${aq.aqNoSee}/${aq.aqNoSeeDenom} (${aq.noSeeRate}%)`} />
              <MiniKpi label="Reset Needed" value={`${aq.aqResetNeeded} (${aq.resetRate}%)`} />
              <MiniKpi label="Completed Reset Demos" value={aq.aqCompletedResetDemo} />
              <MiniKpi label="Reset Recovery Rate" value={`${aq.resetRecoveryRate}%`} />
              <MiniKpi label="Legacy Overall Demo Rate" value={`${aq.aqLegacyDemos}/${aq.aqLegacyDenom} (${aq.aqLegacyDenom > 0 ? Math.round(aq.aqLegacyDemos / aq.aqLegacyDenom * 100) : 0}%)`} />
            </div>
          </Section>

          {/* Two-Leg Definition */}
          <Section title="Two-Leg Definition">
            <p className="text-xs text-muted-foreground">{TWO_LEG_DEFINITION}</p>
          </Section>

          <Section title="Appointment Quality Definitions">
            <div className="text-xs text-muted-foreground space-y-1">
              <p><strong>Demo Rate:</strong> {DEMO_RATE_DEFINITION}</p>
              <p><strong>No Demo Rate:</strong> {NO_DEMO_RATE_DEFINITION}</p>
              <p><strong>No See Rate:</strong> {NO_SEE_RATE_DEFINITION}</p>
              <p><strong>Reset Rate:</strong> {RESET_RATE_DEFINITION}</p>
              <p><strong>Reset Recovery Rate:</strong> {RESET_RECOVERY_DEFINITION}</p>
              <p><strong>Legacy Overall Demo Rate:</strong> {LEGACY_DEMO_RATE_DEFINITION}</p>
            </div>
          </Section>

          {/* Rep Performance Table */}
          <Section title="Rep Performance">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1.5 pr-2 font-semibold">Rep</th>
                    <th className="py-1.5 px-1 font-semibold text-center">Apt</th>
                    <th className="py-1.5 px-1 font-semibold text-center">Demos</th>
                    <th className="py-1.5 px-1 font-semibold text-center">Demo Rate</th>
                    <th className="py-1.5 px-1 font-semibold text-center">No Demo</th>
                    <th className="py-1.5 px-1 font-semibold text-center">No Demo %</th>
                    <th className="py-1.5 px-1 font-semibold text-center">No See</th>
                    <th className="py-1.5 px-1 font-semibold text-center">No See %</th>
                    <th className="py-1.5 px-1 font-semibold text-center">Reset Need</th>
                    <th className="py-1.5 px-1 font-semibold text-center">Reset Rec %</th>
                    <th className="py-1.5 px-1 font-semibold text-center">2L/Eligible</th>
                    <th className="py-1.5 px-1 font-semibold text-center">2L%</th>
                    <th className="py-1.5 px-1 font-semibold text-center">Sales</th>
                    <th className="py-1.5 px-1 font-semibold text-center">Rev</th>
                    <th className="py-1.5 px-1 font-semibold text-center">FCC</th>
                    <th className="py-1.5 px-1 font-semibold text-center">Prices</th>
                    <th className="py-1.5 px-1 font-semibold text-center">Reset</th>
                    <th className="py-1.5 pl-1 font-semibold text-center">FU</th>
                  </tr>
                </thead>
                <tbody>
                  {repTable.map((r) => (
                    <tr key={r.name} className="border-b border-border/50">
                      <td className="py-1.5 pr-2 font-semibold text-primary">{r.name}</td>
                      <td className="py-1.5 px-1 text-center">{r.count}</td>
                      <td className="py-1.5 px-1 text-center">{r.demos}</td>
                      <td className="py-1.5 px-1 text-center">{r.demoRate}%</td>
                      <td className="py-1.5 px-1 text-center">{r.aqNoDemo}</td>
                      <td className="py-1.5 px-1 text-center">{r.noDemoRate}%</td>
                      <td className="py-1.5 px-1 text-center">{r.aqNoSee}</td>
                      <td className="py-1.5 px-1 text-center">{r.noSeeRate}%</td>
                      <td className="py-1.5 px-1 text-center">{r.aqResetNeeded}</td>
                      <td className="py-1.5 px-1 text-center">{r.resetRecoveryRate}%</td>
                      <td className="py-1.5 px-1 text-center">{r.twoLeg}/{r.twoLegDenom}</td>
                      <td className="py-1.5 px-1 text-center">{pct(r.twoLeg, r.twoLegDenom)}%</td>
                      <td className="py-1.5 px-1 text-center">{r.sales}</td>
                      <td className="py-1.5 px-1 text-center">{money(r.revenue)}</td>
                      <td className="py-1.5 px-1 text-center">{r.fcc}/{r.sales}</td>
                      <td className="py-1.5 px-1 text-center">{r.prices}</td>
                      <td className="py-1.5 px-1 text-center">{r.resets}</td>
                      <td className="py-1.5 pl-1 text-center">{r.followUps}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Wins / Sold Jobs */}
          <Section title={`Wins / Sold Jobs (${wins.length})`}>
            <RecordList records={wins} emptyText="No sales in this period." columns={["customer", "trade", "amount", "close", "date"]} />
          </Section>

          {/* No-Sales and Top Objections */}
          <Section title={`No-Sales (${noSales.length}) and Top Objections`}>
            {topObjections.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {topObjections.map(([obj, count]) => (
                  <span key={obj} className="text-xs bg-secondary px-2 py-1 rounded-full font-semibold">{obj}: {count}</span>
                ))}
              </div>
            )}
            <RecordList records={noSales.map((d) => ({
              customer: d.customer_name,
              trade: d.product,
              objection: d.main_objection || "—",
              wording: d.objection_customer_wording || "",
              step7: d.step7_result || "",
              coaching: d.step7_coaching_notes || "",
              date: d.appointment_date
            }))} emptyText="No demo no-sale records." columns={["customer", "trade", "objection", "wording", "step7", "coaching", "date"]} />
          </Section>

          {/* Qualifying One-Leg Coaching */}
          <Section title={`Qualifying One-Leg Appointments — Coaching (${oneLegCoaching.length})`}>
            <p className="text-xs text-muted-foreground mb-2">Residential replacement divisions only (Roofing, Siding, Roofing + Siding). Commercial/Service/Repair/Misc excluded.</p>
            <RecordList records={oneLegCoaching.map((d) => ({ customer: d.customer_name, trade: d.product, rep: d.sales_rep, reason: d.one_leg_reason || "—", date: d.appointment_date }))} emptyText="No one-leg coaching items." columns={["customer", "trade", "rep", "reason", "date"]} />
          </Section>

          {/* Resets / Follow-Ups / Pending Estimating */}
          <Section title="Resets, Follow-Ups & Pending Estimating">
            <SubGroup label={`Resets (${resetRecords.length})`}>
              <RecordList records={resetRecords.map((d) => ({
                customer: d.customer_name,
                reason: d.reset_reason || d.appointment_outcome,
                scheduled: d.reset_appointment_scheduled === true ? "Yes" : (d.reset_appointment_scheduled === false ? "No" : "—"),
                resetDate: d.reset_date || "—",
                followUp: d.reset_follow_up_notes || "",
                date: d.reset_date || d.appointment_date
              }))} emptyText="No resets." columns={["customer", "reason", "scheduled", "resetDate", "followUp", "date"]} />
            </SubGroup>
            <SubGroup label={`Follow-Ups (${followUpRecords.length})`}>
              <RecordList records={followUpRecords.map((d) => ({ customer: d.customer_name, bucket: d.follow_up_bucket || "—", date: d.follow_up_date || "—" }))} emptyText="No follow-ups." columns={["customer", "bucket", "date"]} />
            </SubGroup>
            <SubGroup label={`Pending Estimating (${estimatingRecords.length})`}>
              <RecordList records={estimatingRecords.map((d) => ({ customer: d.customer_name, trade: d.product, date: d.appointment_date }))} emptyText="No pending estimates." columns={["customer", "trade", "date"]} />
            </SubGroup>
          </Section>

          {/* Missing / Data-Quality */}
          <Section title="Missing Debriefs & Data-Quality Issues">
            <SubGroup label={`Missing Debriefs (${missingRecords.length})`}>
              <RecordList records={missingRecords.map((a) => ({ customer: a.customer_name, date: a.appointment_date, setter: a.original_appointment_setter || "—" }))} emptyText="No missing debriefs." columns={["customer", "date", "setter"]} />
            </SubGroup>
            <SubGroup label={`Data-Quality Flags (${dataQualityRecords.length})`}>
              <RecordList records={dataQualityRecords.map((d) => ({ customer: d.customer_name, flag: d.data_quality_flag, date: d.appointment_date }))} emptyText="No data-quality issues." columns={["customer", "flag", "date"]} />
            </SubGroup>
          </Section>

          {/* Goals */}
          <Section title="Sales Goals / Targets">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Target className="w-4 h-4" />
              <span>Goals not configured — no existing goal source found. Configure sales targets in Admin Settings to enable goal tracking.</span>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="bg-white rounded-xl border border-border p-4 shadow-sm print-break">
      <h2 className="font-heading font-bold text-sm text-primary uppercase tracking-wide mb-3">{title}</h2>
      {children}
    </div>
  );
}

function MiniKpi({ label, value }) {
  return (
    <div className="bg-secondary/40 rounded-lg p-2 text-center border border-border/50">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold leading-tight">{label}</div>
      <div className="text-sm font-heading font-bold text-primary mt-0.5">{value}</div>
    </div>
  );
}

function SubGroup({ label, children }) {
  return (
    <div className="mb-3 last:mb-0">
      <h3 className="text-xs font-heading font-bold text-foreground mb-1">{label}</h3>
      {children}
    </div>
  );
}

function RecordList({ records, emptyText, columns }) {
  if (!records.length) return <p className="text-xs text-muted-foreground italic">{emptyText}</p>;
  return (
    <div className="space-y-1">
      {records.map((r, i) => (
        <div key={i} className="text-xs flex flex-wrap gap-x-3 gap-y-0.5 border-b border-border/30 pb-1 last:border-0">
          {columns.map((c) => (
            <span key={c} className={c === records[0] && Object.keys(r)[0] === c ? "font-semibold text-primary" : "text-foreground"}>
              {r[c] != null ? String(r[c]) : "—"}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}