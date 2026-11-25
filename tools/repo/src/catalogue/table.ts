export interface Cell {
  start: number;
  end: number;
  text: string;
}

export interface CatalogueRow {
  id: string;
  file: string;
  section: string;
  line: number;
  requirement: string;
  test: string;
  testIds: string;
}

export interface CatalogueTable {
  file: string;
  headerLine: number;
  columns: string[];
  testIdsColumn: number;
  rows: CatalogueRow[];
}

const ROW_ID = /^(?:(?:[a-z]+-)+\d{3}|P-\d{2})$/;
const SEPARATOR = /^\|[\s:|-]+\|$/;

export function splitCells(line: string): Cell[] {
  const cells: Cell[] = [];
  let start = -1;
  let inCode = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '\\') {
      index++;
    } else if (char === '`') {
      inCode = !inCode;
    } else if (char === '|' && !inCode) {
      if (start >= 0) cells.push({ start, end: index, text: line.slice(start, index).trim() });
      start = index + 1;
    }
  }
  return cells;
}

export function sectionSlug(heading: string): string {
  return (
    heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'general'
  );
}

export function parseTables(file: string, text: string): CatalogueTable[] {
  const lines = text.split('\n');
  const tables: CatalogueTable[] = [];
  let section = '';
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (line.startsWith('## ')) {
      section = line.slice(3).trim();
      continue;
    }
    const next = lines[index + 1] ?? '';
    if (!line.startsWith('|') || !SEPARATOR.test(next)) continue;
    const columns = splitCells(line).map((cell) => cell.text);
    if (columns[0] !== 'ID' && columns[0] !== '#') continue;
    const rows: CatalogueRow[] = [];
    let cursor = index + 2;
    for (; cursor < lines.length && (lines[cursor] ?? '').startsWith('|'); cursor++) {
      const cells = splitCells(lines[cursor] ?? '');
      if (cells.length !== columns.length) {
        throw new Error(
          `${file}:${cursor + 1}: ${cells.length} cells, header has ${columns.length}`,
        );
      }
      const cell = (name: string): string => cells[columns.indexOf(name)]?.text ?? '';
      const id = cells[0]?.text ?? '';
      if (!ROW_ID.test(id)) throw new Error(`${file}:${cursor + 1}: "${id}" is not a row id`);
      rows.push({
        id,
        file,
        section,
        line: cursor + 1,
        requirement: cell('Requirement'),
        test: cell('Test'),
        testIds: cell('Test ids'),
      });
    }
    tables.push({
      file,
      headerLine: index,
      columns,
      testIdsColumn: columns.indexOf('Test ids'),
      rows,
    });
    index = cursor - 1;
  }
  return tables;
}

export function writeTestIds(text: string, edits: ReadonlyMap<string, string>): string {
  const lines = text.split('\n');
  for (const table of parseTables('', text)) {
    const value = (id: string): string => edits.get(id) ?? '';
    if (table.testIdsColumn < 0) {
      const at = table.headerLine;
      lines[at] = `${(lines[at] ?? '').trimEnd()} Test ids |`;
      lines[at + 1] = `${(lines[at + 1] ?? '').trimEnd()} --- |`;
      for (const row of table.rows) {
        const rowText = (lines[row.line - 1] ?? '').trimEnd();
        lines[row.line - 1] = `${rowText} ${value(row.id)} |`;
      }
      continue;
    }
    for (const row of table.rows) {
      const wanted = edits.get(row.id);
      if (wanted === undefined || wanted === row.testIds) continue;
      const line = lines[row.line - 1] ?? '';
      const cell = splitCells(line)[table.testIdsColumn];
      if (!cell) continue;
      lines[row.line - 1] = `${line.slice(0, cell.start)} ${wanted} ${line.slice(cell.end)}`;
    }
  }
  return lines.join('\n');
}
