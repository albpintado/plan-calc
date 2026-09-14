import { distance, polygonArea } from './measure.js';

export const SPACE_TYPES = [
  { value: 'medicion', label: 'Measurement', room: false },
  { value: 'salon', label: 'Living room', room: true },
  { value: 'dormitorio', label: 'Bedroom', room: true },
  { value: 'cocina', label: 'Kitchen', room: true },
  { value: 'bano', label: 'Bathroom', room: true },
  { value: 'pasillo', label: 'Hallway', room: true },
  { value: 'terraza', label: 'Terrace', room: true },
  { value: 'garaje', label: 'Garage', room: true },
  { value: 'otro', label: 'Other', room: true },
];

export const WALL_TYPES = [
  { value: 'tabique', label: 'Partition', thickness: 90 },
  { value: 'carga', label: 'Load-bearing', thickness: 240 },
  { value: 'exterior', label: 'Exterior', thickness: 300 },
  { value: 'otro', label: 'Other', thickness: 100 },
];

export const OPENING_TYPES = [
  { value: 'puerta', label: 'Door' },
  { value: 'ventana', label: 'Window' },
  { value: 'otro', label: 'Other' },
];

export function spaceType(value) {
  return SPACE_TYPES.find((type) => type.value === value) || SPACE_TYPES[0];
}

export function wallType(value) {
  return WALL_TYPES.find((type) => type.value === value) || WALL_TYPES[0];
}

export function openingType(value) {
  return OPENING_TYPES.find((type) => type.value === value) || OPENING_TYPES[0];
}

export function isRoom(value) {
  return spaceType(value || 'medicion').room === true;
}

function sumBy(items, key, value) {
  const map = new Map();
  for (const item of items) {
    map.set(item[key], (map.get(item[key]) || 0) + value(item));
  }
  return map;
}

export function computeQuantities(state) {
  const pxPerMeter = state.calibration?.pxPerMeter || 0;
  const calibrated = pxPerMeter > 0;
  const meters = (px) => (calibrated ? px / pxPerMeter : 0);
  const squareMeters = (px2) => (calibrated ? px2 / (pxPerMeter * pxPerMeter) : 0);

  const spaces = (state.areas || []).map((area) => {
    const type = area.type || 'medicion';
    return {
      id: area.id,
      name: area.name || '',
      type,
      room: isRoom(type),
      area: squareMeters(polygonArea(area.points)),
    };
  });
  const measuredArea = spaces.reduce((sum, space) => sum + space.area, 0);
  const usefulArea = spaces
    .filter((space) => space.room)
    .reduce((sum, space) => sum + space.area, 0);
  const roomsByType = sumBy(
    spaces.filter((space) => space.room),
    'type',
    (space) => space.area,
  );

  const walls = (state.walls || []).map((wall) => {
    const length = meters(distance(wall.a, wall.b));
    const thickness = (wall.thickness || 0) / 1000;
    return { id: wall.id, type: wall.type || 'tabique', length, thickness, area: length * thickness };
  });
  const wallLength = walls.reduce((sum, wall) => sum + wall.length, 0);
  const wallArea = walls.reduce((sum, wall) => sum + wall.area, 0);
  const wallsByType = new Map();
  for (const wall of walls) {
    const entry = wallsByType.get(wall.type) || { length: 0, area: 0 };
    entry.length += wall.length;
    entry.area += wall.area;
    wallsByType.set(wall.type, entry);
  }

  const columns = (state.columns || []).map((column) => {
    const width = meters(column.w || 0);
    const height = meters(column.h || 0);
    return { id: column.id, width, height, area: width * height };
  });
  const columnArea = columns.reduce((sum, column) => sum + column.area, 0);

  const openings = (state.openings || []).map((opening) => ({
    id: opening.id,
    type: opening.type || 'puerta',
    width: meters(distance(opening.a, opening.b)),
  }));
  const openingWidth = openings.reduce((sum, opening) => sum + opening.width, 0);
  const openingsByType = new Map();
  for (const opening of openings) {
    const entry = openingsByType.get(opening.type) || { count: 0, width: 0 };
    entry.count += 1;
    entry.width += opening.width;
    openingsByType.set(opening.type, entry);
  }

  return {
    calibrated,
    measuredArea,
    usefulArea,
    wallArea,
    columnArea,
    builtArea: usefulArea + wallArea + columnArea,
    wallLength,
    openingCount: openings.length,
    openingWidth,
    columnCount: columns.length,
    spaces,
    walls,
    openings,
    columns,
    roomsByType,
    wallsByType,
    openingsByType,
  };
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function quantitiesToRows(quantities) {
  const rows = [['Category', 'Item', 'Value', 'Unit']];
  const add = (category, item, value, unit) => rows.push([category, item, value, unit]);

  if (!quantities.calibrated) {
    add('Summary', 'Calibration', 'not set', '');
  }
  add('Summary', 'Useful area', round(quantities.usefulArea), 'm2');
  add('Summary', 'Wall footprint', round(quantities.wallArea), 'm2');
  add('Summary', 'Column footprint', round(quantities.columnArea), 'm2');
  add('Summary', 'Built area (estimated)', round(quantities.builtArea), 'm2');
  add('Summary', 'Measured area (all polygons)', round(quantities.measuredArea), 'm2');
  add('Summary', 'Wall length', round(quantities.wallLength), 'm');
  add('Summary', 'Openings', quantities.openingCount, 'count');
  add('Summary', 'Columns', quantities.columnCount, 'count');

  for (const space of quantities.spaces) {
    add('Spaces', space.name || `Space ${space.id}`, round(space.area), 'm2');
  }
  for (const [type, area] of quantities.roomsByType) {
    add('Rooms by type', spaceType(type).label, round(area), 'm2');
  }
  for (const wall of quantities.walls) {
    add('Walls', wallType(wall.type).label, round(wall.length), 'm');
  }
  for (const [type, entry] of quantities.wallsByType) {
    add('Walls by type', wallType(type).label, round(entry.length), 'm');
  }
  for (const [type, entry] of quantities.openingsByType) {
    add('Openings by type', openingType(type).label, entry.count, `count (${round(entry.width)} m)`);
  }
  for (const column of quantities.columns) {
    add('Columns', `Column ${column.id}`, round(column.area), 'm2');
  }
  return rows;
}

export function toCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((field) => {
          const text = String(field ?? '');
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(','),
    )
    .join('\n');
}
