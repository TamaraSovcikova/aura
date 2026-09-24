import { SEVERITY_MAX, type Episode, type MedDose } from "../shared/types";
import { parseRegions, deriveSide } from "../shared/headmap";
import { HeadHeatMap } from "./HeadMap";
import { verdictLabel } from "./History";
import { attackTimes, clockHM, dayShort } from "./time";

// One attack, read-only: what happened, in the order it happened.
//
// The log row answers "when, how long, how bad". This answers the rest without
// opening the editor: a timeline of the attack with every dose and the relief it
// brought placed where it happened, what the symptoms were, and where it hurt.
//
// The timeline draws only what was recorded. The app stores the peak severity but
// not when the peak came, so there is no pain curve here: a curve would invent the
// shape between two real numbers. What is real is drawn: the span of the attack,
// the moment of each dose, the moment of relief and the level it came down to.

const SYMPTOMS: Array<{ key: keyof Episode; yes: string }> = [
  { key: "nausea", yes: "Nausea" },
  { key: "photophobia", yes: "Light hurt" },
  { key: "phonophobia", yes: "Sound hurt" },
  { key: "aggravated_by_activity", yes: "Worse moving" },
  { key: "aura", yes: "Aura" },
];

const W = 320;
const TRACK_Y = 58;

function Timeline({ e, doses }: { e: Episode; doses: MedDose[] }) {
  const start = Date.parse(e.started_at);
  const end = e.ended_at ? Date.parse(e.ended_at) : null;
  if (end === null) return null;

  // The domain covers the attack and anything logged against it, even a dose logged
  // with a time outside the attack, so nothing recorded falls off the edge.
  const times = [start, end, ...doses.flatMap((d) => [Date.parse(d.taken_at), d.relief_at ? Date.parse(d.relief_at) : start])];
  const t0 = Math.min(...times);
  const t1 = Math.max(...times, t0 + 60_000);
  const x = (t: number) => 12 + ((t - t0) / (t1 - t0)) * (W - 24);

  const sev = e.severity;
  const fill = `rgba(244, 63, 94, ${sev === null ? 0.35 : (0.25 + (sev / SEVERITY_MAX) * 0.65).toFixed(2)})`;
  const mid = start + (end - start) / 2;

  return (
    <svg viewBox={`0 0 ${W} 118`} className="w-full" role="img" aria-label="Attack timeline">
      <rect x={12} y={TRACK_Y - 1} width={W - 24} height={2} rx={1} className="fill-zinc-800" />
      <rect x={x(start)} y={TRACK_Y - 9} width={Math.max(4, x(end) - x(start))} height={18} rx={9} style={{ fill }} />
      {sev !== null && (
        <text x={x(start) + 10} y={TRACK_Y + 4} className="fill-white text-[11px] font-semibold">
          peak {sev}/{SEVERITY_MAX}
        </text>
      )}

      {doses.map((d, i) => {
        const tx = x(Date.parse(d.taken_at));
        const rx = d.relief_at ? x(Date.parse(d.relief_at)) : null;
        const row = i % 2; // alternate label rows so close doses do not collide
        return (
          <g key={d.id}>
            <line x1={tx} x2={tx} y1={TRACK_Y - 30 + row * 8} y2={TRACK_Y - 9} className="stroke-accent-300" strokeWidth={1.5} />
            <circle cx={tx} cy={TRACK_Y - 32 + row * 8} r={4} className="fill-accent-300" />
            <text x={tx + 7} y={TRACK_Y - 28 + row * 8} className="fill-zinc-300 text-[10px]">
              {d.name ?? "dose"} {clockHM(d.taken_at)}
            </text>
            {rx !== null && (
              <g>
                <path d={`M${tx} ${TRACK_Y + 12} Q${(tx + rx) / 2} ${TRACK_Y + 26} ${rx} ${TRACK_Y + 12}`} className="fill-none stroke-accent-300/60" strokeWidth={1.25} strokeDasharray="3 3" />
                <circle cx={rx} cy={TRACK_Y + 12} r={3.5} className="fill-zinc-100" />
                <text x={rx} y={TRACK_Y + 34} textAnchor="middle" className="fill-zinc-300 text-[10px]">
                  relief{d.relief_severity !== null ? `, ${d.relief_severity}/${SEVERITY_MAX}` : ""}
                </text>
              </g>
            )}
          </g>
        );
      })}

      {[start, mid, end].map((t, i) => (
        <text
          key={i}
          x={x(t)}
          y={114}
          textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
          className="fill-zinc-500 text-[10px] tabular-nums"
        >
          {clockHM(new Date(t).toISOString())}
        </text>
      ))}
    </svg>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex-1 rounded-xl bg-zinc-800/60 px-3 py-2.5">
      <p className="text-lg font-semibold tabular-nums text-zinc-100">{value}</p>
      <p className="text-[11px] text-zinc-400">{label}</p>
    </div>
  );
}

