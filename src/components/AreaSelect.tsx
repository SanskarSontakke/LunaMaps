'use client';
import type { ChangeEvent } from 'react';
import type { ViewKind, ViewRegion } from '@/lib/viewRegions';

/**
 * The D11 area picker: choose one of the 61 browsable areas and the map draws its
 * outline, tints its interior and frames the camera on it.
 *
 * A native `<select>` with one `<optgroup>` per kind, because that is what a
 * `<select>` is for: 61 named areas is too many to scan as a list and too few to
 * need a search box, and the browser's own grouped picker already does the
 * type-ahead, the keyboard and the announcement. It sits at the top of the
 * sidebar, above the filters, rather than in its own floating panel — the left
 * column is the places column, and a second control there would be a second place
 * to look for the same thing.
 *
 * Deliberately NOT the "Region (IAU quadrangle)" dropdown in `FilterPanel`: that
 * one partitions 1,585 names by atlas sheet and gates the list, this one selects
 * an area on the map. Two controls meaning two things is only a defect if they
 * share a name.
 */
export const AREA_SELECT_ID = 'moon-area-select';

/** Display order, most structural first: the halves and caps before the maria. */
export const KIND_ORDER: readonly ViewKind[] = [
  'polar-cap',
  'hemisphere',
  'oceanus',
  'mare',
  'sinus',
  'lacus',
  'planitia',
];

/** Plural headings, because every kind in the shipped file has more than one member. */
export const KIND_LABELS: Record<ViewKind, string> = {
  'polar-cap': 'Polar caps',
  hemisphere: 'Hemispheres',
  oceanus: 'Oceanus',
  mare: 'Maria',
  sinus: 'Sinus',
  lacus: 'Lacūs',
  planitia: 'Planitiae',
};

export interface AreaGroup {
  kind: ViewKind;
  label: string;
  areas: ViewRegion[];
}

/**
 * Group by kind, in `KIND_ORDER`, dropping kinds with no members.
 *
 * The order list is checked against `VIEW_KINDS` by
 * `src/test/areaOutline.test.ts` rather than trusted: a kind the emitter adds and
 * this list does not know would otherwise vanish from the control silently, which
 * is the failure mode where a user cannot select an area that exists.
 */
export function groupAreas(areas: readonly ViewRegion[]): AreaGroup[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    label: KIND_LABELS[kind],
    areas: areas.filter((a) => a.kind === kind),
  })).filter((group) => group.areas.length > 0);
}

export interface AreaSelectProps {
  areas: readonly ViewRegion[];
  selectedId: string | null;
  onChoose: (id: string | null) => void;
}

function AreaSelect({ areas, selectedId, onChoose }: AreaSelectProps) {
  const groups = groupAreas(areas);
  const selected = areas.find((a) => a.id === selectedId) ?? null;
  const onChange = (e: ChangeEvent<HTMLSelectElement>) =>
    onChoose(e.target.value === '' ? null : e.target.value);
  return (
    <div className="filter-group area-select-group">
      <label className="filter-field" htmlFor={AREA_SELECT_ID}>
        Area
        <select id={AREA_SELECT_ID} value={selectedId ?? ''} onChange={onChange}>
          <option value="">No area selected</option>
          {groups.map((group) => (
            <optgroup key={group.kind} label={group.label}>
              {group.areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <p className="filter-hint" data-area-copy>
        {selected
          ? `${selected.name} — ${selected.boxes.length} ${
              selected.boxes.length === 1 ? 'box' : 'boxes'
            }, outlined on the map and framed. Nothing here promises deep tiles.`
          : 'Select an area to mark it on the map. These are browsing areas, not bake regions: naming one asks for no tiles.'}
      </p>
    </div>
  );
}

export default AreaSelect;
