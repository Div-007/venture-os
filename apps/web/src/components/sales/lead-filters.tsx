"use client";
import { useEffect, useMemo, useState } from "react";
import type { LeadFacets } from "@venture-studio/contracts";
import { getLeadFacets } from "@/lib/sales-api";
import { FacetPicker, type FacetOption } from "@/components/sales/lead-facet-picker";

/** The filters the facets count with (everything the list takes except sorting and paging). */
export type FacetFilters = { ventureId?: string; pipelineId?: string; stage?: string; q?: string; owner?: "me"; needsYou?: "true"; playId?: string; offerId?: string; verdict?: "recommend" | "hold" | "reject" | "none"; region?: string; city?: string; category?: string; contact?: "phone" | "email" | "whatsapp" | "none" };
export const CONTACT_FILTERS = [["phone", "Has phone"], ["email", "Has email"], ["whatsapp", "WhatsApp open"], ["none", "No contact yet"]] as const;
export type ContactFilter = (typeof CONTACT_FILTERS)[number][0];
export const isContactFilter = (value: string | null): value is ContactFilter => CONTACT_FILTERS.some(([key]) => key === value);

/**
 * Counts for the filter choices, reloaded whenever a filter (or `refreshKey`) changes. The last counts stay on screen while new ones load,
 * so the dropdowns never blink empty. A failure just leaves the counts off; the filters still work.
 */
export function useLeadFacets(filters: FacetFilters, refreshKey = 0): { facets: LeadFacets | null; loading: boolean } {
  const key = JSON.stringify(filters);
  const [state, setState] = useState<{ key: string; facets: LeadFacets | null } | null>(null);
  useEffect(() => {
    let active = true;
    getLeadFacets(JSON.parse(key) as FacetFilters).then((facets) => { if (active) setState({ key, facets }); }).catch(() => { if (active) setState((previous) => ({ key, facets: previous?.facets ?? null })); });
    return () => { active = false; };
  }, [key, refreshKey]);
  return { facets: state?.facets ?? null, loading: state?.key !== key };
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Options for the State picker: most leads first, "Not set" apart. The chosen value stays listed even when other filters leave it with none. */
export function regionOptions(facets: LeadFacets | null, chosen: string): FacetOption[] {
  const options = (facets?.regions ?? []).map(({ value, count }) => ({ value, label: value, count }));
  if (chosen && chosen !== "none" && !options.some((option) => sameText(option.value, chosen))) options.push({ value: chosen, label: chosen, count: 0 });
  return options;
}
/** Options for the City picker. With no state chosen each city carries its state as a hint. */
export function cityOptions(facets: LeadFacets | null, chosen: string, regionChosen: boolean): FacetOption[] {
  const options = (facets?.cities ?? []).map(({ value, count, region }) => ({ value, label: value, count, ...(region && !regionChosen ? { hint: region } : {}) }));
  if (chosen && chosen !== "none" && !options.some((option) => sameText(option.value, chosen))) options.push({ value: chosen, label: chosen, count: 0 });
  return options;
}
export function categoryOptions(facets: LeadFacets | null, chosen: string): FacetOption[] {
  const options = (facets?.categories ?? []).map(({ value, count }) => ({ value, label: value, count }));
  if (chosen && chosen !== "none" && !options.some((option) => sameText(option.value, chosen))) options.push({ value: chosen, label: chosen, count: 0 });
  return options;
}
/** Options for the Offer picker (value = the offer id). The chosen offer stays listed, by the name `names` knows, when other filters leave it with none. */
export function offerOptions(facets: LeadFacets | null, chosen: string, names: Record<string, string>): FacetOption[] {
  const options = (facets?.offers ?? []).map(({ value, name, count }) => ({ value, label: name || names[value] || "Offer", count }));
  if (chosen && chosen !== "none" && !options.some((option) => option.value === chosen)) options.push({ value: chosen, label: names[chosen] ?? "This offer", count: 0 });
  return options;
}
/** An Offer filter only helps when there is a choice: two offers or more, some leads without one, or one already picked. */
export const offerFilterUseful = (facets: LeadFacets | null, chosen: string) => !!chosen || (!!facets && (facets.offers.length > 1 || (facets.offers.length > 0 && facets.notSet.offers > 0)));

/** The state a city sits in (its most common one), if the counts know it. */
export const regionOfCity = (facets: LeadFacets | null, city: string) => facets?.cities.find((item) => sameText(item.value, city))?.region;
export const incompatibleCity = (facets: LeadFacets | null, city: string, nextRegion: string) => {
  if (!city || !nextRegion || nextRegion === "none") return false;
  const where = regionOfCity(facets, city);
  return !!where && !sameText(where, nextRegion);
};

/** State and City: the pair used on both Leads and Pipeline. Picking a state clears a city that is not in it. */
export function PlaceFilters({ facets, region, city, onChange, variant = "pill" }: { facets: LeadFacets | null; region: string; city: string; onChange: (next: { state: string | null; city: string | null }) => void; variant?: "pill" | "field" }) {
  const regions = useMemo(() => regionOptions(facets, region), [facets, region]);
  const cities = useMemo(() => cityOptions(facets, city, !!region), [facets, city, region]);
  const labelled = (label: string, picker: React.ReactNode) => variant === "field" ? <div className="grid gap-1.5"><span className="text-xs font-semibold text-neutral-600">{label}</span>{picker}</div> : picker;
  return <>
    {labelled("State", <FacetPicker variant={variant} label="State" allLabel="All states" value={region} options={regions} notSet={facets ? { count: facets.notSet.regions, label: "Not set" } : undefined} onChange={(next) => onChange({ state: next || null, city: next && incompatibleCity(facets, city, next) ? null : city || null })} />)}
    {labelled("City", <FacetPicker variant={variant} label="City" allLabel={region && region !== "none" ? `All cities in ${region}` : "All cities"} value={city} options={cities} searchable notSet={facets ? { count: facets.notSet.cities, label: "Not set" } : undefined} onChange={(next) => onChange({ state: region || null, city: next || null })} />)}
  </>;
}