export default function AttackDetail({
  episode: e,
  doses,
  onEdit,
  onClose,
}: {
  episode: Episode;
  doses: MedDose[];
  onEdit: () => void;
  onClose: () => void;
}) {
  const t = attackTimes(e);
  const verdict = verdictLabel(e);
  const regions = parseRegions(e.pain_regions);
  const side = deriveSide(regions);
  const relieved = doses.filter((d) => d.relief_at).length;
  const symptoms = [
    ...(e.quality ? [e.quality === "throbbing" ? "Throbbing" : "Pressing"] : []),
    ...SYMPTOMS.filter((s) => e[s.key] === 1).map((s) => s.yes),
  ];

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/60 sm:items-center sm:p-6" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-zinc-900 px-5 pb-5 pt-5 sm:rounded-3xl"
        onClick={(ev) => ev.stopPropagation()}
        role="dialog"
        aria-label={`Attack on ${dayShort(e.started_at)}`}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-zinc-700 sm:hidden" aria-hidden />
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-zinc-100">{dayShort(e.started_at)}</h3>
            <p className="text-sm tabular-nums text-zinc-400">{t.range}</p>
          </div>
          {verdict && (
            <span className={`rounded-full bg-zinc-800 px-3 py-1 text-xs ${verdict.tone}`}>{verdict.text}</span>
          )}
        </div>

        <div className="mt-4 flex gap-2">
          <Stat value={t.duration ?? t.end} label="duration" />
          <Stat value={e.severity !== null ? `${e.severity}/${SEVERITY_MAX}` : "not set"} label="at its worst" />
          <Stat
            value={doses.length === 0 ? "none" : String(doses.length)}
            label={doses.length === 0 ? "medication" : `${doses.length === 1 ? "dose" : "doses"}, ${relieved} helped`}
          />
        </div>

        {t.endState === "ended" && (
          <div className="mt-5">
            <p className="mb-1 text-xs uppercase tracking-wide text-zinc-400">Timeline</p>
            <Timeline e={e} doses={doses} />
          </div>
        )}

        {(regions.length > 0 || symptoms.length > 0) && (
          <div className="mt-5">
            <p className="mb-2 text-xs uppercase tracking-wide text-zinc-400">
              Where and how it hurt
              {side && <span className="normal-case tracking-normal text-zinc-500"> · {side === "one" ? "one-sided" : "both sides"}</span>}
            </p>
            {regions.length > 0 && (
              <HeadHeatMap counts={Object.fromEntries(regions.map((r) => [r, 1]))} />
            )}
            {symptoms.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {symptoms.map((s) => (
                  <span key={s} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300">
                    {s}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {e.note && (
          <blockquote className="mt-5 border-l-2 border-zinc-700 pl-3 text-sm italic text-zinc-300">
            {e.note}
          </blockquote>
        )}

        <div className="mt-6 flex gap-3">
          <button onClick={onClose} className="min-h-11 flex-1 rounded-xl bg-zinc-800 text-sm text-zinc-300">
            Close
          </button>
          <button onClick={onEdit} className="min-h-11 flex-1 rounded-xl bg-accent-500 text-sm font-medium text-white">
            Edit
          </button>
        </div>
      </div>
    </div>
  );
}
